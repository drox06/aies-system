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

/**
 * The roles that make somebody an obvious candidate for a site visit — used to *label* the picker,
 * not to restrict it.
 *
 * Spec.md §4.1 puts field execution with `technician` and dispatch with `operations_manager`. An
 * earlier version of this file used the list as an allow-list, on the reasoning that a site
 * inspection assigned to the finance officer is a visit that never happens.
 *
 * The company overruled that, and they are right about their own business: Spec.md §1.2 lists
 * "everyone does everything" as a fact of a five-person firm, and §4.3 says users hold multiple
 * roles precisely because "a five-person company has no clean separation of duties". PD is
 * admin_manager *and* finance_officer; KJ is vice_president *and* finance_officer. Refusing to let
 * the president walk a site he is already visiting is the software inventing a rule the business
 * does not have.
 *
 * So anyone active may be assigned, and this list only decides who is marked "technical" in the
 * dropdown — which keeps the useful half of the original idea (you can see at a glance who the
 * field people are) without the half that blocked real work.
 */
export const INSPECTION_TECHNICAL_ROLES = ["technician", "operations_manager"] as const;

export interface InspectionAssignee {
  id: string;
  name: string;
  roles: string[];
  /** True when they hold a field role — the dropdown marks these so the obvious choice is obvious. */
  isTechnical: boolean;
}

/**
 * Who an inspection may be assigned to: any active user.
 *
 * Exists as its own procedure because the form previously used `admin.listUsers`, which is gated on
 * `admin.manage_users` — a permission only the president holds. Everyone else opened the assignee
 * dropdown and found it empty, so in practice nobody but EA could assign an inspection at all. This
 * is gated on `inspection.request` instead: if you may raise one, you may see who can take it.
 *
 * Field roles are flagged rather than filtered, so the technical staff sort to the top and are
 * labelled, but nobody is barred. See INSPECTION_TECHNICAL_ROLES for why.
 */
export async function listInspectionAssigneesService(): Promise<InspectionAssignee[]> {
  const users = await db.user.findMany({
    where: { isActive: true, deletedAt: null },
    select: { id: true, name: true, roles: { select: { role: { select: { key: true } } } } },
    orderBy: { name: "asc" },
  });

  return (
    users
      .map((user) => {
        const roles = user.roles.map((r) => r.role.key);
        return {
          id: user.id,
          name: user.name,
          roles,
          isTechnical: roles.some((role) =>
            INSPECTION_TECHNICAL_ROLES.includes(role as "technician"),
          ),
        };
      })
      // Field staff first, then alphabetical within each group. The list is not restricted, but the
      // likely answer should still be the first thing you see.
      .sort((a, b) =>
        a.isTechnical === b.isTechnical ? a.name.localeCompare(b.name) : a.isTechnical ? -1 : 1,
      )
  );
}

/**
 * Shared by create and reassign, so the two cannot drift on who is eligible.
 *
 * The only bar is being a real, active account. Assigning work to somebody who has been deactivated
 * would send a notification nobody will ever read — which is the one case where silence is
 * guaranteed and the visit is guaranteed not to happen.
 */
async function assertAssignable(userId: string): Promise<{ id: string; name: string }> {
  const user = await db.user.findFirst({
    where: { id: userId, isActive: true, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!user) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "That user account is inactive or no longer exists, so it cannot be assigned work.",
    });
  }
  return user;
}

/**
 * Tells the assigned technician what they have been asked to do.
 *
 * The body carries the purpose, the due date, the window and the required outputs, because a
 * notification saying only "you have been assigned an inspection" makes the recipient open the
 * record just to find out whether it is urgent — and §5's whole point is that a visit answering the
 * wrong question costs another visit.
 */
async function notifyAssignee(
  recipientId: string,
  request: {
    purpose: string;
    dueAt: Date | null;
    windowStart: Date | null;
    windowEnd: Date | null;
    requiredOutputs: string[];
  },
  inquiry: { id: string; number: string },
): Promise<void> {
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  const window =
    request.windowStart || request.windowEnd
      ? `Window ${day(request.windowStart) ?? "any"} to ${day(request.windowEnd) ?? "any"}.`
      : null;

  await notify({
    recipientId,
    type: INSPECTION_REQUESTED_NOTIFICATION_TYPE,
    title: `Site inspection assigned to you — ${inquiry.number}`,
    body: [
      request.purpose,
      request.dueAt ? `Needed by ${day(request.dueAt)}.` : null,
      window,
      request.requiredOutputs.length > 0
        ? `Bring back: ${request.requiredOutputs.join(", ").replace(/_/g, " ")}.`
        : null,
    ]
      .filter(Boolean)
      .join(" "),
    // Points at the inquiry, which is where the panel and the site access notes live. The recipient
    // can now open it: inquiryScopeWhere admits an assigned inspector.
    entityType: INQUIRY_ENTITY_TYPE,
    entityId: inquiry.id,
  });
}

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

  // Validated before anything is written, so an ineligible assignee fails the whole request rather
  // than leaving an inspection nobody was told about.
  const assignee = input.assignedToId ? await assertAssignable(input.assignedToId) : null;

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
        assignedToId: assignee?.id ?? null,
        dueAt: input.dueAt ?? null,
        // Assigned at creation means it is already somebody's scheduled work; unassigned means it
        // is raised and waiting for a dispatcher.
        status: assignee ? "scheduled" : "requested",
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

  if (assignee) {
    await notifyAssignee(assignee.id, request, inquiry);
  }

  return request;
}

/**
 * Assigns or reassigns an open inspection, and tells the new assignee.
 *
 * Separate from a generic update because an assignment is a handover: somebody is now expected to
 * drive to a plant. The previous holder is deliberately not notified — "you no longer have to do
 * this" is not worth an interruption — but the audit row records the change either way.
 */
export async function assignInspectionService(
  actor: ActorMeta,
  input: { inspectionRequestId: string; assignedToId: string; dueAt?: Date | null },
) {
  const assignee = await assertAssignable(input.assignedToId);

  const request = await db.inspectionRequest.findFirst({
    where: { id: input.inspectionRequestId, deletedAt: null },
    include: { inquiry: { select: { id: true, number: true } } },
  });
  if (!request) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "That inspection request no longer exists.",
    });
  }
  if (request.status === "completed" || request.status === "cancelled") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `An inspection that is ${humanStatus(request.status)} cannot be reassigned.`,
    });
  }

  const updated = await db.$transaction(async (tx) => {
    const row = await tx.inspectionRequest.update({
      where: { id: request.id },
      data: {
        assignedToId: assignee.id,
        dueAt: input.dueAt === undefined ? request.dueAt : input.dueAt,
        status: "scheduled",
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "inspection_assigned",
      entityType: INQUIRY_ENTITY_TYPE,
      entityId: request.inquiry.id,
      summary: `Assigned the site inspection on ${request.inquiry.number} to ${assignee.name}`,
      diff: { assignedToId: { from: request.assignedToId, to: assignee.id } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return row;
  });

  await notifyAssignee(assignee.id, updated, request.inquiry);
  return updated;
}

/** Open inspections assigned to a user — what My Day shows a technician. */
export async function listMyInspectionsService(userId: string) {
  return db.inspectionRequest.findMany({
    where: {
      deletedAt: null,
      assignedToId: userId,
      status: { in: ["requested", "scheduled"] },
    },
    orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
    include: {
      inquiry: { select: { id: true, number: true, subject: true } },
      // The access notes come along because they decide whether the visit can happen at all —
      // gate pass lead time, induction, PPE.
      site: { select: { name: true, accessNotes: true } },
    },
  });
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
