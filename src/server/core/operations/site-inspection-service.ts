import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";
import { registerFileAccessChecker } from "@/server/core/storage/access";
import type { AuthedUser } from "@/server/core/rbac/types";
import {
  INSPECTION_APPROVE_PERMISSION,
  SITE_INSPECTION_DOCUMENT_TYPE,
  SITE_INSPECTION_ENTITY_TYPE,
  inspectionCompleteness,
  isInspectionEditable,
  readAttendees,
  readUtilities,
  scopeChangeVerdict,
  type Attendee,
  type MeasurementRow,
} from "./site-inspection-rules";

/**
 * Site inspections (specs/04-operations-projects.md §6.1).
 *
 * ## The two routes in, and why they are one model
 *
 * §6.1's field sketch lists `ticketId, projectId?, siteId`, and its prose then says something the
 * sketch does not: "This is **also the sub-flow module 01 calls** when sales requests a
 * pre-quotation inspection — same record type, raised from an inquiry instead of a ticket."
 *
 * So this service is reached two ways. From a ticket, when §6 says a new project needs surveying
 * before it is planned. And from module 01's `inspection.requested`, which crm.prisma has predicted
 * since it was written: "When module 04 lands it consumes `inspection.requested` and this becomes
 * the request of record with the field task alongside it."
 *
 * The `InspectionRequest` remains the **ask** — who wanted it, what questions it must answer, when
 * the site will grant access. The `SiteInspection` is the **visit**. Completing the visit closes
 * the request, and module 01's own `completeInspectionService` is left untouched: a company that
 * files a report the old way still gets a closed request, and nothing that already worked stopped.
 */

export const SCOPE_CHANGE_NOTIFICATION_TYPE = "scope_change.identified";
export const INSPECTION_SCHEDULED_NOTIFICATION_TYPE = "site_inspection.scheduled";

registerNotificationType({
  key: SCOPE_CHANGE_NOTIFICATION_TYPE,
  label: "A site inspection found the job is bigger than quoted",
  defaultChannels: { inApp: true, email: false, digest: false },
});

registerNotificationType({
  key: INSPECTION_SCHEDULED_NOTIFICATION_TYPE,
  label: "A site inspection has been scheduled for you",
  defaultChannels: { inApp: true, email: false, digest: false },
});

/**
 * Photographs on an inspection are visible to anyone who can read the inspection.
 *
 * Registered here rather than in a shared file for the same reason module 01's is: the checker has
 * to be in the registry before anybody asks for a photograph, and the import that registers it is
 * the one that also owns the rule.
 */
registerFileAccessChecker(SITE_INSPECTION_ENTITY_TYPE, async (user, file) => {
  const inspection = await db.siteInspection.findFirst({
    where: { id: file.entityId, deletedAt: null },
    select: { inspectedByIds: true, requestedById: true },
  });
  if (!inspection) return false;
  return (
    user.permissions.has("ticket.view_all") ||
    inspection.inspectedByIds.includes(user.id) ||
    inspection.requestedById === user.id
  );
});

// ---- scheduling ---------------------------------------------------------------------------------

export interface ScheduleInspectionInput {
  ticketId?: string | null;
  projectId?: string | null;
  inquiryId?: string | null;
  inspectionRequestId?: string | null;
  siteId?: string | null;
  scheduledFor?: Date | null;
  inspectedByIds?: string[];
}

