import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import { registerFileAccessChecker } from "@/server/core/storage/access";
import { closeoutBlockers as criticalPunchFrom, type PunchItem } from "./tc-rules";
import { outstandingCustody, type CustodyLine } from "./material-request-rules";
import {
  CLOSE_OUT_ENTITY_TYPE,
  SERVICE_REPORT_DOCUMENT_TYPE,
  SERVICE_REPORT_ENTITY_TYPE,
  checkServiceReport,
  closeOutChecklist,
  closeOutVerdict,
  type PartUsed,
  type ServiceReportStatus,
} from "./close-out-rules";

/**
 * Service report and project close-out (specs/04-operations-projects.md §12).
 *
 * ## The blockers are computed, never stored as the answer
 *
 * `ProjectCloseOut.checklist` holds the last computed state so a screen can render without running
 * six queries, but `closeOutProjectService` recomputes before it does anything. §12 makes close-out
 * the handover that releases final billing — a cached "yes" from last Tuesday is not a thing to bill
 * a customer on.
 */

registerFileAccessChecker(SERVICE_REPORT_ENTITY_TYPE, async (user) => {
  return user.permissions.has("ticket.view") || user.permissions.has("ticket.view_all");
});

registerFileAccessChecker(CLOSE_OUT_ENTITY_TYPE, async (user) => {
  // `project.view` is deliberately not declared yet — operations-manifest.test.ts holds it back
  // until something gates it — so leaning on it here would grant nobody anything.
  return user.permissions.has("project.manage") || user.permissions.has("project.close");
});

const readParts = (raw: unknown): PartUsed[] =>
  Array.isArray(raw)
    ? raw.filter(
        (entry): entry is PartUsed =>
          !!entry &&
          typeof entry === "object" &&
          typeof (entry as PartUsed).description === "string",
      )
    : [];

const readPunch = (raw: unknown): PunchItem[] =>
  Array.isArray(raw)
    ? raw.filter(
        (entry): entry is PunchItem =>
          !!entry &&
          typeof entry === "object" &&
          typeof (entry as PunchItem).description === "string",
      )
    : [];

// ---- the service report --------------------------------------------------------------------------

export interface SaveServiceReportInput {
  id?: string;
  ticketId: string;
  workPerformed: string;
  findings?: string | null;
  recommendations?: string | null;
  partsUsed?: PartUsed[];
  equipmentIds?: string[];
  startedAt?: Date | null;
  finishedAt?: Date | null;
  travelTimeMin?: number | null;
  standbyTimeMin?: number | null;
  photoFileIds?: string[];
  followUpRequired?: boolean;
  followUpNotes?: string | null;
}

