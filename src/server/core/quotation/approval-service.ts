import { TRPCError } from "@trpc/server";
import type { ApprovalRequest } from "@prisma/client";
import { db } from "@/lib/db";
import { createApprovalRequest, decideApprovalRequest } from "@/server/core/approvals/service";
import { resolveStepEligibility } from "@/server/core/approvals/eligibility";
import type { ApprovalStepDef } from "@/server/core/approvals/types";
import { writeAuditLog } from "@/server/core/audit/audit";
import { emit } from "@/server/core/events/emit";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";
import { checkQuotationTransition } from "@/server/core/quotation/quotation-lifecycle";
import { quotationDisplayNumber } from "@/server/core/quotation/quotation-number";
import { QUOTATION_ENTITY_TYPE, type ActorMeta } from "@/server/core/quotation/quotation-service";
import { resolveApprovalFallback, workingHoursBetween } from "@/server/core/rbac/approval-fallback";
import type { AuthedUser } from "@/server/core/rbac/types";

/**
 * Quotation approval (specs/02-quotation.md §6).
 *
 * §6 opens with the confirmed rule and immediately says how not to build it:
 *
 *   "the Vice President approves every quotation, regardless of value or margin. Implement it
 *   through the generic approvals service with a single seeded rule — approver `vice_president`,
 *   no conditions — **rather than by hard-coding 'VP approves'**. The threshold machinery from the
 *   service stays in place, unused, so that when AIES grows to the point where the VP cannot
 *   review everything, turning on value bands is a settings change and not a rewrite."
 *
 * So there is no `if (total > x)` anywhere in this file, and no role name in a conditional. The one
 * step below carries `approvalRuleKey`, and everything about *who* decides — the VP, the President
 * as automatic fallback after 24 working hours, who may act immediately, whether a decision counts
 * as a fallback — comes from module 00's `ApprovalRule` row and its resolver. Adding value bands
 * later means adding a `condition` to the step, which is data.
 *
 * **This lands with no migration.** `Quotation` already carries `approvedById`, `approvedAt`,
 * `decisionAt` and `rejectionReason`, and the submission time that the escalation window counts
 * from is `ApprovalRequest.requestedAt` — the request row is the record of the submission, so
 * duplicating it on the quotation would create two truths that can disagree.
 */

export const QUOTATION_APPROVAL_RULE_KEY = "quotation.approve";
export const QUOTATION_APPROVAL_WORKFLOW_NAME = "Quotation approval";

export const QUOTATION_APPROVAL_REQUESTED_NOTIFICATION_TYPE = "quotation.approval_requested";
export const QUOTATION_APPROVAL_DECIDED_NOTIFICATION_TYPE = "quotation.approval_decided";

registerNotificationType({
  key: QUOTATION_APPROVAL_REQUESTED_NOTIFICATION_TYPE,
  label: "A quotation is waiting for your approval",
  // In-app only while `notify_email` has no handler (docs/DECISIONS.md #10). This is near the front
  // of the queue for email once a provider exists: the 24-working-hour escalation clock starts the
  // moment this fires, and the person it runs against is the one who may not open the app today.
  defaultChannels: { inApp: true, email: false, digest: false },
});

registerNotificationType({
  key: QUOTATION_APPROVAL_DECIDED_NOTIFICATION_TYPE,
  label: "Your quotation was approved or sent back",
  defaultChannels: { inApp: true, email: false, digest: false },
});

/**
 * §6's workflow: one step, no conditions.
 *
 * `approvalRuleKey` rather than `requiredRole: "vice_president"`. Both would route to the VP today;
 * only this one picks up Spec.md §4.4's fallback, and only this one can be retuned from the
 * `ApprovalRule` row without a deploy.
 */
export function quotationApprovalSteps(): ApprovalStepDef[] {
  return [
    {
      name: "Vice President",
      approvalRuleKey: QUOTATION_APPROVAL_RULE_KEY,
      // "parallel" means one eligible decision resolves the step — the VP or, after the window, the
      // President. Not "several approvers must all agree". Same vocabulary as
      // ApprovalRule.escalationMode, which is why §4.4's "first decision wins" needs nothing extra.
      mode: "parallel",
    },
  ];
}