export async function scheduleInspectionService(actor: ActorMeta, input: ScheduleInspectionInput) {
  if (!input.ticketId && !input.projectId && !input.inquiryId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "An inspection has to belong to a ticket, a project or an inquiry — otherwise the findings " +
        "have nowhere to go.",
    });
  }

  const number = await allocateNumber(SITE_INSPECTION_DOCUMENT_TYPE);

  const inspection = await db.$transaction(async (tx) => {
    const created = await tx.siteInspection.create({
      data: {
        number,
        ticketId: input.ticketId ?? null,
        projectId: input.projectId ?? null,
        inquiryId: input.inquiryId ?? null,
        inspectionRequestId: input.inspectionRequestId ?? null,
        siteId: input.siteId ?? null,
        scheduledFor: input.scheduledFor ?? null,
        inspectedByIds: input.inspectedByIds ?? [],
        requestedById: actor.actorId,
        status: "scheduled",
      },
    });

    /**
     * §3 puts `site_inspection` in the **Project**'s status vocabulary, not the Ticket's — so this
     * moves the project, and leaves the ticket alone.
     *
     * That is the spec's shape rather than an oversight of mine: a project spans several tickets,
     * and "we are surveying" is true of the project while individual tickets are still waiting on
     * their own gates. Guarded to `planning` so a project already past this stage is not dragged
     * backwards by a second survey.
     */
    if (input.projectId) {
      await tx.project.updateMany({
        where: { id: input.projectId, status: "planning" },
        data: { status: "site_inspection", version: { increment: 1 } },
      });
    }

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "scheduled",
      entityType: SITE_INSPECTION_ENTITY_TYPE,
      entityId: created.id,
      summary:
        `Scheduled site inspection ${number}` +
        (input.scheduledFor ? ` for ${input.scheduledFor.toISOString().slice(0, 10)}` : ""),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return created;
  });

  for (const attendee of input.inspectedByIds ?? []) {
    await safeNotify({
      recipientId: attendee,
      type: INSPECTION_SCHEDULED_NOTIFICATION_TYPE,
      title: `${number} — site inspection assigned to you`,
      body: input.scheduledFor
        ? `Scheduled for ${input.scheduledFor.toISOString().slice(0, 10)}.`
        : "No date set yet.",
      entityType: SITE_INSPECTION_ENTITY_TYPE,
      entityId: inspection.id,
    });
  }

  return { id: inspection.id, number: inspection.number, status: inspection.status };
}

/**
 * The subscriber module 01 has been waiting for.
 *
 * specs/01-crm-inquiry.md §5: "Module 04 subscribes and creates a scheduled field task." This is
 * that, and it is the one subscription module 04 has — see the manifest for why the *other* obvious
 * one (`sales_order.created` → generate tickets) is still deliberately absent.
 *
 * Idempotent on `inspectionRequestId`, which is unique. The job queue retries, and a retry that
 * scheduled a second visit would put two surveyors on one site.
 */
export async function scheduleFromInspectionRequest(payload: {
  inspectionRequestId?: string;
  inquiryId?: string;
  siteId?: string | null;
  assignedToId?: string | null;
  dueAt?: string | null;
}) {
  if (!payload.inspectionRequestId || !payload.inquiryId) return;

  const existing = await db.siteInspection.findUnique({
    where: { inspectionRequestId: payload.inspectionRequestId },
    select: { id: true },
  });
  if (existing) return;

  const request = await db.inspectionRequest.findFirst({
    where: { id: payload.inspectionRequestId, deletedAt: null },
    select: { id: true, requestedById: true, siteId: true, assignedToId: true, dueAt: true },
  });
  if (!request) return;

  await scheduleInspectionService(
    // A system actor: nobody pressed a button, module 01's request did. The audit row says so
    // rather than attributing the scheduling to whoever happened to raise the inquiry.
    { actorId: request.requestedById, actorLabel: "Raised from an inspection request" },
    {
      inquiryId: payload.inquiryId,
      inspectionRequestId: request.id,
      siteId: request.siteId,
      scheduledFor: request.dueAt,
      inspectedByIds: request.assignedToId ? [request.assignedToId] : [],
    },
  );
}

// ---- recording the visit ------------------------------------------------------------------------

