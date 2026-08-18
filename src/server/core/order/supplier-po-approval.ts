import { TRPCError } from "@trpc/server";
import type { ApprovalRequest } from "@prisma/client";
import { db } from "@/lib/db";
import { registerApprovalDecisionHandler } from "@/server/core/approvals/decision-registry";
import { createApprovalRequest, decideApprovalRequest } from "@/server/core/approvals/service";
import { resolveStepEligibility } from "@/server/core/approvals/eligibility";
import type { ApprovalStepDef } from "@/server/core/approvals/types";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";
import { resolveApprovalFallback, workingHoursBetween } from "@/server/core/rbac/approval-fallback";
import type { AuthedUser } from "@/server/core/rbac/types";
import { SUPPLIER_PO_ENTITY_TYPE } from "./supplier-po-rules";

/**
 * Supplier PO approval (specs/03-order-procurement.md §5).
 *
 * §5: "Approval workflow (generic service): the **Vice President approves supplier POs**, matching
 * quotation approval. The threshold machinery stays available but unused in v1."
 *
 * Which is the same sentence module 02 §6 gives for quotations, so this is deliberately the same
 * shape: one step, no conditions, routed by an `ApprovalRule` key rather than by a role name in a
 * conditional. There is no `if (total > x)` here and no `"vice_president"` in a branch — turning on
 * value bands later means adding a `condition` to the step, which is data.
 *
 * It is a **separate rule key** from the quotation's, though the two resolve to the same person
 * today. They are different decisions about different risks — one commits AIES to a price it will
 * charge, the other to money it will spend — and sharing a key would mean the day AIES routes
 * spending to a finance officer, quotation approval silently follows it.
 */

export const SUPPLIER_PO_APPROVAL_RULE_KEY = "supplier_po.approve";
export const SUPPLIER_PO_APPROVAL_WORKFLOW_NAME = "Supplier PO approval";

export const SUPPLIER_PO_APPROVAL_REQUESTED_NOTIFICATION_TYPE = "supplier_po.approval_requested";
export const SUPPLIER_PO_APPROVAL_DECIDED_NOTIFICATION_TYPE = "supplier_po.approval_decided";

registerNotificationType({
  key: SUPPLIER_PO_APPROVAL_REQUESTED_NOTIFICATION_TYPE,
  label: "A supplier PO is waiting for your approval",
  defaultChannels: { inApp: true, email: false, digest: false },
});

registerNotificationType({
  key: SUPPLIER_PO_APPROVAL_DECIDED_NOTIFICATION_TYPE,
  label: "Your supplier PO was approved or sent back",
  defaultChannels: { inApp: true, email: false, digest: false },
});

export function supplierPoApprovalSteps(): ApprovalStepDef[] {
  return [
    { name: "Vice President", approvalRuleKey: SUPPLIER_PO_APPROVAL_RULE_KEY, mode: "parallel" },
  ];
}

/**
 * The rule the step routes through, created on first use alongside the workflow.
 *
 * The quotation's equivalent relies on prisma/seed.ts alone, and that turned out to be a trap: an
 * existing database that has not been reseeded has the workflow but no rule, and
 * `resolveStepEligibility` calls `findUniqueOrThrow` on it — so the failure surfaces as a 403
 * carrying a raw Prisma message, on the approve button, for a reason that has nothing to do with
 * eligibility. Ensuring it here means the feature works on a database that predates it.
 *
 * The defaults match prisma/seed.ts exactly, and deliberately: two places that create the same row
 * differently is how an approval quietly routes to the wrong person.
 */
async function ensureSupplierPoApprovalRule() {
  return db.approvalRule.upsert({
    where: { key: SUPPLIER_PO_APPROVAL_RULE_KEY },
    update: {},
    create: {
      key: SUPPLIER_PO_APPROVAL_RULE_KEY,
      label: "Supplier PO approval",
      primaryApproverRole: "vice_president",
      fallbackApproverRole: "president",
      // Spec.md §4.4's window, in working hours (docs/DECISIONS.md #29).
      escalateAfterHours: 24,
      escalationMode: "parallel",
    },
  });
}

/**
 * The workflow row, created on first use.
 *
 * Called by the submit path as well as by prisma/seed.ts, so an existing database gains the feature
 * without a reseed and the workflow cannot come to exist in two shapes.
 */