/**
 * The workflow row, created on first use.
 *
 * Called by `prisma/seed.ts` so a fresh database has it, and by the submit path so an existing
 * database does not need a reseed to gain a feature. Both go through this one function, so the
 * workflow cannot exist in two shapes.
 *
 * Matched on entityType + name rather than a unique constraint, because `ApprovalWorkflow` has
 * none: module 00 designed it for several workflows per entity type (a second one for, say,
 * high-value quotations under a different rule). Adding a unique index now would foreclose that.
 */
export async function ensureQuotationApprovalWorkflow() {
  const existing = await db.approvalWorkflow.findFirst({
    where: {
      entityType: QUOTATION_ENTITY_TYPE,
      name: QUOTATION_APPROVAL_WORKFLOW_NAME,
      isActive: true,
    },
  });
  if (existing) return existing;

  return db.approvalWorkflow.create({
    data: {
      entityType: QUOTATION_ENTITY_TYPE,
      name: QUOTATION_APPROVAL_WORKFLOW_NAME,
      steps: quotationApprovalSteps() as unknown as object[],
      isActive: true,
    },
  });
}

/** The open request for a quotation, if there is one. */
export function findPendingApprovalRequest(quotationId: string) {
  return db.approvalRequest.findFirst({
    where: { entityType: QUOTATION_ENTITY_TYPE, entityId: quotationId, status: "pending" },
    orderBy: { requestedAt: "desc" },
  });
}

async function usersHoldingRoles(roleKeys: readonly string[]): Promise<{ id: string }[]> {
  if (roleKeys.length === 0) return [];
  return db.user.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      roles: { some: { role: { key: { in: [...roleKeys] } } } },
    },
    select: { id: true },
  });
}

// ---- submission ---------------------------------------------------------------------------------

/**
 * Sends a draft to the VP.
 *
 * The margin goes into `entitySnapshot` even though no step reads it today. §6 keeps the threshold
 * machinery "in place, unused" for the day value bands are switched on — and a condition can only
 * be evaluated against fields that were captured *at request time*, so a snapshot that omits them
 * would make turning bands on a migration rather than a settings change. It is also the honest
 * record of what the approver was asked to approve, which a later edit cannot rewrite.
 */
export async function submitQuotationForApprovalService(
  actor: ActorMeta,
  input: { quotationId: string },
) {
  const quotation = await db.quotation.findFirst({
    where: { id: input.quotationId, deletedAt: null },
    include: { account: { select: { name: true } }, _count: { select: { lines: true } } },
  });
  if (!quotation) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That quotation no longer exists." });
  }

  const check = checkQuotationTransition(quotation.status, "pending_approval");
  if (!check.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: check.reason! });
  }

  // A quotation with no lines has no price, so there is nothing to approve — and it would reach the
  // VP as a zero-total row in their queue, which reads as a bug in the queue rather than a mistake
  // in the quotation.
  if (quotation._count.lines === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${quotation.number} has no line items yet, so there is nothing to approve.`,
    });
  }

  const workflow = await ensureQuotationApprovalWorkflow();
  const label = quotationDisplayNumber(quotation.number, quotation.revision);

  const request = await createApprovalRequest({
    entityType: QUOTATION_ENTITY_TYPE,
    entityId: quotation.id,
    workflowId: workflow.id,
    requestedById: actor.actorId,
    entitySnapshot: {
      number: label,
      customer: quotation.account.name,
      currency: quotation.currency,
      total: Number(quotation.total),
      totalCost: Number(quotation.totalCost),
      marginAmount: Number(quotation.marginAmount),
      marginPct: Number(quotation.marginPct),
    },
  });

  await db.$transaction(async (tx) => {
    await tx.quotation.update({
      where: { id: quotation.id },
      data: { status: "pending_approval", version: { increment: 1 } },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "submitted_for_approval",
      entityType: QUOTATION_ENTITY_TYPE,
      entityId: quotation.id,
      summary: `Submitted ${label} for approval`,
      diff: { status: { from: quotation.status, to: "pending_approval" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "quotation.submitted_for_approval",
      {
        quotationId: quotation.id,
        number: quotation.number,
        revision: quotation.revision,
        approvalRequestId: request.id,
        total: quotation.total.toString(),
      },
      { actorId: actor.actorId, requestId: actor.requestId },
    );
  });

  await notifyApprovers(request, quotation.id, label, quotation.account.name);

  return { status: "pending_approval" as const, approvalRequestId: request.id };
}

/**
 * Tells whoever the request is currently sitting with.
 *
 * The recipients come from the resolver's `inboxRoles`, not from a hard-coded "vice_president" —
 * which means that on the day the rule's roles change, the notification follows without this file
 * being touched. At submission the window has not elapsed, so this is the VP alone; the President
 * finds it in their queue when the window passes, which is what the queue screen is for.
 */
async function notifyApprovers(
  request: ApprovalRequest,
  quotationId: string,
  label: string,
  customerName: string,
): Promise<void> {
  try {
    const rule = await db.approvalRule.findUnique({
      where: { key: QUOTATION_APPROVAL_RULE_KEY },
    });
    if (!rule) return;

    const { inboxRoles, fallbackAvailableAt } = resolveApprovalFallback(rule, request.requestedAt);
    const recipients = await usersHoldingRoles(inboxRoles);

    for (const recipient of recipients) {
      await notify({
        recipientId: recipient.id,
        type: QUOTATION_APPROVAL_REQUESTED_NOTIFICATION_TYPE,
        title: `${label} needs your approval — ${customerName}`,
        body:
          `Nothing can be issued to the customer until this is approved. If it is still ` +
          `undecided by ${fallbackAvailableAt.toISOString().slice(0, 10)} it also appears in the ` +
          `President's queue, and either of you may decide it.`,
        entityType: QUOTATION_ENTITY_TYPE,
        entityId: quotationId,
      });
    }
  } catch (error) {
    // Non-fatal, like every other notification here: the request exists and the queue shows it
    // whether or not the notification was delivered. Losing the submission over a notification
    // would be the worse trade.
    console.error("[quotation] failed to notify approvers", error);
  }
}