export async function saveServiceReportService(actor: ActorMeta, input: SaveServiceReportInput) {
  const ticket = await db.ticket.findFirst({
    where: { id: input.ticketId, deletedAt: null },
    select: { id: true, number: true, projectId: true },
  });
  if (!ticket) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That ticket no longer exists." });
  }

  const existing = input.id
    ? await db.serviceReport.findFirst({ where: { id: input.id, deletedAt: null } })
    : null;
  if (input.id && !existing) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That service report no longer exists." });
  }
  if (existing?.status === "approved") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "That report is approved. Raise a new one rather than editing the approved record.",
    });
  }

  const check = checkServiceReport({
    target: (existing?.status as ServiceReportStatus) ?? "draft",
    workPerformed: input.workPerformed,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    customerSignatureFileId: existing?.customerSignatureFileId,
    signatureWaiverReason: existing?.signatureWaiverReason,
    customerName: existing?.customerName,
    followUpRequired: input.followUpRequired ?? false,
    followUpNotes: input.followUpNotes,
    partsUsed: input.partsUsed,
  });
  if (!check.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: check.errors.join(" ") });
  }

  const data = {
    workPerformed: input.workPerformed,
    findings: input.findings ?? null,
    recommendations: input.recommendations ?? null,
    partsUsed: (input.partsUsed ?? []) as unknown as Prisma.InputJsonValue,
    equipmentIds: input.equipmentIds ?? [],
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
    travelTimeMin: input.travelTimeMin ?? null,
    standbyTimeMin: input.standbyTimeMin ?? null,
    photoFileIds: input.photoFileIds ?? [],
    followUpRequired: input.followUpRequired ?? false,
    followUpNotes: input.followUpNotes ?? null,
  };

  if (existing) {
    return db.serviceReport.update({
      where: { id: existing.id },
      data: { ...data, version: { increment: 1 } },
    });
  }

  const number = await allocateNumber(SERVICE_REPORT_DOCUMENT_TYPE);

  return db.$transaction(async (tx) => {
    const created = await tx.serviceReport.create({
      data: {
        number,
        ticketId: ticket.id,
        projectId: ticket.projectId,
        preparedById: actor.actorId,
        ...data,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "service_report_drafted",
      entityType: SERVICE_REPORT_ENTITY_TYPE,
      entityId: created.id,
      summary: `${number} drafted on ${ticket.number}.`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return created;
  });
}

/**
 * Moves a report along §12's status flow.
 *
 * Signature and approval are separate acts by design: the customer signs what the technician wrote,
 * and somebody at AIES then approves it. Collapsing the two would mean the report the customer signed
 * and the report the company stands behind are the same click.
 */
export async function advanceServiceReportService(
  actor: ActorMeta,
  input: {
    id: string;
    target: ServiceReportStatus;
    customerSignatureFileId?: string | null;
    customerName?: string | null;
    customerPosition?: string | null;
    customerRemarks?: string | null;
    signatureWaiverReason?: string | null;
  },
) {
  const report = await db.serviceReport.findFirst({
    where: { id: input.id, deletedAt: null },
    include: { ticket: { select: { number: true } } },
  });
  if (!report) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That service report no longer exists." });
  }
  if (report.status === "approved") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That report is already approved." });
  }

  const check = checkServiceReport({
    target: input.target,
    workPerformed: report.workPerformed,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    customerSignatureFileId: input.customerSignatureFileId ?? report.customerSignatureFileId,
    signatureWaiverReason: input.signatureWaiverReason ?? report.signatureWaiverReason,
    customerName: input.customerName ?? report.customerName,
    followUpRequired: report.followUpRequired,
    followUpNotes: report.followUpNotes,
    partsUsed: readParts(report.partsUsed),
  });
  if (!check.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: check.errors.join(" ") });
  }

  const approving = input.target === "approved";

  const updated = await db.$transaction(async (tx) => {
    const saved = await tx.serviceReport.update({
      where: { id: report.id },
      data: {
        status: input.target,
        ...(input.customerSignatureFileId === undefined
          ? {}
          : { customerSignatureFileId: input.customerSignatureFileId }),
        ...(input.customerName === undefined ? {} : { customerName: input.customerName }),
        ...(input.customerPosition === undefined
          ? {}
          : { customerPosition: input.customerPosition }),
        ...(input.customerRemarks === undefined ? {} : { customerRemarks: input.customerRemarks }),
        ...(input.signatureWaiverReason === undefined
          ? {}
          : { signatureWaiverReason: input.signatureWaiverReason }),
        ...(approving ? { approvedById: actor.actorId, approvedAt: new Date() } : {}),
        version: { increment: 1 },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: approving ? "service_report_approved" : "service_report_advanced",
      entityType: SERVICE_REPORT_ENTITY_TYPE,
      entityId: report.id,
      summary:
        `${report.number} on ${report.ticket.number}: ${input.target.replace(/_/g, " ")}` +
        (saved.customerSignatureFileId
          ? `, signed by ${saved.customerName ?? "the customer"}.`
          : saved.signatureWaiverReason
            ? `, unsigned — ${saved.signatureWaiverReason}`
            : "."),
      diff: { status: { from: report.status, to: input.target } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    if (approving) {
      await emit(
        tx,
        "service_report.approved",
        {
          serviceReportId: report.id,
          number: report.number,
          ticketId: report.ticketId,
          projectId: report.projectId,
          followUpRequired: report.followUpRequired,
        },
        { actorId: actor.actorId },
      );
    }

    return saved;
  });

  return {
    id: updated.id,
    number: updated.number,
    status: updated.status,
    warnings: check.warnings,
  };
}

export async function listServiceReportsForTicketService(ticketId: string) {
  const rows = await db.serviceReport.findMany({
    where: { ticketId, deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((row) => ({ ...row, partsUsed: readParts(row.partsUsed) }));
}

// ---- §12's close-out -------------------------------------------------------------------------------

/**
 * Computes §12's six blockers for a project, from what the other sections recorded.
 *
 * Each is a separate query on purpose. §20 requires each blocker to hold close-out on its own and to
 * release on its own, and the cheapest way to be sure of that is for none of them to share a code
 * path with another.
 */
export async function closeOutChecklistForProjectService(projectId: string) {
  const project = await db.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, code: true, name: true, accountId: true },
  });
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That project no longer exists." });
  }

  const tickets = await db.ticket.findMany({
    where: { projectId, deletedAt: null },
    select: { id: true },
  });
  const ticketIds = tickets.map((ticket) => ticket.id);

  // §10 — open critical punch items across every commissioning record on the project.
  const commissionings = await db.testingCommissioning.findMany({
    where: { projectId, deletedAt: null },
    select: { punchItems: true },
  });
  const criticalPunchItems = commissionings.reduce(
    (total, row) => total + criticalPunchFrom(readPunch(row.punchItems)).length,
    0,
  );

  // §12 — service reports not yet approved.
  const unapprovedServiceReports = await db.serviceReport.count({
    where: { projectId, deletedAt: null, status: { not: "approved" } },
  });

  // §9 — tickets whose *latest* QA verdict is a rejection. An early failure followed by an approval
  // is a rework round, not an open blocker, which is the whole point of §9's counter.
  let failedQa = 0;
  for (const ticketId of ticketIds) {
    const latest = await db.qAApproval.findFirst({
      where: { ticketId, deletedAt: null },
      orderBy: { recordedAt: "desc" },
      select: { approved: true },
    });
    if (latest && !latest.approved) failedQa += 1;
  }

  // §5 — advances released and not settled.
  const unliquidatedCashAdvances =
    ticketIds.length === 0
      ? 0
      : await db.cashAdvance.count({
          where: {
            ticketId: { in: ticketIds },
            deletedAt: null,
            status: { in: ["released", "pending_settlement", "partially_liquidated"] },
          },
        });

  // §7 — returnable items issued and not back. Consumables are excluded by `outstandingCustody`.
  const custodyLines =
    ticketIds.length === 0
      ? []
      : await db.materialRequestLine.findMany({
          where: { request: { ticketId: { in: ticketIds }, deletedAt: null } },
          select: {
            id: true,
            itemType: true,
            qtyIssued: true,
            qtyReturned: true,
            qtyConsumed: true,
          },
        });
  const unreturnedTools = outstandingCustody(custodyLines as unknown as CustodyLine[]).length;

  const closeOut = await db.projectCloseOut.findUnique({ where: { projectId } });

  const checklist = closeOutChecklist({
    criticalPunchItems,
    unapprovedServiceReports,
    failedQa,
    unliquidatedCashAdvances,
    unreturnedTools,
    customerAcceptanceRequired: closeOut?.customerAcceptanceRequired ?? true,
    customerAcceptanceFileId: closeOut?.customerAcceptanceFileId,
    acceptanceWaiverReason: closeOut?.acceptanceWaiverReason,
  });

  return { project, closeOut, ...closeOutVerdict(checklist), checklist };
}

export async function upsertCloseOutService(
  actor: ActorMeta,
  input: {
    projectId: string;
    customerAcceptanceRequired?: boolean;
    customerAcceptanceFileId?: string | null;
    acceptanceDate?: Date | null;
    acceptanceWaiverReason?: string | null;
    lessonsLearned?: string | null;
    documentIds?: string[];
  },
) {
  const project = await db.project.findFirst({
    where: { id: input.projectId, deletedAt: null },
    select: { id: true, code: true },
  });
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That project no longer exists." });
  }

  const { projectId, ...rest } = input;
  const data = Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== undefined),
  ) as Prisma.ProjectCloseOutUncheckedUpdateInput;

  const saved = await db.projectCloseOut.upsert({
    where: { projectId },
    create: { ...(data as Prisma.ProjectCloseOutUncheckedCreateInput), projectId },
    update: { ...data, version: { increment: 1 } },
  });

  // Refresh the cached checklist so the screen and the record agree.
  const state = await closeOutChecklistForProjectService(projectId);
  await db.projectCloseOut.update({
    where: { projectId },
    data: { checklist: state.checklist as unknown as Prisma.InputJsonValue },
  });

  return { ...saved, ...state };
}