export async function ensureSupplierPoApprovalWorkflow() {
  await ensureSupplierPoApprovalRule();

  const existing = await db.approvalWorkflow.findFirst({
    where: {
      entityType: SUPPLIER_PO_ENTITY_TYPE,
      name: SUPPLIER_PO_APPROVAL_WORKFLOW_NAME,
      isActive: true,
    },
  });
  if (existing) return existing;

  return db.approvalWorkflow.create({
    data: {
      entityType: SUPPLIER_PO_ENTITY_TYPE,
      name: SUPPLIER_PO_APPROVAL_WORKFLOW_NAME,
      steps: supplierPoApprovalSteps() as unknown as object[],
      isActive: true,
    },
  });
}

export function findPendingSupplierPoApproval(supplierPOId: string) {
  return db.approvalRequest.findFirst({
    where: { entityType: SUPPLIER_PO_ENTITY_TYPE, entityId: supplierPOId, status: "pending" },
    orderBy: { requestedAt: "desc" },
  });
}

export async function submitSupplierPoForApprovalService(
  actor: ActorMeta,
  input: { supplierPOId: string },
) {
  const po = await db.supplierPO.findFirst({
    where: { id: input.supplierPOId, deletedAt: null },
    include: {
      supplier: { select: { name: true, isApproved: true } },
      salesOrder: { select: { number: true, account: { select: { name: true } } } },
      _count: { select: { lines: true } },
    },
  });
  if (!po) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That supplier PO no longer exists." });
  }
  if (po.status !== "draft") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${po.number} is ${po.status.replace(/_/g, " ")}, not a draft.`,
    });
  }
  if (po._count.lines === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${po.number} has no lines, so there is nothing to approve.`,
    });
  }

  const workflow = await ensureSupplierPoApprovalWorkflow();
  const request = await createApprovalRequest({
    entityType: SUPPLIER_PO_ENTITY_TYPE,
    entityId: po.id,
    workflowId: workflow.id,
    requestedById: actor.actorId,
    // The snapshot carries what a value band would need, though no step reads it today — §5 keeps
    // "the threshold machinery available but unused", and a condition can only be evaluated against
    // fields captured at request time. It is also the honest record of what was approved, which a
    // later edit cannot rewrite.
    entitySnapshot: {
      number: po.number,
      supplier: po.supplier.name,
      supplierIsApproved: po.supplier.isApproved,
      currency: po.currency,
      total: Number(po.total),
      salesOrder: po.salesOrder?.number ?? null,
      customer: po.salesOrder?.account.name ?? null,
    },
  });

  await db.$transaction(async (tx) => {
    await tx.supplierPO.update({
      where: { id: po.id },
      data: { status: "pending_approval", version: { increment: 1 } },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "submitted_for_approval",
      entityType: SUPPLIER_PO_ENTITY_TYPE,
      entityId: po.id,
      summary: `Submitted ${po.number} to ${po.supplier.name} for approval — ${po.currency} ${po.total.toString()}`,
      diff: { status: { from: "draft", to: "pending_approval" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  await notifyApprovers(
    request,
    po.id,
    po.number,
    po.supplier.name,
    po.currency,
    po.total.toString(),
  );

  return { status: "pending_approval" as const, approvalRequestId: request.id };
}

async function notifyApprovers(
  request: ApprovalRequest,
  supplierPOId: string,
  number: string,
  supplierName: string,
  currency: string,
  total: string,
): Promise<void> {
  try {
    const rule = await db.approvalRule.findUnique({
      where: { key: SUPPLIER_PO_APPROVAL_RULE_KEY },
    });
    if (!rule) return;

    const { inboxRoles, fallbackAvailableAt } = resolveApprovalFallback(rule, request.requestedAt);
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
        type: SUPPLIER_PO_APPROVAL_REQUESTED_NOTIFICATION_TYPE,
        title: `${number} needs your approval — ${supplierName}`,
        body:
          `${currency} ${total} committed to a supplier. Nothing can be ordered until this is ` +
          `approved. If it is still undecided by ` +
          `${fallbackAvailableAt.toISOString().slice(0, 10)} the President can decide it too.`,
        entityType: SUPPLIER_PO_ENTITY_TYPE,
        entityId: supplierPOId,
      });
    }
  } catch (error) {
    // Non-fatal, like every other notification in this build: the request exists and the queue
    // shows it whether or not the notification was delivered.
    console.error("[supplier-po] failed to notify approvers", error);
  }
}

export async function decideSupplierPoApprovalService(
  actor: ActorMeta,
  approver: AuthedUser,
  input: { supplierPOId: string; decision: "approved" | "rejected"; comment?: string | null },
) {
  const po = await db.supplierPO.findFirst({
    where: { id: input.supplierPOId, deletedAt: null },
    include: { supplier: { select: { name: true } } },
  });
  if (!po) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That supplier PO no longer exists." });
  }
  if (po.status !== "pending_approval") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${po.number} is ${po.status.replace(/_/g, " ")}, not awaiting approval. Somebody may ` +
        `have decided it already.`,
    });
  }

  const comment = input.comment?.trim() ?? "";
  if (input.decision === "rejected" && comment.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Say what needs to change. A rejection with no comment cannot be acted on.",
    });
  }

  const request = await findPendingSupplierPoApproval(po.id);
  if (!request) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${po.number} has no open approval request.`,
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
  const elapsedHours = workingHoursBetween(request.requestedAt, action?.at ?? new Date());

  const approved = input.decision === "approved";
  const now = new Date();

  await db.$transaction(async (tx) => {
    await tx.supplierPO.update({
      where: { id: po.id },
      data: approved
        ? {
            status: "approved",
            approvedById: approver.id,
            approvedAt: now,
            version: { increment: 1 },
          }
        : // Back to draft, not to a "rejected" limbo — the next act is editing it.
          { status: "draft", version: { increment: 1 } },
    });

    await writeAuditLog(tx, {
      actorId: approver.id,
      actorLabel: actor.actorLabel,
      action: approved ? "approved" : "rejected_internally",
      entityType: SUPPLIER_PO_ENTITY_TYPE,
      entityId: po.id,
      summary: approved
        ? `Approved ${po.number} to ${po.supplier.name}` +
          (isFallback
            ? ` as fallback approver, ${elapsedHours.toFixed(1)} working hours after submission`
            : "")
        : `Sent ${po.number} back to draft — ${comment}`,
      diff: { status: { from: "pending_approval", to: approved ? "approved" : "draft" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    if (approved) {
      await emit(
        tx,
        "supplier_po.approved",
        {
          supplierPOId: po.id,
          number: po.number,
          supplierId: po.supplierId,
          decidedById: approver.id,
          isFallback,
        },
        { actorId: approver.id, requestId: actor.requestId },
      );
    }
  });

  try {
    await notify({
      recipientId: po.createdById,
      type: SUPPLIER_PO_APPROVAL_DECIDED_NOTIFICATION_TYPE,
      title: approved ? `${po.number} is approved — you can send it` : `${po.number} was sent back`,
      body: approved
        ? `${actor.actorLabel} approved it${isFallback ? " as fallback approver" : ""}. ` +
          `Download the PDF, send it to ${po.supplier.name}, and mark it sent.`
        : `${actor.actorLabel}: ${comment}`,
      entityType: SUPPLIER_PO_ENTITY_TYPE,
      entityId: po.id,
    });
  } catch (error) {
    console.error("[supplier-po] failed to notify the raiser of an approval decision", error);
  }

  return {
    status: decided.status,
    supplierPoStatus: approved ? ("approved" as const) : ("draft" as const),
    isFallback,
    elapsedWorkingHours: Number(elapsedHours.toFixed(2)),
  };
}

/** What the record page needs to show the approval state and the right button. */
export async function getSupplierPoApprovalStateService(
  user: AuthedUser,
  supplierPOId: string,
  now: Date = new Date(),
) {
  const requests = await db.approvalRequest.findMany({
    where: { entityType: SUPPLIER_PO_ENTITY_TYPE, entityId: supplierPOId },
    include: { actions: { orderBy: { at: "asc" } }, workflow: true },
    orderBy: { requestedAt: "desc" },
  });

  const pending = requests.find((r) => r.status === "pending") ?? null;
  let canDecide = false;
  let wouldBeFallback = false;

  if (pending) {
    const steps = pending.workflow.steps as unknown as ApprovalStepDef[];
    const step = steps[pending.currentStep];
    if (step) {
      const eligibility = await resolveStepEligibility(step, pending.requestedAt, now);
      canDecide = eligibility.isEligibleToDecide(user);
      wouldBeFallback = eligibility.isFallbackDecision(user);
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

/** The global inbox routes a supplier PO decision through this module's service. See #105. */
registerApprovalDecisionHandler(SUPPLIER_PO_ENTITY_TYPE, (context) =>
  decideSupplierPoApprovalService(context.actor, context.approver, {
    supplierPOId: context.entityId,
    decision: context.decision,
    comment: context.comment,
  }),
);