// ---- the decision -------------------------------------------------------------------------------

export interface DecideQuotationInput {
  quotationId: string;
  decision: "approved" | "rejected";
  comment?: string | null;
}

/**
 * The VP's (or, after the window, the President's) decision.
 *
 * Eligibility is **not** re-implemented here. `decideApprovalRequest` resolves it from the rule and
 * refuses anyone who does not qualify, and it is also what stamps `isFallback`. This service's job
 * is the quotation-shaped consequences: the status move, the audit row, the event, and telling the
 * person who submitted it.
 */
export async function decideQuotationApprovalService(
  actor: ActorMeta,
  approver: AuthedUser,
  input: DecideQuotationInput,
) {
  const quotation = await db.quotation.findFirst({
    where: { id: input.quotationId, deletedAt: null },
    select: {
      id: true,
      number: true,
      revision: true,
      status: true,
      preparedById: true,
      account: { select: { name: true } },
    },
  });
  if (!quotation) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That quotation no longer exists." });
  }
  if (quotation.status !== "pending_approval") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${quotation.number} is ${quotation.status.replace(/_/g, " ")}, not awaiting approval. ` +
        `Somebody may have decided it already.`,
    });
  }

  const comment = input.comment?.trim() ?? "";
  // §6: "Rejection returns the quote to draft with a mandatory comment." Required because the
  // comment *is* the instruction — a quotation sent back with no reason is a quotation the preparer
  // will resubmit unchanged.
  if (input.decision === "rejected" && comment.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Say what needs to change. A rejection with no comment cannot be acted on.",
    });
  }

  const request = await findPendingApprovalRequest(quotation.id);
  if (!request) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${quotation.number} has no open approval request.`,
    });
  }

  let decided;
  try {
    decided = await decideApprovalRequest({
      requestId: request.id,
      approver,
      decision: input.decision,
      comment: comment || undefined,
    });
  } catch (error) {
    // The engine is framework-free and throws plain Errors; ineligibility is a 403, not a 500.
    throw new TRPCError({
      code: "FORBIDDEN",
      message: error instanceof Error ? error.message : "That approval could not be decided.",
    });
  }

  const action = await db.approvalAction.findFirst({
    where: { requestId: request.id },
    orderBy: { at: "desc" },
  });
  const isFallback = action?.isFallback ?? false;
  // Spec.md §4.4: a fallback approval is recorded with "approver, that it was a fallback, and the
  // elapsed time". Derived from the two stored timestamps rather than stored a third time, and
  // written into the audit summary so the permanent record carries it in words.
  const elapsedHours = workingHoursBetween(request.requestedAt, action?.at ?? new Date());

  const label = quotationDisplayNumber(quotation.number, quotation.revision);
  const approved = input.decision === "approved";
  const now = new Date();

  await db.$transaction(async (tx) => {
    await tx.quotation.update({
      where: { id: quotation.id },
      data: approved
        ? {
            status: "approved",
            approvedById: approver.id,
            approvedAt: now,
            decisionAt: now,
            rejectionReason: null,
            version: { increment: 1 },
          }
        : {
            // §6: back to draft, not to some "rejected" limbo — the preparer's next act is editing.
            status: "draft",
            decisionAt: now,
            rejectionReason: comment,
            version: { increment: 1 },
          },
    });

    await writeAuditLog(tx, {
      actorId: approver.id,
      actorLabel: actor.actorLabel,
      action: approved ? "approved" : "rejected_internally",
      entityType: QUOTATION_ENTITY_TYPE,
      entityId: quotation.id,
      summary: approved
        ? `Approved ${label}` +
          (isFallback
            ? ` as fallback approver, ${elapsedHours.toFixed(1)} working hours after submission`
            : "")
        : `Sent ${label} back to draft — ${comment}`,
      diff: { status: { from: "pending_approval", to: approved ? "approved" : "draft" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      approved ? "quotation.approved" : "quotation.rejected_internally",
      {
        quotationId: quotation.id,
        number: quotation.number,
        revision: quotation.revision,
        approvalRequestId: request.id,
        decidedById: approver.id,
        isFallback,
        ...(approved ? {} : { comment }),
      },
      { actorId: approver.id, requestId: actor.requestId },
    );
  });

  try {
    await notify({
      recipientId: quotation.preparedById,
      type: QUOTATION_APPROVAL_DECIDED_NOTIFICATION_TYPE,
      title: approved
        ? `${label} is approved — you can issue it`
        : `${label} was sent back to draft`,
      body: approved
        ? `${actor.actorLabel} approved it${isFallback ? " as fallback approver" : ""}. ` +
          `Download the PDF and confirm the send when it goes.`
        : `${actor.actorLabel}: ${comment}`,
      entityType: QUOTATION_ENTITY_TYPE,
      entityId: quotation.id,
    });
  } catch (error) {
    console.error("[quotation] failed to notify the preparer of an approval decision", error);
  }

  return {
    status: decided.status,
    quotationStatus: approved ? ("approved" as const) : ("draft" as const),
    isFallback,
    elapsedWorkingHours: Number(elapsedHours.toFixed(2)),
  };
}

// ---- the queue ----------------------------------------------------------------------------------

export interface ApprovalQueueRow {
  quotationId: string;
  approvalRequestId: string;
  displayNumber: string;
  title: string;
  customer: string;
  currency: string;
  total: string;
  /** Present only when the caller holds `finance.view_cost` — Spec.md §4.3, like everywhere else. */
  marginPct?: string;
  marginAmount?: string;
  requestedAt: Date;
  /** Working hours since submission, which is the age the escalation window is measured in. */
  ageWorkingHours: number;
  /** True once the President may also decide it. */
  isEscalated: boolean;
  fallbackAvailableAt: Date;
  /** True when *this* caller would be deciding as the fallback approver. */
  wouldBeFallback: boolean;
  preparedById: string;
}

/**
 * §6: "The approval queue is a first-class screen for the VP: every quote awaiting them, with
 * total, margin, customer, and age, approvable in sequence without opening each one."
 *
 * Every field that sentence names is here, so the screen is a rendering job with no second
 * round-trip per row — which is what "approvable in sequence" actually requires.
 *
 * Not built on `listMyApprovalInbox`. That returns bare `ApprovalRequest` rows across every entity
 * type and would still leave this to join quotations, re-resolve the rule for the fallback state,
 * and compute the age — so it would be one more layer to keep in step, not one less thing to write.
 */
export async function listQuotationApprovalQueueService(
  user: AuthedUser,
  now: Date = new Date(),
): Promise<ApprovalQueueRow[]> {
  const requests = await db.approvalRequest.findMany({
    where: { entityType: QUOTATION_ENTITY_TYPE, status: "pending" },
    include: { workflow: true },
    orderBy: { requestedAt: "asc" },
  });
  if (requests.length === 0) return [];

  const quotations = await db.quotation.findMany({
    where: { id: { in: requests.map((r) => r.entityId) }, deletedAt: null },
    select: {
      id: true,
      number: true,
      revision: true,
      title: true,
      currency: true,
      total: true,
      marginPct: true,
      marginAmount: true,
      preparedById: true,
      status: true,
      account: { select: { name: true } },
    },
  });
  const byId = new Map(quotations.map((q) => [q.id, q]));
  const canSeeCost = user.permissions.has("finance.view_cost");

  const rule = await db.approvalRule.findUnique({ where: { key: QUOTATION_APPROVAL_RULE_KEY } });
  const rows: ApprovalQueueRow[] = [];

  for (const request of requests) {
    const quotation = byId.get(request.entityId);
    // A pending request whose quotation was deleted, or which the record no longer agrees with.
    // Skipped rather than shown: an approve button that cannot work is worse than an absent row.
    if (!quotation || quotation.status !== "pending_approval") continue;

    const steps = request.workflow.steps as unknown as ApprovalStepDef[];
    const step = steps[request.currentStep];
    if (!step) continue;

    const eligibility = await resolveStepEligibility(step, request.requestedAt, now);
    if (!eligibility.isInInbox(user)) continue;

    const fallback = rule
      ? resolveApprovalFallback(rule, request.requestedAt, now)
      : {
          elapsedHours: 0,
          isFallbackWindowElapsed: false,
          fallbackAvailableAt: request.requestedAt,
        };

    rows.push({
      quotationId: quotation.id,
      approvalRequestId: request.id,
      displayNumber: quotationDisplayNumber(quotation.number, quotation.revision),
      title: quotation.title,
      customer: quotation.account.name,
      currency: quotation.currency,
      total: quotation.total.toString(),
      ...(canSeeCost
        ? {
            marginPct: quotation.marginPct.toString(),
            marginAmount: quotation.marginAmount.toString(),
          }
        : {}),
      requestedAt: request.requestedAt,
      ageWorkingHours: Number(fallback.elapsedHours.toFixed(1)),
      isEscalated: fallback.isFallbackWindowElapsed,
      fallbackAvailableAt: fallback.fallbackAvailableAt,
      wouldBeFallback: eligibility.isFallbackDecision(user),
      preparedById: quotation.preparedById,
    });
  }

  return rows;
}

/** What the record page needs to show the approval state and the right button. */
export async function getQuotationApprovalStateService(
  user: AuthedUser,
  quotationId: string,
  now: Date = new Date(),
) {
  const requests = await db.approvalRequest.findMany({
    where: { entityType: QUOTATION_ENTITY_TYPE, entityId: quotationId },
    include: { actions: { orderBy: { at: "asc" } }, workflow: true },
    orderBy: { requestedAt: "desc" },
  });

  const pending = requests.find((r) => r.status === "pending") ?? null;
  let canDecide = false;
  let wouldBeFallback = false;
  let fallbackAvailableAt: Date | null = null;

  if (pending) {
    const steps = pending.workflow.steps as unknown as ApprovalStepDef[];
    const step = steps[pending.currentStep];
    if (step) {
      const eligibility = await resolveStepEligibility(step, pending.requestedAt, now);
      canDecide = eligibility.isEligibleToDecide(user);
      wouldBeFallback = eligibility.isFallbackDecision(user);
    }
    const rule = await db.approvalRule.findUnique({ where: { key: QUOTATION_APPROVAL_RULE_KEY } });
    if (rule) {
      fallbackAvailableAt = resolveApprovalFallback(
        rule,
        pending.requestedAt,
        now,
      ).fallbackAvailableAt;
    }
  }

  const actorIds = [
    ...new Set(requests.flatMap((r) => [r.requestedById, ...r.actions.map((a) => a.approverId)])),
  ];
  const users = await db.user.findMany({
    where: { id: { in: actorIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(users.map((u) => [u.id, u.name]));

  return {
    pendingRequestId: pending?.id ?? null,
    canDecide,
    wouldBeFallback,
    fallbackAvailableAt,
    history: requests.map((request) => ({
      id: request.id,
      status: request.status,
      requestedAt: request.requestedAt,
      requestedByLabel: nameById.get(request.requestedById) ?? request.requestedById,
      actions: request.actions.map((action) => ({
        id: action.id,
        decision: action.decision,
        comment: action.comment,
        isFallback: action.isFallback,
        at: action.at,
        approverLabel: nameById.get(action.approverId) ?? action.approverId,
      })),
    })),
  };
}
