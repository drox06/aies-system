import type { ApprovalRequest, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { emit } from "@/server/core/events/emit";
import type { AuthedUser } from "@/server/core/rbac/types";
import { resolveStepEligibility } from "./eligibility";
import { evaluateCondition, type ApprovalStepDef } from "./types";

/**
 * Only "parallel" (first eligible decision wins) is implemented — see docs/DECISIONS.md for why
 * "sequential" (require every eligible approver, not just one) is deferred: it needs an
 * enumerable approver set, which role/permission-based eligibility here is deliberately a
 * predicate over, not a list of. Enforced at workflow save time so an unsupported workflow can
 * never be created, rather than silently misbehaving at decide time.
 */
export function assertStepsSupported(steps: readonly ApprovalStepDef[]): void {
  for (const step of steps) {
    if (step.mode !== "parallel") {
      throw new Error(
        `Step "${step.name}": mode "${step.mode}" is not implemented yet — only "parallel" is.`,
      );
    }
    if (
      !step.requiredRole &&
      !step.requiredPermission &&
      !step.specificUserId &&
      !step.approvalRuleKey
    ) {
      throw new Error(
        `Step "${step.name}" has no eligibility rule (requiredRole/requiredPermission/specificUserId/approvalRuleKey).`,
      );
    }
  }
}

export function upsertApprovalWorkflow(input: {
  id?: string;
  entityType: string;
  name: string;
  steps: ApprovalStepDef[];
}) {
  assertStepsSupported(input.steps);
  const data = {
    entityType: input.entityType,
    name: input.name,
    steps: input.steps as unknown as Prisma.InputJsonValue,
    isActive: true,
  };

  return input.id
    ? db.approvalWorkflow.update({ where: { id: input.id }, data })
    : db.approvalWorkflow.create({ data });
}

export function findApplicableStepIndex(
  steps: readonly ApprovalStepDef[],
  snapshot: Record<string, unknown>,
  fromIndex: number,
): number | null {
  for (let i = fromIndex; i < steps.length; i++) {
    if (evaluateCondition(steps[i]!.condition, snapshot)) return i;
  }
  return null;
}

export interface CreateApprovalRequestInput {
  entityType: string;
  entityId: string;
  workflowId: string;
  requestedById: string;
  entitySnapshot: Record<string, unknown>;
}

export async function createApprovalRequest(
  input: CreateApprovalRequestInput,
): Promise<ApprovalRequest> {
  return db.$transaction(async (tx) => {
    const workflow = await tx.approvalWorkflow.findUniqueOrThrow({
      where: { id: input.workflowId },
    });
    const steps = workflow.steps as unknown as ApprovalStepDef[];
    const firstStep = findApplicableStepIndex(steps, input.entitySnapshot, 0);
    const resolvedImmediately = firstStep === null;

    const request = await tx.approvalRequest.create({
      data: {
        entityType: input.entityType,
        entityId: input.entityId,
        workflowId: input.workflowId,
        currentStep: firstStep ?? steps.length,
        status: resolvedImmediately ? "approved" : "pending",
        entitySnapshot: input.entitySnapshot as Prisma.InputJsonValue,
        requestedById: input.requestedById,
        decidedAt: resolvedImmediately ? new Date() : null,
      },
    });

    await emit(
      tx,
      "approval.requested",
      { requestId: request.id, entityType: input.entityType, entityId: input.entityId },
      { actorId: input.requestedById },
    );

    return request;
  });
}

export interface DecideApprovalRequestInput {
  requestId: string;
  approver: AuthedUser;
  decision: "approved" | "rejected";
  comment?: string;
  /**
   * Join the caller's transaction instead of opening one.
   *
   * ## Why this exists
   *
   * A decision is never only an engine fact. Approving a cash advance also sets the advance's own
   * status; approving a quotation also moves the quotation. Callers were doing the second in a
   * transaction of their own, *after* this one had already committed — two commits for one
   * decision, with a window between them.
   *
   * AIESCA-260127 fell into that window on 2026-08-18: the approval request went to `approved` at
   * 14:35:47 and the advance stayed `pending_approval`. Nothing could then act on it — approving
   * refused because no request was pending, re-submitting refused because it was no longer a draft.
   * A decision recorded against a record that could not receive it.
   *
   * Passing `tx` closes the window: the engine's decision and whatever it means for the business
   * record commit together or not at all.
   */
  tx?: Prisma.TransactionClient;
}

export async function decideApprovalRequest(
  input: DecideApprovalRequestInput,
): Promise<ApprovalRequest> {
  const run = async (tx: Prisma.TransactionClient): Promise<ApprovalRequest> => {
    const request = await tx.approvalRequest.findUniqueOrThrow({ where: { id: input.requestId } });
    if (request.status !== "pending") {
      throw new Error(`Approval request ${request.id} is already ${request.status}.`);
    }

    const workflow = await tx.approvalWorkflow.findUniqueOrThrow({
      where: { id: request.workflowId },
    });
    const steps = workflow.steps as unknown as ApprovalStepDef[];
    const step = steps[request.currentStep];
    if (!step) {
      throw new Error(
        `Approval request ${request.id} has no step at index ${request.currentStep}.`,
      );
    }

    const eligibility = await resolveStepEligibility(step, request.requestedAt);
    if (!eligibility.isEligibleToDecide(input.approver)) {
      throw new Error("You are not eligible to decide this approval step.");
    }

    await tx.approvalAction.create({
      data: {
        requestId: request.id,
        step: request.currentStep,
        approverId: input.approver.id,
        decision: input.decision,
        comment: input.comment,
        isFallback: eligibility.isFallbackDecision(input.approver),
      },
    });

    if (input.decision === "rejected") {
      const updated = await tx.approvalRequest.update({
        where: { id: request.id },
        data: { status: "rejected", decidedAt: new Date() },
      });
      await emit(
        tx,
        "approval.rejected",
        { requestId: request.id },
        { actorId: input.approver.id },
      );
      return updated;
    }

    const snapshot = request.entitySnapshot as Record<string, unknown>;
    const nextStep = findApplicableStepIndex(steps, snapshot, request.currentStep + 1);
    const isFullyApproved = nextStep === null;

    const updated = await tx.approvalRequest.update({
      where: { id: request.id },
      data: {
        currentStep: nextStep ?? steps.length,
        status: isFullyApproved ? "approved" : "pending",
        decidedAt: isFullyApproved ? new Date() : null,
      },
    });

    // specs/00-foundation.md §7.4 lists exactly three events: requested/approved/rejected.
    // Advancing to a later step without emitting anything is a deliberate, conservative reading
    // of that literal list — intermediate progress is visible via listMyApprovalInbox() (pulled
    // on demand), not pushed, until a real workflow with 2+ steps actually needs the extra event.
    if (isFullyApproved) {
      await emit(
        tx,
        "approval.approved",
        { requestId: request.id },
        { actorId: input.approver.id },
      );
    }

    return updated;
  };

  return input.tx ? run(input.tx) : db.$transaction(run);
}

export async function listMyApprovalInbox(user: AuthedUser): Promise<ApprovalRequest[]> {
  const pending = await db.approvalRequest.findMany({
    where: { status: "pending" },
    include: { workflow: true },
    orderBy: { requestedAt: "asc" },
  });

  const results: ApprovalRequest[] = [];
  for (const request of pending) {
    const steps = request.workflow.steps as unknown as ApprovalStepDef[];
    const step = steps[request.currentStep];
    if (!step) continue;

    const eligibility = await resolveStepEligibility(step, request.requestedAt);
    if (eligibility.isInInbox(user)) results.push(request);
  }

  return results;
}

export function listApprovalsForEntity(entityType: string, entityId: string) {
  return db.approvalRequest.findMany({
    where: { entityType, entityId },
    include: { actions: { orderBy: { at: "asc" } } },
    orderBy: { requestedAt: "desc" },
  });
}