/**
 * Closes the project, if §12 lets it.
 *
 * §12: "Approval emits `project.closed` → module 05 releases final billing. **This is the explicit
 * handover the brief describes.**" The blockers are recomputed here rather than read from the cached
 * checklist, because the cached one is for rendering and this one bills a customer.
 */
export async function closeOutProjectService(
  actor: ActorMeta,
  input: { projectId: string; lessonsLearned?: string | null },
) {
  const state = await closeOutChecklistForProjectService(input.projectId);

  if (!state.canClose) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `Close-out is blocked. ${state.message} ` +
        state.blockers.map((entry) => `${entry.label}: ${entry.detail}`).join(" "),
    });
  }

  if (state.closeOut?.status === "approved") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That project is already closed." });
  }

  const now = new Date();

  return db.$transaction(async (tx) => {
    const closed = await tx.projectCloseOut.upsert({
      where: { projectId: input.projectId },
      create: {
        projectId: input.projectId,
        status: "approved",
        approvedById: actor.actorId,
        approvedAt: now,
        submittedById: actor.actorId,
        submittedAt: now,
        lessonsLearned: input.lessonsLearned ?? null,
        checklist: state.checklist as unknown as Prisma.InputJsonValue,
      },
      update: {
        status: "approved",
        approvedById: actor.actorId,
        approvedAt: now,
        ...(input.lessonsLearned === undefined ? {} : { lessonsLearned: input.lessonsLearned }),
        checklist: state.checklist as unknown as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    });

    await tx.project.update({
      where: { id: input.projectId },
      data: { status: "closed", version: { increment: 1 } },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "project_closed",
      entityType: CLOSE_OUT_ENTITY_TYPE,
      entityId: closed.id,
      summary:
        `${state.project.code} closed — all ${state.checklist.length} of §12's blockers clear. ` +
        "This releases final billing.",
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "project.closed",
      {
        projectId: input.projectId,
        projectCode: state.project.code,
        accountId: state.project.accountId,
        closeOutId: closed.id,
        // Module 05 bills from this. The cleared checklist travels with the event so the handover
        // says what it was based on rather than requiring a reader to reconstruct it.
        clearedBlockers: state.cleared.map((entry) => entry.key),
      },
      { actorId: actor.actorId },
    );

    return closed;
  });
}

// ---- projects, minimally, so §12's checklist has somewhere to live -------------------------------

/**
 * §12's checklist exists "so the PM can see who owns each one", which needs a screen — and until
 * this session there was no project route at all. Deliberately thin: the list and the record, not
 * §16's cost roll-up or §17's schedule.
 *
 * Contract value and budget are omitted from the list on purpose. Spec.md §4.3 gates cost and
 * margin, and a project list is exactly the screen where a technician would otherwise read them.
 */
export async function listProjectsService(filter: { status?: string } = {}) {
  const rows = await db.project.findMany({
    where: { deletedAt: null, ...(filter.status ? { status: filter.status } : {}) },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      plannedStart: true,
      plannedEnd: true,
      account: { select: { id: true, name: true } },
      closeOut: { select: { status: true, approvedAt: true } },
      _count: { select: { tickets: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows;
}

export async function getProjectService(projectId: string) {
  const project = await db.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: {
      id: true,
      code: true,
      name: true,
      description: true,
      scopeOfWork: true,
      status: true,
      plannedStart: true,
      plannedEnd: true,
      actualStart: true,
      actualEnd: true,
      account: { select: { id: true, name: true } },
      tickets: {
        where: { deletedAt: null },
        select: { id: true, number: true, title: true, status: true, type: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That project no longer exists." });
  }
  return project;
}
