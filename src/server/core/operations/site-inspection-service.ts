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
  canOpenSiteInspection,
  canReviseInspection,
  canSeeAnySiteInspection,
  inspectionCompleteness,
  isInspectionEditable,
  readAttendees,
  readUtilities,
  scopeChangeVerdict,
  type Attendee,
  type MeasurementRow,
} from "./site-inspection-rules";
import { TICKET_ENTITY_TYPE } from "./ticket-rules";

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
export const INSPECTION_APPROVED_NOTIFICATION_TYPE = "site_inspection.approved";

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
 * "The generated SIR should be made available to the requestor... this should also go into the
 * requestor's notification as soon as the SIR is approved and generated" (2026-09-04). Approval, not
 * completion, is the trigger: the report is generated on demand from whatever the record holds at
 * download time (`renderSiteInspectionReportPdf`), and a completed-but-unapproved inspection can still
 * be corrected — approval is the point §6.1 already treats as the signature, and it is also the
 * moment `approveInspectionService` allows the requester themselves to press.
 */
registerNotificationType({
  key: INSPECTION_APPROVED_NOTIFICATION_TYPE,
  label: "Your site inspection report has been approved",
  defaultChannels: { inApp: true, email: false, digest: false },
});

/**
 * Photographs on an inspection are visible to anyone who can read the inspection — exactly
 * `canOpenSiteInspection`, not a second copy of it. Found out of step while building "Share report
 * to" (#167): this had never been updated for #166's closed list, so a bystander merely holding
 * `ticket.view_all` could still open every photo even after being refused the record itself, and
 * somebody freshly shared with had no way to see the pictures the report is actually about.
 *
 * Registered here rather than in a shared file for the same reason module 01's is: the checker has
 * to be in the registry before anybody asks for a photograph, and the import that registers it is
 * the one that also owns the rule.
 */
registerFileAccessChecker(SITE_INSPECTION_ENTITY_TYPE, async (user, file) => {
  const inspection = await db.siteInspection.findFirst({
    where: { id: file.entityId, deletedAt: null },
    select: { inspectedByIds: true, requestedById: true, sharedWithIds: true },
  });
  if (!inspection) return false;
  return canOpenSiteInspection(inspection, user);
});

/**
 * How many photos are actually on the record, for `inspectionCompleteness`'s warning — counted from
 * `FileObject`, the same store the "Photographs and sketches" panel (`<Attachments>`) reads and
 * writes, not from `SiteInspection.photoFileIds`. That field is never written by the app itself
 * (photos are attached through the generic panel, keyed by entityType/entityId, not by id list), so
 * reading it always found zero — a fully photographed visit still warned "No photographs" and its
 * generated report always said "None attached to this visit" (2026-09-04).
 */
async function countInspectionPhotos(inspectionId: string): Promise<number> {
  return db.fileObject.count({
    where: { entityType: SITE_INSPECTION_ENTITY_TYPE, entityId: inspectionId, deletedAt: null },
  });
}

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

  // Skipped when this came from an inspection request: module 01's own createInspectionRequestService
  // already told the assignee, with the purpose, the window and what to bring back — richer than
  // this generic line has any way to be, since a request-driven visit is the only kind with any of
  // that to say. Sending both would be the same assignment landing twice in one inbox (#164).
  if (!input.inspectionRequestId) {
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
  /**
   * Required, and only meaningful, once the report is `completed` — see `canReviseInspection`. A
   * `scheduled` inspection is still being filled in for the first time and has nothing to give a
   * reason for yet.
   */
  revisionReason?: string;
}

/**
 * Saves what the surveyor found, and tells sales if the job grew.
 *
 * The scope-change emission lives **here** rather than on completion, and that is the whole point of
 * §6.1: the value of the link is how early it fires. A surveyor who flags a scope change from the
 * site on Tuesday and finishes the paperwork on Friday has given sales three days, and waiting for
 * `completed` would throw them away.
 *
 * **Reopening an already-accomplished report is a different action from filling one in**, and this is
 * the one place that difference is enforced — `loadEditable` only refuses `approved`, exactly as
 * before. Asked for by the company on 2026-09-04, after a completed report's inputs were overwritten
 * with nothing recording who did it or why: while `status` is `completed`, only the person who
 * conducted the inspection may save here (`canReviseInspection`), and they must say why
 * (`revisionReason`) — recorded as its own audit row rather than folded into the ordinary "updated"
 * one, so the report's own history can tell "first write-up" apart from "correction, and here's why".
 */
