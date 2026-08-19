import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { cashAdvanceGateForTicket } from "./cash-advance-service";
import { liquidationDueFrom } from "./cash-advance-rules";
import { materialGateForTicket } from "./material-request-service";
import { outstandingCustody, custodyOutstandingQty } from "./material-request-rules";
import { methodologyGateForTicket } from "./methodology-service";
import {
  CLEARANCE_STATES,
  MOBILIZATION_ENTITY_TYPE,
  demobChecklist,
  mobilizationReadiness,
  type ClearanceState,
} from "./mobilization-rules";
import { TICKET_ENTITY_TYPE } from "./ticket-rules";

/**
 * Mobilisation and demobilisation (specs/04-operations-projects.md §8).
 *
 * ## This file asks; it does not decide again
 *
 * The three gates built in sessions 2, 4 and 5 each return a verdict rather than throwing, and each
 * was written that way so §8 could call it. `readinessForTicketService` calls all three and repeats
 * none of their reasoning. If a gate's rule changes, this changes with it and nothing here needs
 * touching — which is the whole reason they were built inert rather than deferred.
 *
 * ## And it closes two loops it did not open
 *
 * §5's liquidation deadline and §7's tool-return date have both been derived from the ticket's
 * required-by date, because the real demobilisation date did not exist. `demobilizeService` supplies
 * it and corrects both — see the comments there. Those two services were written to take a date
 * rather than read one precisely so this could happen without touching them.
 */

// ---- planning -----------------------------------------------------------------------------------

export async function planMobilizationService(
  actor: ActorMeta,
  input: {
    ticketId: string;
    type: "mobilization" | "demobilization";
    plannedAt?: Date | null;
    crewIds?: string[];
    vehicleRef?: string | null;
    driverName?: string | null;
  },
) {
  const ticket = await db.ticket.findFirst({
    where: { id: input.ticketId, deletedAt: null },
    select: { id: true, number: true, projectId: true, assignedUserIds: true },
  });
  if (!ticket) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That ticket no longer exists." });
  }

  const existing = await db.mobilization.findFirst({
    where: { ticketId: ticket.id, type: input.type, deletedAt: null, status: { not: "cancelled" } },
  });
  if (existing) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${ticket.number} already has a ${input.type.replace(/_/g, " ")} planned.`,
    });
  }

  const created = await db.$transaction(async (tx) => {
    const row = await tx.mobilization.create({
      data: {
        ticketId: ticket.id,
        projectId: ticket.projectId,
        type: input.type,
        plannedAt: input.plannedAt ?? null,
        // The ticket's assigned crew is the obvious starting point, and correcting it here is one
        // edit rather than retyping a list that already exists.
        crewIds: input.crewIds ?? ticket.assignedUserIds,
        vehicleRef: input.vehicleRef ?? null,
        driverName: input.driverName ?? null,
        status: "planned",
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "planned",
      entityType: MOBILIZATION_ENTITY_TYPE,
      entityId: row.id,
      summary: `Planned the ${input.type} for ${ticket.number}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return row;
  });

  return { id: created.id, type: created.type, status: created.status };
}

export interface UpdateMobilizationInput {
  mobilizationId: string;
  plannedAt?: Date | null;
  crewIds?: string[];
  vehicleRef?: string | null;
  driverName?: string | null;
  toolsChecklist?: { label: string; checked: boolean; note?: string }[];
  ppeChecklist?: { label: string; checked: boolean; note?: string }[];
  gatePassStatus?: ClearanceState;
  permitStatus?: ClearanceState;
  inductionCompleted?: boolean;
  departureOdometer?: number | null;
  arrivalOdometer?: number | null;
  notes?: string | null;
}

