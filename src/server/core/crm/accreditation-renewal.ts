import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { createApprovalRequest, upsertApprovalWorkflow } from "@/server/core/approvals/service";
import type { ApprovalStepDef } from "@/server/core/approvals/types";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { assessAccreditation } from "@/server/core/crm/accreditation-rules";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";

/**
 * Accreditation renewal (specs/01-crm-inquiry.md §5b) as the company described it:
 *
 *   PD uploads the customer's certificate and types its expiry date. Thirty days before that date,
 *   PD is told to prepare the renewal. If the customer is blacklisted or dormant, the president (EA)
 *   must approve before the renewal work starts.
 *
 * The second rule is the interesting one. Renewing an accreditation with a blacklisted customer
 * means spending PD's time on a relationship the company has decided to stop — and dormant is the
 * same question with a softer answer. So it is a decision, not a checkbox, and it goes through
 * module 00's approvals engine rather than an `if` here.
 */

export const RENEWAL_NOTIFICATION_TYPE = "accreditation.renewal_due";
export const RENEWAL_STALLED_NOTIFICATION_TYPE = "accreditation.renewal_stalled";
export const RENEWAL_APPROVAL_ENTITY_TYPE = "AccreditationRenewal";
export const RENEWAL_WORKFLOW_NAME = "Accreditation renewal on a restricted account";

/**
 * §5b's reminder ladder. The company asked specifically for 30 days ("prepare for renewal"); the
 * spec asks for 90/60/30. Both are honoured by keeping all three — 90 and 60 are early heads-up,
 * 30 is the one that means start work now. Accreditation paperwork in the Philippines routinely
 * takes longer than a month, so a single 30-day warning is genuinely tight.
 */
export const RENEWAL_THRESHOLD_DAYS = [90, 60, 30] as const;

/**
 * Days *after* PD acknowledges, at which an unfinished renewal is escalated to the president (EA)
 * and vice-president (KJ).
 *
 * Read as elapsed time, so they fire in ascending order — 30 days after acknowledging is the first
 * escalation, 60 the most serious. The company wrote "60/45/30"; the same three numbers either way,
 * and escalation that gets louder as the deadline nears is the only reading that makes operational
 * sense.
 */
export const RENEWAL_STALL_DAYS = [30, 45, 60] as const;

const DAY_MS = 86_400_000;

registerNotificationType({
  key: RENEWAL_NOTIFICATION_TYPE,
  label: "Customer accreditation is due for renewal",
  // In-app only, and deliberately so — not because email is unwired.
  //
  // The renewal itself is done on the *customer's* portal, not here. This notification exists to
  // tell PD to go and do that, and to make the status visible in one place; an email would be a
  // second copy of a reminder whose action lives somewhere else entirely. It would also enqueue a
  // `notify_email` job on a queue that has no handler by design (docs/DECISIONS.md #10), so every
  // reminder would dead-letter — filling the dead-letter queue with work nobody ever wants and
  // burying the failures that do matter.
  defaultChannels: { inApp: true, email: false, digest: false },
  // No coalescing: each threshold is a distinct instruction ("heads up" vs "start now"), and
  // collapsing 60 into 30 would lose the escalation. Duplicate suppression is handled instead by
  // only firing on the day a threshold is crossed — see sweepAccreditationRenewals.
});

registerNotificationType({
  key: RENEWAL_STALLED_NOTIFICATION_TYPE,
  label: "An acknowledged accreditation renewal is still not completed",
  // In-app only, for the same reason as the reminder above: the work happens on the customer's
  // portal, and this is about visibility of who owes what.
  defaultChannels: { inApp: true, email: false, digest: false },
});

/** The account states that make a renewal a decision rather than routine work. */
export function isRestrictedForRenewal(accountStatus: string): boolean {
  return accountStatus === "blacklisted" || accountStatus === "dormant";
}

