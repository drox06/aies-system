import { TRPCError } from "@trpc/server";
import type { ApprovalRequest } from "@prisma/client";
import { db } from "@/lib/db";
import { createApprovalRequest, decideApprovalRequest } from "@/server/core/approvals/service";
import { registerApprovalDecisionHandler } from "@/server/core/approvals/decision-registry";
import type { ApprovalStepDef } from "@/server/core/approvals/types";
import { resolveApprovalFallback } from "@/server/core/rbac/approval-fallback";
import { writeAuditLog } from "@/server/core/audit/audit";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";
import type { ActorMeta } from "@/server/core/crm/account-service";
import type { AuthedUser } from "@/server/core/rbac/types";
import {
  assessInquiryCompleteness,
  INQUIRY_ENTITY_TYPE,
  transitionInquiryService,
} from "./inquiry-service";

/**
 * §4's requirements gate, waived — 2026-09-04: "if the inquiry did not call a request for site
 * inspection, the 9 gates should not hold it. it should be able to get handed to quotation. this
 * means that it is only a simple purchase and delivery. however, if this is the case, then pop a
 * prompt that asks if logging the requirements are really not necessary. if it was clicked yes then
 * ask approval to KJ or EA for this to push to quotation."
 *
 * The gate itself (`transitionInquiryService`'s `requiresCompleteRequirements` check) is untouched —
 * it still refuses `evaluating → quoting` unless `assessInquiryCompleteness` is satisfied. What is
 * new is a second way to satisfy it, narrower than the existing `overrideRequirementsService`: that
 * one is a standing `crm.edit` escape hatch for any inquiry, for any reason. This one only applies
 * when no `InspectionRequest` was ever raised for the inquiry — the company's own signal that the
 * job is "only a simple purchase and delivery" — and it is not self-service: it goes through the same
 * generic approval engine (module 00 §7.4) every other named-approver decision in this codebase uses,
 * routed to the Vice President (KJ) with the President (EA) as the immediate fallback — the same
 * primary/fallback pair every `ApprovalRule` in `prisma/seed.ts` already uses, and per
 * `resolveApprovalFallback`, both are eligible to decide from the moment the request is raised, not
 * after a delay: this is "KJ or EA", not "KJ, then EA if KJ is slow".
 *
 * Approval sets the *existing* `Inquiry.requirementsOverrideReason` — the same field the manual
 * override writes — so `transitionInquiryService`'s gate needs no changes to honor it, and then
 * performs the `evaluating → quoting` move itself, attributed to whoever decided it. That second step
 * runs after the approval decision's own transaction commits, not inside it: unlike a rejected engine
 * decision, an approved-but-not-yet-transitioned inquiry is never stranded — the override reason is
 * already on the record, so a plain "Hand to quotation" click (the ordinary, unrestricted mutation)
 * would succeed immediately on its own. This step only saves that second click.
 */

export const INQUIRY_QUOTING_WAIVER_ENTITY_TYPE = "InquiryQuotingWaiver";
export const INQUIRY_QUOTING_WAIVER_APPROVAL_RULE = "inquiry.quoting_waiver_approve";
const WORKFLOW_NAME = "Inquiry quoting waiver approval";

export const INQUIRY_QUOTING_WAIVER_REQUESTED_NOTIFICATION_TYPE =
  "inquiry.quoting_waiver_requested";
export const INQUIRY_QUOTING_WAIVER_DECIDED_NOTIFICATION_TYPE = "inquiry.quoting_waiver_decided";

registerNotificationType({
  key: INQUIRY_QUOTING_WAIVER_REQUESTED_NOTIFICATION_TYPE,
  label: "An inquiry wants to skip to quotation without a site inspection",
  defaultChannels: { inApp: true, email: false, digest: false },
});

registerNotificationType({
  key: INQUIRY_QUOTING_WAIVER_DECIDED_NOTIFICATION_TYPE,
  label: "Your requirements waiver was decided",
  defaultChannels: { inApp: true, email: false, digest: false },
});