export interface SaveInspectionInput {
  inspectionId: string;
  inspectedAt?: Date | null;
  inspectedByIds?: string[];
  attendees?: Attendee[];
  findings?: string | null;
  existingConditions?: Record<string, unknown>;
  measurements?: MeasurementRow[];
  tagNumbers?: string[];
  accessConstraints?: string | null;
  permitsRequired?: string[];
  hazards?: string[];
  utilitiesAvailable?: Record<string, { available: boolean; note?: string }>;
  photoFileIds?: string[];
  sketchFileIds?: string[];
  scopeChangeIdentified?: boolean;
  scopeChangeNotes?: string | null;
}

/**
 * Saves what the surveyor found, and tells sales if the job grew.
 *
 * The scope-change emission lives **here** rather than on completion, and that is the whole point of
 * §6.1: the value of the link is how early it fires. A surveyor who flags a scope change from the
 * site on Tuesday and finishes the paperwork on Friday has given sales three days, and waiting for
 * `completed` would throw them away.
 */
export async function saveInspectionService(actor: ActorMeta, input: SaveInspectionInput) {
  const inspection = await loadEditable(input.inspectionId);

  const next = {
    inspectedAt: input.inspectedAt !== undefined ? input.inspectedAt : inspection.inspectedAt,
    inspectedByIds: input.inspectedByIds ?? inspection.inspectedByIds,
    attendees: input.attendees ?? readAttendees(inspection.attendees),
    findings: input.findings !== undefined ? input.findings : inspection.findings,
    photoFileIds: input.photoFileIds ?? inspection.photoFileIds,
    scopeChangeIdentified: input.scopeChangeIdentified ?? inspection.scopeChangeIdentified,
    scopeChangeNotes:
      input.scopeChangeNotes !== undefined ? input.scopeChangeNotes : inspection.scopeChangeNotes,
  };

  const verdict = scopeChangeVerdict({
    scopeChangeIdentified: next.scopeChangeIdentified,
    scopeChangeNotes: next.scopeChangeNotes,
    scopeChangeReportedAt: inspection.scopeChangeReportedAt,
  });

  await db.$transaction(async (tx) => {
    await tx.siteInspection.update({
      where: { id: inspection.id },
      data: {
        inspectedAt: next.inspectedAt,
        inspectedByIds: next.inspectedByIds,
        attendees: next.attendees as unknown as Prisma.InputJsonValue,
        findings: next.findings,
        ...(input.existingConditions !== undefined
          ? { existingConditions: input.existingConditions as Prisma.InputJsonValue }
          : {}),
        ...(input.measurements !== undefined
          ? { measurements: input.measurements as unknown as Prisma.InputJsonValue }
          : {}),
        ...(input.tagNumbers !== undefined ? { tagNumbers: input.tagNumbers } : {}),
        ...(input.accessConstraints !== undefined
          ? { accessConstraints: input.accessConstraints }
          : {}),
        ...(input.permitsRequired !== undefined ? { permitsRequired: input.permitsRequired } : {}),
        ...(input.hazards !== undefined ? { hazards: input.hazards } : {}),
        ...(input.utilitiesAvailable !== undefined
          ? { utilitiesAvailable: input.utilitiesAvailable as Prisma.InputJsonValue }
          : {}),
        ...(input.photoFileIds !== undefined ? { photoFileIds: input.photoFileIds } : {}),
        ...(input.sketchFileIds !== undefined ? { sketchFileIds: input.sketchFileIds } : {}),
        scopeChangeIdentified: next.scopeChangeIdentified,
        scopeChangeNotes: next.scopeChangeNotes,
        ...(verdict.shouldReport ? { scopeChangeReportedAt: new Date() } : {}),
        version: { increment: 1 },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "updated",
      entityType: SITE_INSPECTION_ENTITY_TYPE,
      entityId: inspection.id,
      summary: verdict.shouldReport
        ? `Recorded findings on ${inspection.number} — scope change flagged: ${next.scopeChangeNotes}`
        : `Recorded findings on ${inspection.number}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    if (verdict.shouldReport) {
      await emit(
        tx,
        "scope_change.identified",
        {
          siteInspectionId: inspection.id,
          number: inspection.number,
          ticketId: inspection.ticketId,
          projectId: inspection.projectId,
          inquiryId: inspection.inquiryId,
          notes: next.scopeChangeNotes,
        },
        { actorId: actor.actorId },
      );
    }
  });

  return {
    id: inspection.id,
    scopeChangeReported: verdict.shouldReport,
    completeness: inspectionCompleteness({ ...next, measurements: input.measurements }),
  };
}

/**
 * Marks the visit done (§6.1), refusing an inspection that is not actually a record of anything.
 *
 * See `inspectionCompleteness` for why the bar is three fields and photographs are only a warning.
 */
export async function completeInspectionService(actor: ActorMeta, inspectionId: string) {
  const inspection = await loadEditable(inspectionId);
  if (inspection.status === "completed") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${inspection.number} is already marked complete.`,
    });
  }

  const check = inspectionCompleteness(inspection);
  if (!check.complete) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${inspection.number} still needs ${check.missing.join("; ")}.`,
    });
  }

  await db.$transaction(async (tx) => {
    await tx.siteInspection.update({
      where: { id: inspection.id },
      data: { status: "completed", completedAt: new Date(), version: { increment: 1 } },
    });

    /**
     * Closes module 01's request, when the visit came from one.
     *
     * `updateMany` with a status guard rather than `update`: if somebody already closed the request
     * through module 01's own screen, this must not reopen or double-write it.
     */
    if (inspection.inspectionRequestId) {
      await tx.inspectionRequest.updateMany({
        where: {
          id: inspection.inspectionRequestId,
          status: { notIn: ["completed", "cancelled"] },
        },
        data: {
          status: "completed",
          completedAt: new Date(),
          findings: inspection.findings,
        },
      });
    }

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "completed",
      entityType: SITE_INSPECTION_ENTITY_TYPE,
      entityId: inspection.id,
      summary:
        `Completed site inspection ${inspection.number}` +
        (check.warnings.length > 0 ? ` — ${check.warnings.length} note(s)` : ""),
      diff: { status: { from: inspection.status, to: "completed" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "site_inspection.completed",
      {
        siteInspectionId: inspection.id,
        number: inspection.number,
        ticketId: inspection.ticketId,
        projectId: inspection.projectId,
        inquiryId: inspection.inquiryId,
        inspectionRequestId: inspection.inspectionRequestId,
        scopeChangeIdentified: inspection.scopeChangeIdentified,
      },
      { actorId: actor.actorId },
    );
  });

  return { status: "completed" as const, warnings: check.warnings };
}

/** §6.1's third state: somebody accountable has read the report and accepted it. */
/**
 * Approves a completed survey report.
 *
 * Two kinds of person may sign it off, and the second was added on the company's instruction of
 * 2026-08-17: "aside from EA and KJ, the personnel who assigned the site inspection during the
 * quoting process should also be able to approve the site inspection report, this ensures that they
 * have reviewed the site inspection report prior to continuing the quotation process."
 *
 * That is the better reason of the two. An officer approving on behalf of a survey they did not ask
 * for is a rubber stamp; the person who requested it is the one whose quotation depends on what it
 * says, and making them sign is what guarantees somebody read it before the quote went out.
 *
 * So the check lives here rather than in the router's permission: `project.manage` is sufficient, and
 * being the requester is *also* sufficient. Neither is necessary on its own.
 */
export async function approveInspectionService(
  user: AuthedUser,
  actor: ActorMeta,
  inspectionId: string,
) {
  const inspection = await db.siteInspection.findFirst({
    where: { id: inspectionId, deletedAt: null },
  });
  if (!inspection) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That inspection no longer exists." });
  }

  const isRequester = inspection.requestedById === user.id;
  if (!user.permissions.has("project.manage") && !isRequester) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Only an officer, or the person who asked for this survey, can approve the report. " +
        "Whoever requested it is the one whose quotation depends on what it says.",
    });
  }
  if (inspection.status !== "completed") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${inspection.number} is ${inspection.status}. Only a completed inspection can be approved.`,
    });
  }

  await db.$transaction(async (tx) => {
    await tx.siteInspection.update({
      where: { id: inspection.id },
      data: {
        status: "approved",
        approvedById: actor.actorId,
        approvedAt: new Date(),
        version: { increment: 1 },
      },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "approved",
      entityType: SITE_INSPECTION_ENTITY_TYPE,
      entityId: inspection.id,
      summary:
        `Approved site inspection ${inspection.number}` +
        (isRequester ? " (by the person who requested it)" : " (by an officer)"),
      diff: { status: { from: "completed", to: "approved" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { status: "approved" as const };
}

// ---- reading ------------------------------------------------------------------------------------

export async function getInspectionService(user: AuthedUser, inspectionId: string) {
  const inspection = await db.siteInspection.findFirst({
    where: { id: inspectionId, deletedAt: null },
    include: {
      ticket: { select: { id: true, number: true, title: true, type: true } },
      project: { select: { id: true, code: true, name: true } },
    },
  });
  if (!inspection) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That inspection no longer exists." });
  }

  // §19 scopes technicians to their own work. Attending the survey is what makes it yours.
  const involved =
    inspection.inspectedByIds.includes(user.id) || inspection.requestedById === user.id;
  if (!involved && !user.permissions.has("ticket.view_all")) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Site inspections are visible to the people who attended and to management.",
    });
  }

  return {
    ...inspection,
    /** Shaped, not raw Json — the screen and `inspectionCompleteness` read the same list. */
    attendees: readAttendees(inspection.attendees),
    utilities: readUtilities(inspection.utilitiesAvailable),
    completeness: inspectionCompleteness(inspection),
    editable: isInspectionEditable(inspection.status),
    /**
     * §6.1's sign-off, as the company redrew it on 2026-08-17: an officer *or* the person who asked
     * for the survey, because their quotation is what depends on what it says.
     */
    canApprove:
      user.permissions.has(INSPECTION_APPROVE_PERMISSION) || inspection.requestedById === user.id,
  };
}

export async function listInspectionsService(
  user: AuthedUser,
  filter: {
    status?: string;
    ticketId?: string;
    inquiryId?: string;
    scopeChangeOnly?: boolean;
  } = {},
) {
  const seesAll = user.permissions.has("ticket.view_all");

  return db.siteInspection.findMany({
    where: {
      deletedAt: null,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.ticketId ? { ticketId: filter.ticketId } : {}),
      ...(filter.inquiryId ? { inquiryId: filter.inquiryId } : {}),
      ...(filter.scopeChangeOnly ? { scopeChangeIdentified: true } : {}),
      ...(seesAll
        ? {}
        : { OR: [{ inspectedByIds: { has: user.id } }, { requestedById: user.id }] }),
    },
    include: {
      ticket: { select: { id: true, number: true, title: true } },
      project: { select: { id: true, code: true, name: true } },
    },
    orderBy: [{ scheduledFor: "asc" }, { createdAt: "desc" }],
    take: 200,
  });
}

// ---- helpers ------------------------------------------------------------------------------------

async function loadEditable(inspectionId: string) {
  const inspection = await db.siteInspection.findFirst({
    where: { id: inspectionId, deletedAt: null },
  });
  if (!inspection) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That inspection no longer exists." });
  }
  if (!isInspectionEditable(inspection.status)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${inspection.number} has been approved. An approved report is a signature — raise a new inspection instead of rewriting it.`,
    });
  }
  return inspection;
}

async function safeNotify(input: Parameters<typeof notify>[0]) {
  try {
    await notify(input);
  } catch {
    // A notification failure must never roll back the thing it announces.
  }
}