/**
 * The approval workflow, created on demand and idempotently.
 *
 * One conditional step rather than two workflows: when the condition does not apply,
 * `createApprovalRequest` finds no applicable step and resolves the request as approved
 * immediately, so an unrestricted renewal needs no special case at the call site.
 *
 * The condition is numeric because `ApprovalCondition.value` is a number and `evaluateCondition`
 * rejects non-numeric snapshot fields — it was built for §7.4's `total > 500000`. So the snapshot
 * carries `accountRestricted` as 1/0 for the engine to test, alongside the human-readable
 * `accountStatus` string for whoever reads the approval. Extending the condition language to
 * support string equality would be a module 00 change, and this needs no such thing.
 */
export async function ensureRenewalWorkflow(): Promise<string> {
  const steps: ApprovalStepDef[] = [
    {
      name: "President approval — customer is blacklisted or dormant",
      // §4.3: the president holds the decisive approvals. Not the fallback resolver: this is not a
      // time-boxed escalation, it is a judgement only EA should make.
      requiredRole: "president",
      condition: { field: "accountRestricted", operator: "==", value: 1 },
      mode: "parallel",
    },
  ];

  const existing = await db.approvalWorkflow.findFirst({
    where: { entityType: RENEWAL_APPROVAL_ENTITY_TYPE, name: RENEWAL_WORKFLOW_NAME },
    select: { id: true },
  });
  const workflow = await upsertApprovalWorkflow({
    id: existing?.id,
    entityType: RENEWAL_APPROVAL_ENTITY_TYPE,
    name: RENEWAL_WORKFLOW_NAME,
    steps,
  });
  return workflow.id;
}

export interface AcknowledgeRenewalResult {
  /** True when PD's acknowledgement was recorded and the clock has started. */
  acknowledged: boolean;
  /** Set when approval is required first. */
  approvalRequestId?: string;
  accountStatus: string;
}

/**
 * PD acknowledging that this renewal is now one of their tasks — or asking EA first.
 *
 * Acknowledgement is a commitment with a deadline attached, not a status flip: it starts the clock
 * that `sweepStalledRenewals` measures, and it names the person the escalation will be about. That
 * is why it is a separate field from `status`, which can sit in `renewal_due` forever with nobody
 * having picked it up.
 *
 * Deliberately does not touch `expiresAt` or the certificate. A renewal is not complete until the
 * customer issues a *new* certificate, at which point PD uploads it and types the new date — and
 * that is exactly what stops the escalation.
 */
export async function acknowledgeRenewalService(
  actor: ActorMeta,
  input: { accreditationId: string },
): Promise<AcknowledgeRenewalResult> {
  const record = await db.accreditationRecord.findFirst({
    where: { id: input.accreditationId, deletedAt: null },
    include: { account: { select: { id: true, code: true, name: true, status: true } } },
  });
  if (!record) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That accreditation no longer exists." });
  }

  const restricted = isRestrictedForRenewal(record.account.status);
  const workflowId = await ensureRenewalWorkflow();

  const request = await createApprovalRequest({
    entityType: RENEWAL_APPROVAL_ENTITY_TYPE,
    entityId: record.id,
    workflowId,
    requestedById: actor.actorId,
    entitySnapshot: {
      // Numeric mirror for the engine's condition; see ensureRenewalWorkflow.
      accountRestricted: restricted ? 1 : 0,
      // Human-readable context for whoever opens the approval.
      accountStatus: record.account.status,
      accountCode: record.account.code,
      accountName: record.account.name,
      currentExpiresAt: record.expiresAt?.toISOString() ?? null,
    },
  });

  // No applicable step means the engine approved it on creation — an unrestricted customer.
  const acknowledged = request.status === "approved";

  if (acknowledged) {
    await db.$transaction(async (tx) => {
      await tx.accreditationRecord.update({
        where: { id: record.id },
        data: {
          status: "preparing",
          renewalAcknowledgedAt: new Date(),
          // Recorded separately from ownerId: the escalation is about who took the task on, and
          // the record's owner can be reassigned afterwards.
          renewalAcknowledgedBy: actor.actorId,
        },
      });
      await writeAuditLog(tx, {
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        action: "renewal_acknowledged",
        entityType: "AccreditationRecord",
        entityId: record.id,
        summary: `Acknowledged accreditation renewal for ${record.account.code} — ${record.account.name}`,
        ip: actor.ip,
        userAgent: actor.userAgent,
        requestId: actor.requestId,
      });
    });
  } else {
    await db.$transaction(async (tx) => {
      await writeAuditLog(tx, {
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        action: "renewal_approval_requested",
        entityType: "AccreditationRecord",
        entityId: record.id,
        summary:
          `Renewal of ${record.account.code} — ${record.account.name} needs president approval ` +
          `(account is ${record.account.status})`,
        diff: { accountStatus: { from: null, to: record.account.status } },
        ip: actor.ip,
        userAgent: actor.userAgent,
        requestId: actor.requestId,
      });
    });
  }

  return {
    acknowledged,
    approvalRequestId: acknowledged ? undefined : request.id,
    accountStatus: record.account.status,
  };
}