function waiverSteps(): ApprovalStepDef[] {
  return [
    {
      name: "Vice President or President",
      approvalRuleKey: INQUIRY_QUOTING_WAIVER_APPROVAL_RULE,
      mode: "parallel",
    },
  ];
}

/**
 * The rule row, ensured on first use — same reason and the same shape as
 * `cash-advance-approval.ts`'s `ensureRules`: `prisma/seed.ts` already creates this, and an existing
 * database that has not been reseeded would otherwise fail inside `resolveStepEligibility` with a
 * raw Prisma error on the approve button.
 */
async function ensureRule() {
  await db.approvalRule.upsert({
    where: { key: INQUIRY_QUOTING_WAIVER_APPROVAL_RULE },
    update: {},
    create: {
      key: INQUIRY_QUOTING_WAIVER_APPROVAL_RULE,
      label: "Inquiry quoting waiver approval",
      primaryApproverRole: "vice_president",
      fallbackApproverRole: "president",
      escalateAfterHours: 24,
      escalationMode: "parallel",
    },
  });
}

async function ensureWorkflow() {
  await ensureRule();
  const existing = await db.approvalWorkflow.findFirst({
    where: { entityType: INQUIRY_QUOTING_WAIVER_ENTITY_TYPE, name: WORKFLOW_NAME, isActive: true },
  });
  if (existing) return existing;

  return db.approvalWorkflow.create({
    data: {
      entityType: INQUIRY_QUOTING_WAIVER_ENTITY_TYPE,
      name: WORKFLOW_NAME,
      steps: waiverSteps() as unknown as object[],
      isActive: true,
    },
  });
}

export function findPendingQuotingWaiver(inquiryId: string) {
  return db.approvalRequest.findFirst({
    where: {
      entityType: INQUIRY_QUOTING_WAIVER_ENTITY_TYPE,
      entityId: inquiryId,
      status: "pending",
    },
    orderBy: { requestedAt: "desc" },
  });
}

/**
 * Raised after the company's own confirm prompt — "are you sure logging the requirements really
 * isn't necessary?" — has already been answered yes. Refuses to open a second one at the same time,
 * refuses on an inquiry the requirements are already satisfied for (nothing to waive), and refuses on
 * an inquiry that has ever had a site inspection requested — that is the one condition the whole
 * waiver turns on.
 */
export async function requestQuotingWaiverService(
  actor: ActorMeta,
  input: { inquiryId: string },
): Promise<ApprovalRequest> {
  const inquiry = await db.inquiry.findFirst({
    where: { id: input.inquiryId, deletedAt: null },
    include: { items: { select: { serviceType: true } } },
  });
  if (!inquiry) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That inquiry no longer exists." });
  }

  if (inquiry.status !== "evaluating") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${inquiry.number} is ${inquiry.status} — a waiver only makes sense while it is being evaluated toward quoting.`,
    });
  }

  const completeness = await assessInquiryCompleteness(inquiry);
  if (completeness.satisfied) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${inquiry.number}'s requirements are already answered — there is nothing to waive.`,
    });
  }

  const everRequested = await db.inspectionRequest.findFirst({
    where: { inquiryId: inquiry.id, deletedAt: null },
    select: { id: true },
  });
  if (everRequested) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${inquiry.number} has a site inspection on it — answer the requirements from the survey, or use the standard override.`,
    });
  }

  const existing = await findPendingQuotingWaiver(inquiry.id);
  if (existing) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${inquiry.number} is already waiting on the Vice President or the President.`,
    });
  }

  const workflow = await ensureWorkflow();
  const missing = completeness.missing.map((m) => m.label).join(", ");

  const request = await createApprovalRequest({
    entityType: INQUIRY_QUOTING_WAIVER_ENTITY_TYPE,
    entityId: inquiry.id,
    workflowId: workflow.id,
    requestedById: actor.actorId,
    entitySnapshot: {
      number: inquiry.number,
      purpose: inquiry.subject,
      requestedBy: actor.actorLabel,
      reason: `No site inspection was requested — treated as a simple purchase and delivery. Missing: ${missing}.`,
    },
  });

  // Best-effort — the 24-hour fallback is what actually guarantees this is seen, resolved from the
  // rule row at read time, not dependent on this having succeeded.
  try {
    const rule = await db.approvalRule.findUnique({
      where: { key: INQUIRY_QUOTING_WAIVER_APPROVAL_RULE },
    });
    if (rule) {
      const { inboxRoles } = resolveApprovalFallback(rule, request.requestedAt);
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
          type: INQUIRY_QUOTING_WAIVER_REQUESTED_NOTIFICATION_TYPE,
          title: `${inquiry.number} wants to skip to quotation without a site inspection`,
          body: `${actor.actorLabel} says logging the requirements is not necessary — no inspection was ever requested. Missing: ${missing}.`,
          entityType: INQUIRY_ENTITY_TYPE,
          entityId: inquiry.id,
        });
      }
    }
  } catch {
    // Deliberately swallowed — see the doc comment above.
  }

  return request;
}