export async function updateMobilizationService(actor: ActorMeta, input: UpdateMobilizationInput) {
  const row = await loadMobilization(input.mobilizationId);
  if (row.status === "returned" || row.status === "cancelled") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `This ${row.type} is ${row.status} and no longer accepts changes.`,
    });
  }

  for (const state of [input.gatePassStatus, input.permitStatus]) {
    if (state !== undefined && !CLEARANCE_STATES.includes(state)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `"${state}" is not a clearance state.` });
    }
  }

  await db.$transaction(async (tx) => {
    await tx.mobilization.update({
      where: { id: row.id },
      data: {
        ...(input.plannedAt !== undefined ? { plannedAt: input.plannedAt } : {}),
        ...(input.crewIds !== undefined ? { crewIds: input.crewIds } : {}),
        ...(input.vehicleRef !== undefined ? { vehicleRef: input.vehicleRef } : {}),
        ...(input.driverName !== undefined ? { driverName: input.driverName } : {}),
        ...(input.toolsChecklist !== undefined
          ? { toolsChecklist: input.toolsChecklist as unknown as Prisma.InputJsonValue }
          : {}),
        ...(input.ppeChecklist !== undefined
          ? { ppeChecklist: input.ppeChecklist as unknown as Prisma.InputJsonValue }
          : {}),
        ...(input.gatePassStatus !== undefined ? { gatePassStatus: input.gatePassStatus } : {}),
        ...(input.permitStatus !== undefined ? { permitStatus: input.permitStatus } : {}),
        ...(input.inductionCompleted !== undefined
          ? { inductionCompleted: input.inductionCompleted }
          : {}),
        ...(input.departureOdometer !== undefined
          ? { departureOdometer: input.departureOdometer }
          : {}),
        ...(input.arrivalOdometer !== undefined ? { arrivalOdometer: input.arrivalOdometer } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        version: { increment: 1 },
      },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "updated",
      entityType: MOBILIZATION_ENTITY_TYPE,
      entityId: row.id,
      summary: `Updated the ${row.type} for ${row.ticketId}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { id: row.id };
}

// ---- §8's readiness check -----------------------------------------------------------------------

/**
 * The green/red list, assembled from the three gates and the mobilisation record.
 *
 * The overrides are read from the **audit log**, which is where sessions 2 and 4 wrote them. That is
 * deliberate rather than convenient: an override is a decision somebody made and signed, and the
 * audit row is the signed copy. Mirroring it into a column on the ticket would create a second
 * answer to "was this overridden", and the two would eventually disagree.
 */
export async function readinessForTicketService(ticketId: string) {
  const ticket = await db.ticket.findFirst({
    where: { id: ticketId, deletedAt: null },
    select: {
      id: true,
      number: true,
      type: true,
      status: true,
      assignedUserIds: true,
      accountId: true,
      siteId: true,
    },
  });
  if (!ticket) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That ticket no longer exists." });
  }

  const [cashAdvance, materials, methodology, mobilization, overrideLogs] = await Promise.all([
    cashAdvanceGateForTicket(ticket.id),
    materialGateForTicket(ticket.id),
    methodologyGateForTicket(ticket.id),
    db.mobilization.findFirst({
      where: {
        ticketId: ticket.id,
        type: "mobilization",
        deletedAt: null,
        status: { not: "cancelled" },
      },
    }),
    db.auditLog.findMany({
      where: {
        entityType: TICKET_ENTITY_TYPE,
        entityId: ticket.id,
        action: { in: ["cash_advance_gate_overridden", "methodology_gate_overridden"] },
      },
      orderBy: { at: "desc" },
      select: { action: true, summary: true },
    }),
  ]);

  const overrides: Partial<Record<"cash_advance" | "methodology", string>> = {};
  for (const log of overrideLogs) {
    const key = log.action === "cash_advance_gate_overridden" ? "cash_advance" : "methodology";
    // Newest first, so the first one seen for a key is the one that stands.
    if (!overrides[key]) overrides[key] = log.summary;
  }

  const tools = readChecklist(mobilization?.toolsChecklist);
  const ppe = readChecklist(mobilization?.ppeChecklist);

  /**
   * "Customer contact confirmed" is taken from the site having a named contact.
   *
   * §8 lists it as a readiness item and nothing in the build records "we rang them". Reading it from
   * the site's named contact is the closest true statement available — there is somebody to ring —
   * and the detail line says exactly that rather than implying a call was made. A site with no
   * contact at all fails, which is the case actually worth catching.
   */
  const site = ticket.siteId
    ? await db.site.findUnique({
        where: { id: ticket.siteId },
        // `contactId` is deliberately not a foreign key on Site (see crm.prisma), so it is read as
        // the plain id it is, and the site's own contact list is the second way of being reachable.
        select: { contactId: true, _count: { select: { contacts: true } } },
      })
    : null;
  const customerContactConfirmed = !!site && (!!site.contactId || site._count.contacts > 0);

  const readiness = mobilizationReadiness({
    ticketType: ticket.type,
    cashAdvance,
    materials,
    methodology,
    overrides,
    crewIds: mobilization?.crewIds ?? ticket.assignedUserIds,
    gatePassStatus: mobilization?.gatePassStatus ?? "pending",
    permitStatus: mobilization?.permitStatus ?? "pending",
    inductionCompleted: mobilization?.inductionCompleted ?? false,
    toolsChecklist: tools,
    ppeChecklist: ppe,
    customerContactConfirmed,
  });

  return {
    ...readiness,
    ticket: { id: ticket.id, number: ticket.number, type: ticket.type, status: ticket.status },
    // Returned so the readiness list can send somebody to the record that answers the contact gate.
    // A gate whose evidence lives on another module's screen has to name that screen, or it reads
    // as a fault in this one.
    //
    // The **account**, not the site: sites have no page of their own, they are a panel on the
    // account record, and that is also where the contacts are added. Linking to a route that does
    // not exist would have been the same bug in a new place.
    accountId: ticket.accountId ?? null,
    mobilizationId: mobilization?.id ?? null,
    mobilizationStatus: mobilization?.status ?? null,
  };
}

// ---- going, and coming back ---------------------------------------------------------------------

/**
 * The crew leaves.
 *
 * §8: "`ready_to_mobilize` is only reachable when all mandatory items pass." So this refuses rather
 * than warns, and the refusal names what is missing — a blocked dispatch that does not say why is a
 * dispatch somebody retries.
 */
export async function departService(actor: ActorMeta, mobilizationId: string) {
  const row = await loadMobilization(mobilizationId);
  if (row.type !== "mobilization") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Only a mobilisation departs." });
  }
  if (row.status === "departed" || row.status === "on_site") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This crew has already left." });
  }

  const readiness = await readinessForTicketService(row.ticketId);
  if (!readiness.ready) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `Not ready to mobilise. ${readiness.blockers.map((b) => b.label).join("; ")}. ` +
        `Clear these, or use the override on the gate that is blocking.`,
    });
  }

  const now = new Date();

  await db.$transaction(async (tx) => {
    await tx.mobilization.update({
      where: { id: row.id },
      data: { status: "departed", actualAt: now, version: { increment: 1 } },
    });
    await tx.ticket.update({
      where: { id: row.ticketId },
      data: { status: "mobilized", version: { increment: 1 } },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "departed",
      entityType: MOBILIZATION_ENTITY_TYPE,
      entityId: row.id,
      summary: `Crew of ${row.crewIds.length} departed${row.vehicleRef ? ` in ${row.vehicleRef}` : ""}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
    await emit(
      tx,
      "ticket.mobilized",
      { ticketId: row.ticketId, mobilizationId: row.id, crew: row.crewIds.length },
      { actorId: actor.actorId },
    );
  });

  return { status: "departed" as const };
}

/** On site, and the work starts. */
export async function startWorkService(actor: ActorMeta, mobilizationId: string) {
  const row = await loadMobilization(mobilizationId);
  if (row.status !== "departed") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The crew has to have departed before they can be on site.",
    });
  }

  await db.$transaction(async (tx) => {
    await tx.mobilization.update({
      where: { id: row.id },
      data: { status: "on_site", version: { increment: 1 } },
    });
    await tx.ticket.update({
      where: { id: row.ticketId },
      data: { status: "in_progress", version: { increment: 1 } },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "on_site",
      entityType: MOBILIZATION_ENTITY_TYPE,
      entityId: row.id,
      summary: "Crew on site; work started",
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
    await emit(tx, "ticket.started", { ticketId: row.ticketId }, { actorId: actor.actorId });
  });

  return { status: "on_site" as const };
}

/**
 * The crew comes back, and §8 closes the loops.
 *
 * §8: "Demobilization closes the loop: tools returned and reconciled against the material request,
 * site cleared, customer notified, **cash advance liquidation triggered**, crew released."
 *
 * Two of those are corrections rather than new work, and they are the point of this function:
 *
 *  - **§5's liquidation deadline.** It has been three working days after the ticket's *required-by*
 *    date, because the real demobilisation date did not exist. It is now three working days after
 *    this moment, through `liquidationDueFrom` — the same function, called with the real date, which
 *    is exactly why it was written to take one.
 *  - **§7's tool-return date.** Same story: due back on demobilisation, which is now known.
 *
 * The tools are **reconciled and reported, not enforced**. A crew that lost something still has to
 * demobilise; refusing would leave the ticket open forever and the loss unrecorded, which is worse
 * than recording both.
 */
export async function demobilizeService(
  actor: ActorMeta,
  input: { mobilizationId: string; arrivalOdometer?: number | null; notes?: string | null },
) {
  const row = await loadMobilization(input.mobilizationId);
  if (row.status === "returned") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This crew has already demobilised." });
  }

  const now = new Date();

  // What is still out, so the demobilisation record says so.
  const requests = await db.materialRequest.findMany({
    where: { ticketId: row.ticketId, deletedAt: null, issuedAt: { not: null } },
    include: { lines: true },
  });
  const outstanding = requests.flatMap((request) =>
    outstandingCustody(
      request.lines.map((line) => ({
        itemType: line.itemType,
        description: line.description,
        qtyIssued: Number(line.qtyIssued),
        qtyReturned: Number(line.qtyReturned),
        qtyConsumed: Number(line.qtyConsumed),
      })),
    ).map((line) => ({ description: line.description, outstanding: custodyOutstandingQty(line) })),
  );
  const checklist = demobChecklist(outstanding);

  const advances = await db.cashAdvance.findMany({
    where: {
      ticketId: row.ticketId,
      deletedAt: null,
      status: { in: ["released", "partially_liquidated", "extended", "overdue_liquidation"] },
    },
    select: { id: true, number: true },
  });

  const liquidationDue = liquidationDueFrom(now);

  await db.$transaction(async (tx) => {
    await tx.mobilization.update({
      where: { id: row.id },
      data: {
        status: "returned",
        actualAt: row.type === "demobilization" ? now : row.actualAt,
        ...(input.arrivalOdometer !== undefined ? { arrivalOdometer: input.arrivalOdometer } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        version: { increment: 1 },
      },
    });

    // §5's deadline, from the real date at last.
    for (const advance of advances) {
      await tx.cashAdvance.update({
        where: { id: advance.id },
        data: { liquidationDueAt: liquidationDue, version: { increment: 1 } },
      });
    }

    // §7's tools are due back on demobilisation, which is now.
    await tx.materialRequest.updateMany({
      where: { ticketId: row.ticketId, deletedAt: null, returnedAt: null },
      data: { returnDueAt: now },
    });

    await tx.ticket.update({
      where: { id: row.ticketId },
      data: { status: "qa", version: { increment: 1 } },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "demobilized",
      entityType: MOBILIZATION_ENTITY_TYPE,
      entityId: row.id,
      summary:
        `Demobilised. ${checklist.message}` +
        (advances.length > 0
          ? ` Liquidation on ${advances.map((a) => a.number).join(", ")} now due ` +
            `${liquidationDue.toISOString().slice(0, 10)}.`
          : ""),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "ticket.demobilized",
      {
        ticketId: row.ticketId,
        mobilizationId: row.id,
        toolsReconciled: checklist.toolsReconciled,
        outstandingCount: checklist.outstandingCount,
        liquidationDueAt: liquidationDue.toISOString(),
      },
      { actorId: actor.actorId },
    );
  });

  return {
    status: "returned" as const,
    checklist,
    liquidationDueAt: advances.length > 0 ? liquidationDue : null,
    advances: advances.map((a) => a.number),
  };
}

// ---- reading ------------------------------------------------------------------------------------

export async function listMobilizationsService(
  filter: { ticketId?: string; status?: string } = {},
) {
  return db.mobilization.findMany({
    where: {
      deletedAt: null,
      ...(filter.ticketId ? { ticketId: filter.ticketId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    include: { ticket: { select: { id: true, number: true, title: true } } },
    orderBy: [{ plannedAt: "asc" }, { createdAt: "desc" }],
    take: 200,
  });
}

export async function getMobilizationService(mobilizationId: string) {
  const row = await db.mobilization.findFirst({
    where: { id: mobilizationId, deletedAt: null },
    include: { ticket: { select: { id: true, number: true, title: true, type: true } } },
  });
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That mobilisation no longer exists." });
  }
  return {
    ...row,
    toolsChecklist: readChecklist(row.toolsChecklist),
    ppeChecklist: readChecklist(row.ppeChecklist),
  };
}

// ---- helpers ------------------------------------------------------------------------------------

function readChecklist(raw: unknown): { label: string; checked: boolean; note?: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is { label: string; checked: boolean; note?: string } =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as { label?: unknown }).label === "string",
  );
}

async function loadMobilization(mobilizationId: string) {
  const row = await db.mobilization.findFirst({
    where: { id: mobilizationId, deletedAt: null },
  });
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That mobilisation no longer exists." });
  }
  return row;
}