/**
 * Whether a renewal counts as done.
 *
 * "Done" means the customer issued a *new* certificate after PD acknowledged, and it has a future
 * expiry. Checking only that a certificate exists would call every acknowledged renewal complete
 * the moment it started, since the old certificate is still attached.
 */
export function completesRenewal(
  record: {
    renewalAcknowledgedAt: Date | null;
    certificateUploadedAt: Date | null;
    expiresAt: Date | null;
  },
  now: Date = new Date(),
): boolean {
  if (!record.renewalAcknowledgedAt) return false;
  if (!record.certificateUploadedAt || !record.expiresAt) return false;
  return (
    record.certificateUploadedAt > record.renewalAcknowledgedAt &&
    record.expiresAt.getTime() > now.getTime()
  );
}

export interface StalledSweepResult {
  escalated: { accreditationId: string; accountCode: string; daysSinceAcknowledged: number }[];
  cleared: string[];
  scanned: number;
}

/**
 * Escalates acknowledged renewals that are still not finished, to the president and vice-president.
 *
 * Recipients are resolved by *role*, not by hardcoded user id: EA and KJ hold president and
 * vice-president today, and a system that names them directly quietly stops working the day
 * somebody changes job.
 *
 * Also clears the acknowledgement on renewals that did complete, so a finished renewal stops being
 * escalated without anyone having to remember to tick it off — the new certificate is the tick.
 */
export async function sweepStalledRenewals(now: Date = new Date()): Promise<StalledSweepResult> {
  const acknowledged = await db.accreditationRecord.findMany({
    where: { deletedAt: null, renewalAcknowledgedAt: { not: null } },
    include: { account: { select: { code: true, name: true } } },
  });

  const escalated: StalledSweepResult["escalated"] = [];
  const cleared: string[] = [];

  // Resolved once for the whole sweep rather than per record.
  const escalationRecipients = await db.user.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      roles: { some: { role: { key: { in: ["president", "vice_president"] } } } },
    },
    select: { id: true },
  });

  for (const record of acknowledged) {
    if (!record.renewalAcknowledgedAt) continue;

    if (completesRenewal(record, now)) {
      await db.accreditationRecord.update({
        where: { id: record.id },
        data: { renewalAcknowledgedAt: null, renewalAcknowledgedBy: null },
      });
      cleared.push(record.id);
      continue;
    }

    const startOfDay = (d: Date) => Math.floor(d.getTime() / DAY_MS);
    const elapsed = startOfDay(now) - startOfDay(record.renewalAcknowledgedAt);
    const threshold = RENEWAL_STALL_DAYS.find((t) => t === elapsed);
    if (threshold === undefined) continue;

    for (const recipient of escalationRecipients) {
      await notify({
        recipientId: recipient.id,
        type: RENEWAL_STALLED_NOTIFICATION_TYPE,
        title: `Accreditation renewal still open after ${threshold} days — ${record.account.name}`,
        body:
          `Acknowledged ${record.renewalAcknowledgedAt.toISOString().slice(0, 10)}, ` +
          `but no new certificate and expiry date have been recorded yet.`,
        entityType: "AccreditationRecord",
        entityId: record.id,
      });
    }

    escalated.push({
      accreditationId: record.id,
      accountCode: record.account.code,
      daysSinceAcknowledged: threshold,
    });
  }

  return { escalated, cleared, scanned: acknowledged.length };
}

