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
export const RENEWAL_APPROVAL_ENTITY_TYPE = "AccreditationRenewal";
export const RENEWAL_WORKFLOW_NAME = "Accreditation renewal on a restricted account";

/**
 * §5b's reminder ladder. The company asked specifically for 30 days ("prepare for renewal"); the
 * spec asks for 90/60/30. Both are honoured by keeping all three — 90 and 60 are early heads-up,
 * 30 is the one that means start work now. Accreditation paperwork in the Philippines routinely
 * takes longer than a month, so a single 30-day warning is genuinely tight.
 */
export const RENEWAL_THRESHOLD_DAYS = [90, 60, 30] as const;

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

export interface StartRenewalResult {
  /** True when renewal work may begin now. */
  commenced: boolean;
  /** Set when approval is required first. */
  approvalRequestId?: string;
  accountStatus: string;
}

/**
 * Begins a renewal, or asks EA first.
 *
 * Deliberately does not touch `expiresAt` or the certificate: a renewal is not complete until the
 * customer issues a *new* certificate, at which point PD uploads it and types the new date. This
 * only moves the record into renewal preparation.
 */
export async function startAccreditationRenewalService(
  actor: ActorMeta,
  input: { accreditationId: string },
): Promise<StartRenewalResult> {
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
  const commenced = request.status === "approved";

  if (commenced) {
    await db.$transaction(async (tx) => {
      await tx.accreditationRecord.update({
        where: { id: record.id },
        data: { status: "preparing" },
      });
      await writeAuditLog(tx, {
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        action: "renewal_started",
        entityType: "AccreditationRecord",
        entityId: record.id,
        summary: `Started accreditation renewal for ${record.account.code} — ${record.account.name}`,
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
    commenced,
    approvalRequestId: commenced ? undefined : request.id,
    accountStatus: record.account.status,
  };
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
