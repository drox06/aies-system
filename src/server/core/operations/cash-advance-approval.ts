import { TRPCError } from "@trpc/server";
import type { ApprovalRequest } from "@prisma/client";
import { db } from "@/lib/db";
import { createApprovalRequest } from "@/server/core/approvals/service";
import type { ApprovalStepDef } from "@/server/core/approvals/types";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";
import { resolveApprovalFallback } from "@/server/core/rbac/approval-fallback";
import {
  CASH_ADVANCE_APPROVAL_RULE,
  CASH_ADVANCE_ENTITY_TYPE,
  CASH_ADVANCE_EXTENSION_RULE,
} from "./cash-advance-rules";

/**
 * Cash advance approval (specs/04-operations-projects.md §5).
 *
 * §5 is unusually specific about the routing, and the two sentences pull in opposite directions:
 *
 *  - "**The Vice President approves every advance, at any amount.** No thresholds in v1."
 *  - "**Automatic fallback to the President after 4 working hours** (Spec.md §4.4) — the shortest
 *    window of any approval type, because a crew is standing by."
 *
 * So: one step, no conditions, exactly like quotations and supplier POs — and a rule row whose
 * escalation window is a quarter of everyone else's. The window lives on the `ApprovalRule`, seeded
 * by module 00 at 4 hours, and is counted in *working* hours (docs/DECISIONS.md #29). A request
 * filed at 4pm on a Friday reaches the President on Monday morning, not over the weekend — which is
 * right, because nobody is releasing cash on a Sunday either.
 *
 * Extensions route through their own rule at 24 hours. §5 puts the approval of an extension with
 * the same officer but it is not the same decision: one is "should this crew have money", the other
 * is "may this person owe us paperwork for longer", and nobody is standing by for the second.
 */

export const CASH_ADVANCE_APPROVAL_WORKFLOW_NAME = "Cash advance approval";
export const CASH_ADVANCE_EXTENSION_WORKFLOW_NAME = "Cash advance extension approval";
/** The extension request is an approval over the same entity, so it needs its own entity type. */
export const CASH_ADVANCE_EXTENSION_ENTITY_TYPE = "CashAdvanceExtension";

export const CASH_ADVANCE_APPROVAL_REQUESTED_NOTIFICATION_TYPE = "cash_advance.approval_requested";
export const CASH_ADVANCE_APPROVAL_DECIDED_NOTIFICATION_TYPE = "cash_advance.approval_decided";
export const CASH_ADVANCE_RELEASED_NOTIFICATION_TYPE = "cash_advance.released";
export const CASH_ADVANCE_LIQUIDATION_DUE_NOTIFICATION_TYPE = "cash_advance.liquidation_due";

registerNotificationType({
  key: CASH_ADVANCE_APPROVAL_REQUESTED_NOTIFICATION_TYPE,
  label: "A cash advance is waiting for your approval",
  // Email is off like every other type in this build — module 05 owns the transport. The 4-hour
  // window is short enough that the in-app bell plus the fallback is the mechanism, not a reminder.
  defaultChannels: { inApp: true, email: false, digest: false },
});

registerNotificationType({
  key: CASH_ADVANCE_APPROVAL_DECIDED_NOTIFICATION_TYPE,
  label: "Your cash advance was approved or declined",
  defaultChannels: { inApp: true, email: false, digest: false },
});

registerNotificationType({
  key: CASH_ADVANCE_RELEASED_NOTIFICATION_TYPE,
  label: "A cash advance you requested has been released",
  defaultChannels: { inApp: true, email: false, digest: false },
});

registerNotificationType({
  key: CASH_ADVANCE_LIQUIDATION_DUE_NOTIFICATION_TYPE,
  label: "A cash advance liquidation is overdue",
  defaultChannels: { inApp: true, email: false, digest: false },
});

export function cashAdvanceApprovalSteps(): ApprovalStepDef[] {
  return [
    { name: "Vice President", approvalRuleKey: CASH_ADVANCE_APPROVAL_RULE, mode: "parallel" },
  ];
}

export function cashAdvanceExtensionSteps(): ApprovalStepDef[] {
  return [
    { name: "Vice President", approvalRuleKey: CASH_ADVANCE_EXTENSION_RULE, mode: "parallel" },
  ];
}

/**
 * The rule rows, ensured on first use.
 *
 * prisma/seed.ts already creates both, and this exists for the same reason the supplier PO's does:
 * an existing database that has not been reseeded would otherwise fail inside
 * `resolveStepEligibility`'s `findUniqueOrThrow`, surfacing as a raw Prisma message on the approve
 * button. The values match seed.ts exactly — **including the 4** — because two places creating one
 * row differently is how an approval quietly gets the wrong escalation window.
 */