export interface RenewalSweepResult {
  notified: { accreditationId: string; accountCode: string; thresholdDays: number }[];
  scanned: number;
}

/**
 * The nightly sweep. Notifies the accreditation's owner (PD) when the certificate's expiry crosses
 * a threshold.
 *
 * Fires only on the *exact* day a threshold is crossed rather than every day inside the window.
 * Daily repeats are how people learn to ignore a notification, and the badge on the account
 * already answers "is there a problem?" continuously — this exists to interrupt someone once, at
 * each escalation.
 *
 * Reads the record's own `expiresAt`, which is the certificate date PD typed. Individual document
 * expiries are surfaced on the account badge by `assessAccreditation`; a separate ladder for each
 * of a dozen documents would be noise.
 */
export async function sweepAccreditationRenewals(
  now: Date = new Date(),
): Promise<RenewalSweepResult> {
  const maxDays = Math.max(...RENEWAL_THRESHOLD_DAYS);

  const candidates = await db.accreditationRecord.findMany({
    where: {
      deletedAt: null,
      expiresAt: { not: null, lte: new Date(now.getTime() + maxDays * DAY_MS) },
      // Terminal states need no reminder: rejected is a decision, and expired has already been
      // escalated by the badge — a reminder to renew something that lapsed is not actionable.
      status: { notIn: ["rejected", "not_started"] },
    },
    include: { account: { select: { code: true, name: true, status: true } } },
  });

  const notified: RenewalSweepResult["notified"] = [];

  for (const record of candidates) {
    if (!record.expiresAt) continue;

    // Whole days between today and expiry, both floored to midnight UTC so the comparison does not
    // depend on what time the job happens to run.
    const startOfDay = (d: Date) => Math.floor(d.getTime() / DAY_MS);
    const daysRemaining = startOfDay(record.expiresAt) - startOfDay(now);

    const threshold = RENEWAL_THRESHOLD_DAYS.find((t) => t === daysRemaining);
    if (threshold === undefined) continue;

    const health = assessAccreditation(record, now);
    const restricted = isRestrictedForRenewal(record.account.status);

    await notify({
      recipientId: record.ownerId,
      type: RENEWAL_NOTIFICATION_TYPE,
      title:
        threshold === 30
          ? `Prepare renewal: ${record.account.name} accreditation expires in 30 days`
          : `${record.account.name} accreditation expires in ${threshold} days`,
      body: [
        `Certificate expires ${record.expiresAt.toISOString().slice(0, 10)}.`,
        health.missingDocuments.length > 0
          ? `Outstanding documents: ${health.missingDocuments.join(", ")}.`
          : null,
        // Told at reminder time, not discovered at renewal time — the approval is a dependency on
        // someone else's calendar.
        restricted
          ? `This account is ${record.account.status}, so the president must approve the renewal before work starts.`
          : null,
      ]
        .filter(Boolean)
        .join(" "),
      entityType: "AccreditationRecord",
      entityId: record.id,
    });

    notified.push({
      accreditationId: record.id,
      accountCode: record.account.code,
      thresholdDays: threshold,
    });
  }

  return { notified, scanned: candidates.length };
}