export async function saveInspectionService(actor: ActorMeta, input: SaveInspectionInput) {
  const inspection = await loadEditable(input.inspectionId);

  const isRevision = inspection.status === "completed";
  if (isRevision) {
    if (!inspection.inspectedByIds.includes(actor.actorId)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `${inspection.number} has been accomplished and is frozen. Only the person who conducted the inspection may revise it.`,
      });
    }
    if (!input.revisionReason?.trim()) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Say why this accomplished report is being revised.",
      });
    }
  }

  const next = {
    inspectedAt: input.inspectedAt !== undefined ? input.inspectedAt : inspection.inspectedAt,
    inspectedByIds: input.inspectedByIds ?? inspection.inspectedByIds,
    attendees: input.attendees ?? readAttendees(inspection.attendees),
    findings: input.findings !== undefined ? input.findings : inspection.findings,
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

    if (isRevision) {
      // Its own row, not folded into the "updated" one above — the reason is the whole point, and
      // this is also what `buildSiteInspectionReportProps` queries to print "why revised" on the PDF.
      await writeAuditLog(tx, {
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        action: "revised",
        entityType: SITE_INSPECTION_ENTITY_TYPE,
        entityId: inspection.id,
        summary: `Revised ${inspection.number} — ${input.revisionReason!.trim()}`,
        ip: actor.ip,
        userAgent: actor.userAgent,
        requestId: actor.requestId,
      });
    }

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
    completeness: inspectionCompleteness({
      ...next,
      measurements: input.measurements,
      photoCount: await countInspectionPhotos(inspection.id),
    }),
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

  const check = inspectionCompleteness({
    ...inspection,
    photoCount: await countInspectionPhotos(inspection.id),
  });
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

  // Only when somebody else approved it — the requester approving their own report already knows.
  if (inspection.requestedById && inspection.requestedById !== actor.actorId) {
    await safeNotify({
      recipientId: inspection.requestedById,
      type: INSPECTION_APPROVED_NOTIFICATION_TYPE,
      title: `Site inspection report approved — ${inspection.number}`,
      body: "The report you asked for is approved and ready to view or download.",
      entityType: SITE_INSPECTION_ENTITY_TYPE,
      entityId: inspection.id,
    });
  }

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

  // §19 scopes technicians to their own work — attending the survey or asking for it is what makes
  // it yours — widened to EA, KJ and DJ by name (2026-09-03). See `canOpenSiteInspection`'s own
  // comment for why this replaced a `ticket.view_all` check rather than adding to it.
  if (!canOpenSiteInspection(inspection, user)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Site inspections are visible to the people who attended, whoever asked for it, and to EA, " +
        "KJ and DJ.",
    });
  }

  const [sharedWith, photoCount] = await Promise.all([
    inspection.sharedWithIds.length > 0
      ? db.user.findMany({
          where: { id: { in: inspection.sharedWithIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    countInspectionPhotos(inspection.id),
  ]);

  return {
    ...inspection,
    /** Shaped, not raw Json — the screen and `inspectionCompleteness` read the same list. */
    attendees: readAttendees(inspection.attendees),
    utilities: readUtilities(inspection.utilitiesAvailable),
    completeness: inspectionCompleteness({ ...inspection, photoCount }),
    /**
     * Freely editable, no reason required — true only while still `scheduled`. This used to also be
     * true for `completed` (`isInspectionEditable` covers both, and still does — it is the "not yet
     * approved" gate `saveInspectionService` enforces at the door). The screen needs a narrower
     * question: whether to open the form with no further gate, and the answer to that narrows to
     * `scheduled` once `completed` has its own gate — see `canRevise`.
     */
    editable: inspection.status === "scheduled",
    /** Whether *this* user may reopen an accomplished report — see `canReviseInspection`. */
    canRevise: canReviseInspection(inspection, user.id),
    /** Named, not just the raw ids — so "Shared with" reads as people rather than as cuids. */
    sharedWith,
    /**
     * §6.1's sign-off, as the company redrew it on 2026-08-17: an officer *or* the person who asked
     * for the survey, because their quotation is what depends on what it says.
     */
    canApprove:
      user.permissions.has(INSPECTION_APPROVE_PERMISSION) || inspection.requestedById === user.id,
  };
}

/**
 * Every active user, for the "Share report to" picker (2026-09-03) — deliberately not narrowed to
 * field roles the way `listInspectionAssigneesService` (module 01's assignment picker) is, since
 * sharing a finished report is not the same question as "who might go do the visit".
 */
export async function shareableUsersService(): Promise<{ id: string; name: string }[]> {
  return db.user.findMany({
    where: { isActive: true, deletedAt: null },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

registerNotificationType({
  key: "site_inspection.shared",
  label: "A site inspection report was shared with you",
  defaultChannels: { inApp: true, email: false, digest: false },
});

/**
 * Grants one more person standing access to this inspection — 2026-09-03's "Share report to"
 * picker: *"when this is clicked, the user selected will have access to this site inspection
 * report."* Anybody who can already open the record may extend that to somebody else; there is no
 * narrower gate than the one `canOpenSiteInspection` already enforces on the way in, the same
 * reasoning a channel's own membership works by.
 */
export async function shareInspectionService(
  actor: ActorMeta & { id: string; email: string },
  input: { inspectionId: string; userId: string },
) {
  const inspection = await db.siteInspection.findFirst({
    where: { id: input.inspectionId, deletedAt: null },
    select: {
      id: true,
      number: true,
      inspectedByIds: true,
      requestedById: true,
      sharedWithIds: true,
    },
  });
  if (!inspection) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That inspection no longer exists." });
  }
  if (!canOpenSiteInspection(inspection, actor)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You cannot share a report you cannot yourself open.",
    });
  }

  const recipient = await db.user.findFirst({
    where: { id: input.userId, isActive: true, deletedAt: null },
    select: { id: true, name: true, email: true },
  });
  if (!recipient) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "That user account is inactive or no longer exists.",
    });
  }

  // Already has it, one way or another — not an error, just nothing further to do.
  if (canOpenSiteInspection(inspection, recipient)) {
    return { id: inspection.id, alreadyShared: true };
  }

  await db.$transaction(async (tx) => {
    await tx.siteInspection.update({
      where: { id: inspection.id },
      data: { sharedWithIds: { push: recipient.id } },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "shared",
      entityType: SITE_INSPECTION_ENTITY_TYPE,
      entityId: inspection.id,
      summary: `Shared site inspection ${inspection.number} with ${recipient.name}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  await safeNotify({
    recipientId: recipient.id,
    type: "site_inspection.shared",
    title: `${inspection.number} — a site inspection report was shared with you`,
    body: `${actor.actorLabel} gave you access to this report.`,
    entityType: SITE_INSPECTION_ENTITY_TYPE,
    entityId: inspection.id,
  });

  return { id: inspection.id, alreadyShared: false };
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
  // Kept in step with getInspectionService's own gate — a listing that offered a link to a survey
  // the click-through would then refuse is the exact "button that 403s" failure this platform's own
  // convention warns against.
  const seesAll = canSeeAnySiteInspection(user.email);

  return db.siteInspection.findMany({
    where: {
      deletedAt: null,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.ticketId ? { ticketId: filter.ticketId } : {}),
      ...(filter.inquiryId ? { inquiryId: filter.inquiryId } : {}),
      ...(filter.scopeChangeOnly ? { scopeChangeIdentified: true } : {}),
      ...(seesAll
        ? {}
        : {
            OR: [
              { inspectedByIds: { has: user.id } },
              { requestedById: user.id },
              { sharedWithIds: { has: user.id } },
            ],
          }),
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

// ---- "this job does not need a survey" -----------------------------------------------------------

/**
 * The audit actions that record a waiver and its withdrawal.
 *
 * Stored as audit rows rather than a column on Ticket, the same way the cash-advance and methodology
 * gates record their overrides. Two reasons. The waiver is a *decision somebody made on a date*, and
 * a boolean column throws away who and when — which is the half that matters when a job goes wrong
 * and somebody asks why nobody looked at the site. And it needs no migration on a schema the company
 * is about to run live data through.
 */
export const INSPECTION_WAIVED_ACTION = "site_inspection_waived";
export const INSPECTION_WAIVER_WITHDRAWN_ACTION = "site_inspection_waiver_withdrawn";

export interface InspectionWaiver {
  waived: boolean;
  /** The reason, when there is one, as written. Null when the waiver has been withdrawn. */
  summary: string | null;
  at: Date | null;
  by: string | null;
}

/**
 * Whether somebody has said this ticket needs no site survey.
 *
 * Reads the newest of the two actions and lets it stand, so a waiver can be withdrawn and re-applied
 * without the history being rewritten. An older waiver under a newer withdrawal is not a waiver.
 */
export async function inspectionWaiverForTicket(ticketId: string): Promise<InspectionWaiver> {
  const log = await db.auditLog.findFirst({
    where: {
      entityType: TICKET_ENTITY_TYPE,
      entityId: ticketId,
      action: { in: [INSPECTION_WAIVED_ACTION, INSPECTION_WAIVER_WITHDRAWN_ACTION] },
    },
    orderBy: { at: "desc" },
    select: { action: true, summary: true, at: true, actorLabel: true },
  });

  if (!log || log.action === INSPECTION_WAIVER_WITHDRAWN_ACTION) {
    return { waived: false, summary: null, at: null, by: null };
  }
  return { waived: true, summary: log.summary, at: log.at, by: log.actorLabel };
}

/**
 * Records that no survey is needed, or withdraws that.
 *
 * ## Why this exists
 *
 * §6 puts a site survey before a new project is planned, and the ticket says so with a badge. But
 * plenty of new projects are on a site AIES has worked for years, or are a like-for-like replacement
 * of an instrument somebody photographed last month. The badge sat there permanently on those jobs,
 * and a warning that can never be cleared is one people stop seeing — including on the job where it
 * mattered. Raised by the company on 2026-08-19.
 *
 * ## Why it is not a silent tick
 *
 * A waiver is an answer, not an absence — the same distinction §7's undecided materials and §9's
 * waived client inspection turn on. It carries who, when, and why, and it appears on the panel as a
 * recorded decision rather than as the gate quietly disappearing. "Not needed" and "nobody has got
 * to it yet" must never look the same on screen.
 *
 * The reason is required and has to be long enough to mean something. "n/a" is not a reason; "we
 * surveyed this line in March and nothing has changed" is.
 *
 * ## What it does not do
 *
 * It does not stop anybody recording an inspection afterwards. If somebody goes anyway, the report
 * still has somewhere to live — see `inspectionRequiredForTicket` for the same reasoning.
 */
export async function setInspectionWaiverService(
  actor: ActorMeta,
  input: { ticketId: string; waived: boolean; reason?: string },
) {
  const ticket = await db.ticket.findFirst({
    where: { id: input.ticketId, deletedAt: null },
    select: { id: true, number: true },
  });
  if (!ticket) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That ticket no longer exists." });
  }

  const reason = (input.reason ?? "").trim();
  if (input.waived && reason.length < 10) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Say why no survey is needed, in enough words to be worth reading later — somebody will " +
        "ask if the job turns out bigger than it looked.",
    });
  }

  const existing = await db.auditLog.findFirst({
    where: {
      entityType: TICKET_ENTITY_TYPE,
      entityId: ticket.id,
      action: { in: [INSPECTION_WAIVED_ACTION, INSPECTION_WAIVER_WITHDRAWN_ACTION] },
    },
    orderBy: { at: "desc" },
    select: { action: true },
  });
  const alreadyWaived = existing?.action === INSPECTION_WAIVED_ACTION;
  if (alreadyWaived === input.waived) {
    // Nothing changed. Writing a second identical row would put a decision in the history that
    // nobody made.
    return { waived: input.waived };
  }

  await db.$transaction(async (tx) => {
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: input.waived ? INSPECTION_WAIVED_ACTION : INSPECTION_WAIVER_WITHDRAWN_ACTION,
      entityType: TICKET_ENTITY_TYPE,
      entityId: ticket.id,
      summary: input.waived
        ? reason
        : `${ticket.number} needs a site survey after all — the waiver was withdrawn.`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { waived: input.waived };
}