async function ensureRules() {
  await db.approvalRule.upsert({
    where: { key: CASH_ADVANCE_APPROVAL_RULE },
    update: {},
    create: {
      key: CASH_ADVANCE_APPROVAL_RULE,
      label: "Cash advance approval",
      primaryApproverRole: "vice_president",
      fallbackApproverRole: "president",
      escalateAfterHours: 4,
      escalationMode: "parallel",
    },
  });
  await db.approvalRule.upsert({
    where: { key: CASH_ADVANCE_EXTENSION_RULE },
    update: {},
    create: {
      key: CASH_ADVANCE_EXTENSION_RULE,
      label: "Cash advance liquidation extension approval",
      primaryApproverRole: "vice_president",
      fallbackApproverRole: "president",
      escalateAfterHours: 24,
      escalationMode: "parallel",
    },
  });
}

export async function ensureCashAdvanceWorkflow(kind: "advance" | "extension") {
  await ensureRules();

  const entityType =
    kind === "advance" ? CASH_ADVANCE_ENTITY_TYPE : CASH_ADVANCE_EXTENSION_ENTITY_TYPE;
  const name =
    kind === "advance" ? CASH_ADVANCE_APPROVAL_WORKFLOW_NAME : CASH_ADVANCE_EXTENSION_WORKFLOW_NAME;

  const existing = await db.approvalWorkflow.findFirst({
    where: { entityType, name, isActive: true },
  });
  if (existing) return existing;

  return db.approvalWorkflow.create({
    data: {
      entityType,
      name,
      steps: (kind === "advance"
        ? cashAdvanceApprovalSteps()
        : cashAdvanceExtensionSteps()) as unknown as object[],
      isActive: true,
    },
  });
}

export function findPendingCashAdvanceApproval(
  cashAdvanceId: string,
  kind: "advance" | "extension",
) {
  return db.approvalRequest.findFirst({
    where: {
      entityType:
        kind === "advance" ? CASH_ADVANCE_ENTITY_TYPE : CASH_ADVANCE_EXTENSION_ENTITY_TYPE,
      entityId: cashAdvanceId,
      status: "pending",
    },
    orderBy: { requestedAt: "desc" },
  });
}

export async function openCashAdvanceApproval(input: {
  kind: "advance" | "extension";
  cashAdvanceId: string;
  requestedById: string;
  snapshot: Record<string, unknown>;
}): Promise<ApprovalRequest> {
  const existing = await findPendingCashAdvanceApproval(input.cashAdvanceId, input.kind);
  if (existing) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        input.kind === "advance"
          ? "This advance is already waiting for the Vice President."
          : "An extension request on this advance is already waiting for a decision.",
    });
  }

  const workflow = await ensureCashAdvanceWorkflow(input.kind);
  return createApprovalRequest({
    entityType:
      input.kind === "advance" ? CASH_ADVANCE_ENTITY_TYPE : CASH_ADVANCE_EXTENSION_ENTITY_TYPE,
    entityId: input.cashAdvanceId,
    workflowId: workflow.id,
    requestedById: input.requestedById,
    // §5 keeps "the threshold machinery available but unused", and a condition can only read fields
    // captured at request time. It is also the honest record of what the VP was shown — a later
    // edit cannot rewrite it.
    entitySnapshot: input.snapshot,
  });
}

/**
 * Tells whoever can decide that something is waiting.
 *
 * Best-effort: a notification failure must not roll back an approval request. The 4-hour fallback
 * is what actually guarantees the advance is seen, and it is resolved from the rule row at read
 * time rather than depending on this having succeeded.
 */
export async function notifyCashAdvanceApprovers(
  request: ApprovalRequest,
  ruleKey: string,
  title: string,
  body: string,
): Promise<void> {
  try {
    const rule = await db.approvalRule.findUnique({ where: { key: ruleKey } });
    if (!rule) return;

    const { inboxRoles } = resolveApprovalFallback(rule, request.requestedAt);
    if (inboxRoles.length === 0) return;

    const recipients = await db.user.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        roles: { some: { role: { key: { in: [...inboxRoles] } } } },
      },
      select: { id: true },
    });

    for (const recipient of recipients) {
      await notify({
        recipientId: recipient.id,
        type: CASH_ADVANCE_APPROVAL_REQUESTED_NOTIFICATION_TYPE,
        title,
        body,
        entityType: CASH_ADVANCE_ENTITY_TYPE,
        entityId: request.entityId,
      });
    }
  } catch {
    // Deliberately swallowed — see the doc comment.
  }
}