export async function decideQuotingWaiverService(
  actor: ActorMeta,
  approver: AuthedUser,
  input: { inquiryId: string; decision: "approved" | "rejected"; comment?: string },
) {
  const request = await findPendingQuotingWaiver(input.inquiryId);
  if (!request) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "That inquiry has no open requirements waiver.",
    });
  }

  await db.$transaction(async (tx) => {
    try {
      await decideApprovalRequest({
        requestId: request.id,
        approver,
        decision: input.decision,
        comment: input.comment,
        tx,
      });
    } catch (error) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: error instanceof Error ? error.message : "You cannot decide this approval.",
      });
    }

    if (input.decision === "approved") {
      await tx.inquiry.update({
        where: { id: input.inquiryId },
        data: {
          requirementsOverrideReason:
            `No site inspection was requested — approved by ${approver.name} as a simple purchase ` +
            `and delivery.` +
            (input.comment ? ` ${input.comment}` : ""),
          requirementsOverrideBy: approver.id,
          requirementsOverrideAt: new Date(),
        },
      });
    }

    await writeAuditLog(tx, {
      actorId: approver.id,
      actorLabel: approver.name,
      action: input.decision === "approved" ? "quoting_waiver_approved" : "quoting_waiver_rejected",
      entityType: INQUIRY_ENTITY_TYPE,
      entityId: input.inquiryId,
      summary:
        input.decision === "approved"
          ? "Approved skipping the requirements gate — no site inspection was requested."
          : `Declined the requirements waiver${input.comment ? `: ${input.comment}` : "."}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  const inquiry = await db.inquiry.findUniqueOrThrow({
    where: { id: input.inquiryId },
    select: { number: true },
  });

  if (input.decision === "approved") {
    await transitionInquiryService(
      { actorId: approver.id, actorLabel: approver.name },
      { inquiryId: input.inquiryId, to: "quoting" },
    );
  }

  try {
    await notify({
      recipientId: request.requestedById,
      type: INQUIRY_QUOTING_WAIVER_DECIDED_NOTIFICATION_TYPE,
      title:
        input.decision === "approved"
          ? `${inquiry.number} — waiver approved, pushed to quotation`
          : `${inquiry.number} — waiver declined`,
      body:
        input.decision === "approved"
          ? `${approver.name} agreed no site inspection was necessary. The inquiry is now in quoting.`
          : `${approver.name} said: ${input.comment ?? "no reason given"}.`,
      entityType: INQUIRY_ENTITY_TYPE,
      entityId: input.inquiryId,
    });
  } catch {
    // Deliberately swallowed — the decision itself already committed.
  }

  return { status: input.decision };
}

registerApprovalDecisionHandler(INQUIRY_QUOTING_WAIVER_ENTITY_TYPE, (context) =>
  decideQuotingWaiverService(context.actor, context.approver, {
    inquiryId: context.entityId,
    decision: context.decision,
    comment: context.comment,
  }),
);
