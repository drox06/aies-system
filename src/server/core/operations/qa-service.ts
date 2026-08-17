import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import { registerFileAccessChecker } from "@/server/core/storage/access";
import {
  QA_DOCUMENT_TYPE,
  QA_ENTITY_TYPE,
  checkQaRecord,
  firstTimeRightRate,
  ncrWorthyDefects,
  qaOutcome,
  type Defect,
  type EvidenceType,
} from "./qa-rules";

/**
 * Client QA (specs/04-operations-projects.md §9).
 *
 * §9: "**QA is performed and approved by the client, not by AIES.**" Which means this service never
 * decides anything about the work. It records what the customer said and files what they produced,
 * and the one rule it enforces hard is that an approval must be backed by something they produced.
 *
 * ## The rework loop is literal
 *
 * §9: "The flowchart's QA diamond loops failures back to Project Execution — **implement that
 * literally**." A failure puts the ticket back to `in_progress` and increments the round. There is
 * no intermediate review state, because the flowchart does not draw one and inventing one would put
 * a step between the client's rejection and the crew going back.
 */

/**
 * The client's own documentation is readable by anyone who can see the ticket.
 *
 * Registered here and listed in register-checkers.ts — docs/DECISIONS.md #60 for why the second half
 * is not optional.
 */
registerFileAccessChecker(QA_ENTITY_TYPE, async (user) => {
  return user.permissions.has("ticket.view") || user.permissions.has("ticket.view_all");
});

export interface RecordQaInput {
  ticketId: string;
  approved: boolean;
  clientInspected?: boolean;
  inspectedAt?: Date | null;
  clientInspectorName?: string | null;
  clientInspectorPosition?: string | null;
  evidenceFileIds?: string[];
  evidenceType?: EvidenceType | null;
  remarks?: string | null;
  defects?: Defect[];
}

/**
 * Records the client's verdict.
 *
 * The evidence block is enforced here and not only in the form, because §9 calls it a hard block and
 * a rule that lives in a React component is a rule anybody with a network tab can skip.
 */
export async function recordQaService(actor: ActorMeta, input: RecordQaInput) {
  const ticket = await db.ticket.findFirst({
    where: { id: input.ticketId, deletedAt: null },
    select: { id: true, number: true, projectId: true, status: true },
  });
  if (!ticket) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That ticket no longer exists." });
  }

  const defects = input.defects ?? [];
  const check = checkQaRecord({
    approved: input.approved,
    clientInspected: input.clientInspected ?? true,
    evidenceFileIds: input.evidenceFileIds ?? [],
    evidenceType: input.evidenceType,
    defects,
    remarks: input.remarks,
  });
  if (!check.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: check.errors.join(" ") });
  }

  // How many rounds this ticket has already been through — the counter §9 wants reported.
  const previous = await db.qAApproval.aggregate({
    where: { ticketId: ticket.id, deletedAt: null },
    _max: { reworkRound: true },
  });
  const previousRounds = previous._max.reworkRound ?? 0;

  const outcome = qaOutcome({ approved: input.approved, previousRounds, defects });
  const number = await allocateNumber(QA_DOCUMENT_TYPE);

  const record = await db.$transaction(async (tx) => {
    const created = await tx.qAApproval.create({
      data: {
        number,
        ticketId: ticket.id,
        projectId: ticket.projectId,
        approved: input.approved,
        clientInspected: input.clientInspected ?? true,
        inspectedAt: input.inspectedAt ?? new Date(),
        clientInspectorName: input.clientInspectorName ?? null,
        clientInspectorPosition: input.clientInspectorPosition ?? null,
        recordedById: actor.actorId,
        evidenceFileIds: input.evidenceFileIds ?? [],
        evidenceType: input.evidenceType ?? null,
        remarks: input.remarks ?? null,
        defects: defects as unknown as Prisma.InputJsonValue,
        reworkRound: outcome.reworkRound,
      },
    });

    await tx.ticket.update({
      where: { id: ticket.id },
      data: { status: outcome.ticketStatus, version: { increment: 1 } },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: input.approved ? "qa_approved" : "qa_failed",
      entityType: QA_ENTITY_TYPE,
      entityId: created.id,
      summary:
        `${number} on ${ticket.number}: client ${input.approved ? "approved" : "rejected"} the work` +
        (input.clientInspected === false ? " (no inspection took place)" : "") +
        `. ${outcome.message}`,
      diff: { status: { from: ticket.status, to: outcome.ticketStatus } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      input.approved ? "qa.passed" : "qa.failed",
      {
        qaApprovalId: created.id,
        number,
        ticketId: ticket.id,
        projectId: ticket.projectId,
        reworkRound: outcome.reworkRound,
        // Module 08 raises the NCR when it exists; the payload carries what it needs rather than
        // making it re-read the defects and re-decide which ones qualify.
        ncrWorthy: ncrWorthyDefects(defects).map((defect) => ({
          description: defect.description,
          severity: defect.severity,
        })),
      },
      { actorId: actor.actorId },
    );

    return created;
  });

  return {
    id: record.id,
    number: record.number,
    ticketStatus: outcome.ticketStatus,
    reworkRound: outcome.reworkRound,
    message: outcome.message,
    warnings: check.warnings,
  };
}

// ---- reading ------------------------------------------------------------------------------------

export async function listQaForTicketService(ticketId: string) {
  const rows = await db.qAApproval.findMany({
    where: { ticketId, deletedAt: null },
    orderBy: { recordedAt: "desc" },
  });

  const latest = rows[0] ?? null;

  return {
    rows: rows.map((row) => ({ ...row, defects: readDefects(row.defects) })),
    latest: latest ? { ...latest, defects: readDefects(latest.defects) } : null,
    /** Open defects across every round — approval is not closure (§9's punch list). */
    openDefects: rows.flatMap((row) =>
      readDefects(row.defects).filter((defect) => defect.status !== "closed"),
    ),
    reworkRounds: rows.reduce((max, row) => Math.max(max, row.reworkRound), 0),
  };
}

/**
 * §9's first-time-right rate.
 *
 * Exported on its own because module 09 will want it and because the number is worth having before
 * module 09 exists — §9 calls it "the quality metric that matters most and is currently
 * unmeasurable", and it stops being unmeasurable the moment these records exist.
 */
export async function firstTimeRightService(filter: { projectId?: string } = {}) {
  const rows = await db.qAApproval.findMany({
    where: { deletedAt: null, ...(filter.projectId ? { projectId: filter.projectId } : {}) },
    select: { approved: true, reworkRound: true },
  });
  return firstTimeRightRate(rows);
}

function readDefects(raw: unknown): Defect[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is Defect =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as { description?: unknown }).description === "string",
  );
}
