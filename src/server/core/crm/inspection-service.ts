import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { humanStatus, INSPECTION_OUTPUTS } from "@/server/core/crm/inquiry-lifecycle";
import { INQUIRY_ENTITY_TYPE, transitionInquiryService } from "@/server/core/crm/inquiry-service";
import { emit } from "@/server/core/events/emit";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";

/**
 * Site inspection requests (specs/01-crm-inquiry.md §5).
 *
 * "Per the described process, sales sometimes needs the technical team to inspect a site before a
 * quotation can be completed."
 *
 * §5 is explicit that this is a placeholder for something module 04 will own: "Module 04 subscribes
 * and creates a scheduled field task; module 06 notifies the operations lead. Until module 04
 * exists, the request is a task assigned to a user with a due date." So the request itself is the
 * record of record here, and the assignment is the interim task. When module 04 lands it consumes
 * `inspection.requested` and schedules properly; nothing in this file has to change for that.
 */

export const INSPECTION_ENTITY_TYPE = "InspectionRequest";
export const INSPECTION_REQUESTED_NOTIFICATION_TYPE = "inspection.requested";

registerNotificationType({
  key: INSPECTION_REQUESTED_NOTIFICATION_TYPE,
  label: "A site inspection has been requested",
  // In-app only for the same reason as the SLA escalation: the `notify_email` queue has no handler
  // and every send would dead-letter (docs/DECISIONS.md #10). This one wants email as soon as one
  // exists — the person being asked to visit a plant may not open the app that day.
  defaultChannels: { inApp: true, email: false, digest: false },
});

export interface CreateInspectionInput {
  inquiryId: string;
  siteId?: string | null;
  purpose: string;
  questions?: string | null;
  requiredOutputs?: string[];
  windowStart?: Date | null;
  windowEnd?: Date | null;
  assignedToId?: string | null;
  dueAt?: Date | null;
}

/**
 * Raises an inspection request and moves the inquiry to `inspection_required`, which pauses its SLA
 * clock (§5).
 *
 * The status change goes through `transitionInquiryService` rather than being written here, so it
 * passes the same §3 legality check as any other move and produces the same audit row and events.
 * Writing `status: "inspection_required"` directly would be shorter and would be the second door
 * into a field the state machine is supposed to own.
 *
 * A consequence worth stating: an inquiry must be `evaluating` before an inspection can be raised,
 * because that is the only place §3's diagram allows the move from. Somebody who has not yet
 * acknowledged the inquiry is told to do that first, which is the right order anyway — a site visit
 * booked against an inquiry nobody has read is how a technician ends up at the wrong plant.
 */
export async function createInspectionRequestService(
  actor: ActorMeta,
  input: CreateInspectionInput,
) {
  const purpose = input.purpose.trim();
  if (purpose.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Say what the inspection is for — a visit with no stated purpose gets nothing back.",
    });
  }

  for (const output of input.requiredOutputs ?? []) {
    if (!INSPECTION_OUTPUTS.includes(output as (typeof INSPECTION_OUTPUTS)[number])) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown required output "${output}".` });
    }
  }
  if (input.windowStart && input.windowEnd && input.windowEnd < input.windowStart) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The inspection window ends before it starts.",
    });
  }

  const inquiry = await db.inquiry.findFirst({
    where: { id: input.inquiryId, deletedAt: null },
    select: { id: true, number: true, status: true, accountId: true, siteId: true },
  });
  if (!inquiry) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That inquiry no longer exists." });
  }
  if (inquiry.status === "inspection_required") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This inquiry already has an open inspection request.",
    });
  }

  const request = await db.$transaction(async (tx) => {
    const created = await tx.inspectionRequest.create({
      data: {
        inquiryId: inquiry.id,
        // Falls back to the inquiry's own site: the commonest case is inspecting the site the
        // inquiry is already about, and making someone re-pick it is a chance to pick wrong.
        siteId: input.siteId ?? inquiry.siteId,
        purpose,
        questions: input.questions ?? null,
        requiredOutputs: input.requiredOutputs ?? [],
        windowStart: input.windowStart ?? null,
        windowEnd: input.windowEnd ?? null,
        assignedToId: input.assignedToId ?? null,
        dueAt: input.dueAt ?? null,
        requestedById: actor.actorId,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "inspection_requested",
      // Logged against the *inquiry*, not the request: the inquiry is the record people open, and
      // module 00's activity feed merges audit rows by entity, so this is what puts the request in
      // the inquiry's timeline.
      entityType: INQUIRY_ENTITY_TYPE,
      entityId: inquiry.id,
      summary: `Requested a site inspection on ${inquiry.number}: ${purpose}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "inspection.requested",
      {
        inspectionRequestId: created.id,
        inquiryId: inquiry.id,
        siteId: created.siteId,
        purpose,
        requiredOutputs: created.requiredOutputs,
        windowStart: created.windowStart?.toISOString() ?? null,
        windowEnd: created.windowEnd?.toISOString() ?? null,
        assignedToId: created.assignedToId,
        dueAt: created.dueAt?.toISOString() ?? null,
      },
      { actorId: actor.actorId, requestId: actor.requestId },
    );

    return created;
  });

  // Outside the transaction on purpose: the request exists and the pause is what matters, so a
  // transition failure must not undo it. If the inquiry was not `evaluating` the caller gets §3's
  // own message back, telling them exactly which move is missing.
  await transitionInquiryService(actor, { inquiryId: inquiry.id, to: "inspection_required" });

  if (request.assignedToId) {
    await notify({
      recipientId: request.assignedToId,
      type: INSPECTION_REQUESTED_NOTIFICATION_TYPE,
      title: `Site inspection requested — ${inquiry.number}`,
      body:
        `${purpose}` +
        (request.dueAt ? ` Needed by ${request.dueAt.toISOString().slice(0, 10)}.` : ""),
      entityType: INQUIRY_ENTITY_TYPE,
      entityId: inquiry.id,
    });
  }

  return request;
}

/**
 * Records the completed inspection and returns the inquiry to `evaluating`, which resumes the SLA
 * clock and banks the paused time.
 *
 * §5: "The completed inspection report attaches back to the inquiry and its findings are pulled
 * into the quotation's scope of work." The findings are stored as text here and the report as a
 * module 00 file id; module 02 reads both when it builds the scope.
 */
export async function completeInspectionService(
  actor: ActorMeta,
  input: {
    inspectionRequestId: string;
    findings?: string | null;
    reportFileId?: string | null;
  },
) {
  const request = await db.inspectionRequest.findFirst({
    where: { id: input.inspectionRequestId, deletedAt: null },
    include: { inquiry: { select: { id: true, number: true, status: true } } },
  });
  if (!request) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "That inspection request no longer exists.",
    });
  }
  if (request.status === "completed") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That inspection is already completed." });
  }

  await db.$transaction(async (tx) => {
    await tx.inspectionRequest.update({
      where: { id: request.id },
      data: {
        status: "completed",
        completedAt: new Date(),
        findings: input.findings ?? null,
        reportFileId: input.reportFileId ?? null,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "inspection_completed",
      entityType: INQUIRY_ENTITY_TYPE,
      entityId: request.inquiry.id,
      summary: `Completed the site inspection on ${request.inquiry.number}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  // Only if the inquiry is actually parked on this inspection. It may have been moved on by hand,
  // and forcing it back to `evaluating` would undo somebody's deliberate action.
  if (request.inquiry.status === "inspection_required") {
    await transitionInquiryService(actor, { inquiryId: request.inquiry.id, to: "evaluating" });
  }

  return { ok: true as const };
}

/** Cancels an open request, returning the inquiry to `evaluating` the same way completion does. */
export async function cancelInspectionService(
  actor: ActorMeta,
  input: { inspectionRequestId: string; reason?: string | null },
) {
  const request = await db.inspectionRequest.findFirst({
    where: { id: input.inspectionRequestId, deletedAt: null },
    include: { inquiry: { select: { id: true, number: true, status: true } } },
  });
  if (!request) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "That inspection request no longer exists.",
    });
  }
  if (request.status !== "requested" && request.status !== "scheduled") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `An inspection that is ${humanStatus(request.status)} cannot be cancelled.`,
    });
  }

  await db.$transaction(async (tx) => {
    await tx.inspectionRequest.update({
      where: { id: request.id },
      data: { status: "cancelled", findings: input.reason ?? null },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "inspection_cancelled",
      entityType: INQUIRY_ENTITY_TYPE,
      entityId: request.inquiry.id,
      summary:
        `Cancelled the site inspection on ${request.inquiry.number}` +
        (input.reason ? `: ${input.reason}` : ""),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  if (request.inquiry.status === "inspection_required") {
    await transitionInquiryService(actor, { inquiryId: request.inquiry.id, to: "evaluating" });
  }

  return { ok: true as const };
}
