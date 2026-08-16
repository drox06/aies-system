import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import type { AuthedUser } from "@/server/core/rbac/types";
import {
  ITEM_TYPES,
  MATERIAL_REQUEST_DOCUMENT_TYPE,
  MATERIAL_REQUEST_ENTITY_TYPE,
  SOURCES,
  calibrationCheck,
  custodyOutstandingQty,
  isMaterialRequestEditable,
  issuableQuantity,
  issueStateOf,
  materialGate,
  outstandingCustody,
  purchaseLines,
  type ItemType,
  type Source,
} from "./material-request-rules";
import { materialRequestSeed } from "./methodology-rules";
import { TICKET_ENTITY_TYPE } from "./ticket-rules";

/**
 * Material requests and the store (specs/04-operations-projects.md §7).
 *
 * ## Two boundaries this file holds
 *
 * **It tracks quantity and custody, never value.** §7: "It is deliberately not the full
 * valuation-and-costing inventory system… Track quantity and custody, not weighted-average cost."
 * There is no unit cost anywhere below, and adding one would invite a valuation built on a stock
 * file nobody reconciles.
 *
 * **N/A is recorded, not skipped.** §7: "`N/A` is a legitimate, recorded answer — not a skipped
 * step. The record shows someone decided." So `markNotApplicable` is a real call that writes an
 * audit row, and the gate treats an unanswered ticket as blocked rather than as a no.
 */

// ---- raising ------------------------------------------------------------------------------------

export interface MaterialLineInput {
  itemType: ItemType;
  stockItemId?: string | null;
  description: string;
  quantity: number;
  unit: string;
  source: Source;
  notes?: string | null;
}

export interface CreateMaterialRequestInput {
  ticketId: string;
  projectId?: string | null;
  neededBy?: Date | null;
  lines?: MaterialLineInput[];
  /** §6.2: the method statement's tools and materials pre-populate this. */
  fromMethodologyId?: string | null;
}

/**
 * Raises a request, optionally starting from the method statement.
 *
 * §6.2: "The tools and materials lists here **pre-populate the material request** in §7. Nobody
 * should type the same list twice." `materialRequestSeed` was written and tested in session 4
 * precisely so this session had one reading of those two columns rather than a second one.
 *
 * The seeded lines arrive as `source = "stock"` because that is the common case and the storeman
 * corrects it — a guess that is usually right and always visible beats a blank that is always wrong.
 */
export async function createMaterialRequestService(
  actor: ActorMeta,
  input: CreateMaterialRequestInput,
) {
  const ticket = await db.ticket.findFirst({
    where: { id: input.ticketId, deletedAt: null },
    select: { id: true, number: true, projectId: true, requiredByDate: true },
  });
  if (!ticket) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That ticket no longer exists." });
  }

  let lines = input.lines ?? [];

  if (input.fromMethodologyId) {
    const methodology = await db.methodology.findFirst({
      where: { id: input.fromMethodologyId, deletedAt: null },
      select: { toolsRequired: true, materialsRequired: true },
    });
    if (!methodology) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "That method statement no longer exists.",
      });
    }
    const seeded = materialRequestSeed(methodology).map((line) => ({
      // Tools arrive as tools so the custody list works; anything else is a consumable until
      // somebody says otherwise.
      itemType: (line.unit === "set" ? "tool" : "consumable") as ItemType,
      description: line.description,
      quantity: Number(line.quantity) || 1,
      unit: line.unit,
      source: "stock" as Source,
    }));
    lines = [...lines, ...seeded];
  }

  const bad = lines.find(
    (line) =>
      !ITEM_TYPES.includes(line.itemType) || !SOURCES.includes(line.source) || line.quantity <= 0,
  );
  if (bad) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `"${bad.description}" has an unknown type, an unknown source, or no quantity.`,
    });
  }

  const number = await allocateNumber(MATERIAL_REQUEST_DOCUMENT_TYPE);

  const created = await db.$transaction(async (tx) => {
    const request = await tx.materialRequest.create({
      data: {
        number,
        ticketId: ticket.id,
        projectId: input.projectId ?? ticket.projectId,
        requestedById: actor.actorId,
        neededBy: input.neededBy ?? ticket.requiredByDate,
        status: "draft",
        lines: {
          create: lines.map((line, index) => ({
            lineNo: index + 1,
            itemType: line.itemType,
            stockItemId: line.stockItemId ?? null,
            description: line.description,
            quantity: new Prisma.Decimal(line.quantity),
            unit: line.unit,
            source: line.source,
            notes: line.notes ?? null,
          })),
        },
      },
      include: { lines: true },
    });

    // The ticket stops being unanswered the moment somebody raises a request.
    await tx.ticket.update({
      where: { id: ticket.id },
      data: { materialRequestStatus: "required", version: { increment: 1 } },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "created",
      entityType: MATERIAL_REQUEST_ENTITY_TYPE,
      entityId: request.id,
      summary: `Raised ${number} for ${ticket.number} — ${request.lines.length} line(s)`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return request;
  });

  return { id: created.id, number: created.number, lines: created.lines.length };
}

/**
 * §7's middle answer: this ticket needs nothing.
 *
 * "`N/A` is a legitimate, recorded answer — not a skipped step. **The record shows someone
 * decided.**" Which is why this is a call that writes an audit row rather than a field somebody
 * leaves alone: the audit row names who decided and when, and that is the entire difference between
 * a considered no and a question nobody asked.
 */
export async function markMaterialsNotApplicableService(
  actor: ActorMeta,
  input: { ticketId: string; note?: string },
) {
  const ticket = await db.ticket.findFirst({
    where: { id: input.ticketId, deletedAt: null },
    select: { id: true, number: true, materialRequestStatus: true },
  });
  if (!ticket) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That ticket no longer exists." });
  }

  const live = await db.materialRequest.count({
    where: { ticketId: ticket.id, deletedAt: null, status: { notIn: ["cancelled", "rejected"] } },
  });
  if (live > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This ticket already has a material request. Cancel it before recording that none are " +
        "needed, so the two answers cannot disagree.",
    });
  }

  await db.$transaction(async (tx) => {
    await tx.ticket.update({
      where: { id: ticket.id },
      data: { materialRequestStatus: "not_applicable", version: { increment: 1 } },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "materials_not_applicable",
      entityType: TICKET_ENTITY_TYPE,
      entityId: ticket.id,
      summary:
        `Recorded that ${ticket.number} needs no materials` +
        (input.note ? ` — ${input.note}` : ""),
      diff: { materialRequestStatus: { from: ticket.materialRequestStatus, to: "not_applicable" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { materialRequestStatus: "not_applicable" as const };
}

// ---- approval -----------------------------------------------------------------------------------

export async function submitMaterialRequestService(actor: ActorMeta, requestId: string) {
  const request = await loadRequest(requestId);
  if (request.status !== "draft") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${request.number} is ${request.status.replace(/_/g, " ")}, not a draft.`,
    });
  }
  if (request.lines.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${request.number} has no lines, so there is nothing to approve.`,
    });
  }

  await db.$transaction(async (tx) => {
    await tx.materialRequest.update({
      where: { id: request.id },
      data: { status: "pending_approval", version: { increment: 1 } },
    });
    await tx.ticket.update({
      where: { id: request.ticketId },
      data: { materialRequestStatus: "requested", version: { increment: 1 } },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "submitted",
      entityType: MATERIAL_REQUEST_ENTITY_TYPE,
      entityId: request.id,
      summary: `Submitted ${request.number} for approval`,
      diff: { status: { from: "draft", to: "pending_approval" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
    await emit(
      tx,
      "material_request.raised",
      {
        materialRequestId: request.id,
        number: request.number,
        ticketId: request.ticketId,
        lines: request.lines.length,
      },
      { actorId: actor.actorId },
    );
  });

  return { status: "pending_approval" as const };
}

/**
 * Approves or refuses, and hands the purchase lines to module 03.
 *
 * §7: "Lines with `source = purchase` emit `material.purchase_required` → module 03 raises a
 * purchase request. **The ticket sits at `material_pending` until resolved.**"
 */
export async function approveMaterialRequestService(
  actor: ActorMeta,
  input: { requestId: string; decision: "approved" | "rejected"; reason?: string },
) {
  const request = await loadRequest(input.requestId);
  if (request.status !== "pending_approval") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${request.number} is ${request.status.replace(/_/g, " ")}, so there is nothing to decide.`,
    });
  }
  if (input.decision === "rejected" && !input.reason?.trim()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Say why. A refused request without a reason is one the crew cannot correct.",
    });
  }

  const approved = input.decision === "approved";
  const toBuy = purchaseLines(request.lines);

  await db.$transaction(async (tx) => {
    await tx.materialRequest.update({
      where: { id: request.id },
      data: {
        status: approved ? (toBuy.length > 0 ? "purchased" : "approved") : "rejected",
        approvedById: approved ? actor.actorId : null,
        approvedAt: approved ? new Date() : null,
        rejectionReason: approved ? null : (input.reason ?? null),
        version: { increment: 1 },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: approved ? "approved" : "rejected",
      entityType: MATERIAL_REQUEST_ENTITY_TYPE,
      entityId: request.id,
      summary: approved
        ? `Approved ${request.number}` +
          (toBuy.length > 0 ? ` — ${toBuy.length} line(s) need buying` : "")
        : `Refused ${request.number} — ${input.reason}`,
      diff: { status: { from: "pending_approval", to: input.decision } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    if (approved && toBuy.length > 0) {
      await emit(
        tx,
        "material.purchase_required",
        {
          materialRequestId: request.id,
          number: request.number,
          ticketId: request.ticketId,
          lines: toBuy.map((line) => ({
            description: line.description,
            quantity: line.quantity.toString(),
            unit: line.unit,
            itemType: line.itemType,
          })),
        },
        { actorId: actor.actorId },
      );
    }
  });

  return { status: approved ? (toBuy.length > 0 ? "purchased" : "approved") : "rejected" };
}

// ---- the store ----------------------------------------------------------------------------------

export interface IssueInput {
  requestId: string;
  lines: { lineNo: number; quantity: number; calibrationAssetId?: string | null }[];
}

/**
 * Hands the materials over, moves the stock, and refuses an instrument that is out of calibration.
 *
 * §7: "Drawing an overdue-calibration instrument is blocked." See `calibrationCheck` for why this is
 * the one hard block in a build that otherwise prefers warnings — a measurement from an
 * out-of-calibration instrument is not a worse number, it is a number with no standing, and it ends
 * up on a service report the customer keeps.
 */
export async function issueMaterialsService(actor: ActorMeta, input: IssueInput) {
  const request = await loadRequest(input.requestId);
  if (request.status !== "approved" && request.status !== "partially_issued") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${request.number} is ${request.status.replace(/_/g, " ")}. Only an approved request can ` +
        `be issued.`,
    });
  }

  const now = new Date();

  // Every check before any write: a half-issued request whose second line was refused would leave
  // the store's count wrong and nobody looking for it.
  for (const issue of input.lines) {
    const line = request.lines.find((l) => l.lineNo === issue.lineNo);
    if (!line) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `${request.number} has no line ${issue.lineNo}.`,
      });
    }
    const remaining = issuableQuantity({
      quantity: Number(line.quantity),
      qtyIssued: Number(line.qtyIssued),
    });
    if (issue.quantity > remaining) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          `Line ${issue.lineNo} (${line.description}) has ${remaining} ${line.unit} left to issue, ` +
          `not ${issue.quantity}.`,
      });
    }

    if (line.stockItemId) {
      const item = await db.stockItem.findFirst({
        where: { id: line.stockItemId, deletedAt: null },
        select: { name: true, calibrationDueAt: true, qtyOnHand: true },
      });
      const check = calibrationCheck(item, line.itemType, now);
      if (check.blocked) {
        throw new TRPCError({ code: "BAD_REQUEST", message: check.message });
      }
      if (item && Number(item.qtyOnHand) < issue.quantity) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            `The store has ${item.qtyOnHand.toString()} ${line.unit} of ${item.name}, not ` +
            `${issue.quantity}. Issue what is there, or the count stops meaning anything.`,
        });
      }
    }
  }

  const updated = await db.$transaction(async (tx) => {
    for (const issue of input.lines) {
      const line = request.lines.find((l) => l.lineNo === issue.lineNo)!;
      const nextIssued = Number(line.qtyIssued) + issue.quantity;

      await tx.materialRequestLine.update({
        where: { id: line.id },
        data: {
          qtyIssued: new Prisma.Decimal(nextIssued),
          status: nextIssued >= Number(line.quantity) ? "issued" : "pending",
          ...(issue.calibrationAssetId !== undefined
            ? { calibrationAssetId: issue.calibrationAssetId }
            : {}),
        },
      });

      if (line.stockItemId) {
        await tx.stockItem.update({
          where: { id: line.stockItemId },
          data: { qtyOnHand: { decrement: new Prisma.Decimal(issue.quantity) } },
        });
        await tx.stockMovement.create({
          data: {
            stockItemId: line.stockItemId,
            type: "issue",
            quantity: new Prisma.Decimal(-issue.quantity),
            ticketId: request.ticketId,
            requestId: request.id,
            reference: `${request.number} line ${line.lineNo}`,
            byId: actor.actorId,
          },
        });
      }
    }

    const fresh = await tx.materialRequestLine.findMany({
      where: { requestId: request.id },
      select: { lineNo: true, quantity: true, qtyIssued: true },
    });
    const status = issueStateOf(
      fresh.map((l) => ({
        lineNo: l.lineNo,
        quantity: Number(l.quantity),
        qtyIssued: Number(l.qtyIssued),
      })),
    );

    const ticket = await tx.ticket.findUniqueOrThrow({
      where: { id: request.ticketId },
      select: { requiredByDate: true },
    });

    await tx.materialRequest.update({
      where: { id: request.id },
      data: {
        status,
        issuedById: actor.actorId,
        issuedAt: now,
        // §7 tracks return on demobilisation, which is §8's. The ticket's required-by date is the
        // closest honest proxy until §8 corrects it.
        returnDueAt: request.returnDueAt ?? ticket.requiredByDate,
        version: { increment: 1 },
      },
    });

    await tx.ticket.update({
      where: { id: request.ticketId },
      data: {
        materialRequestStatus: status === "issued" ? "issued" : "partial",
        version: { increment: 1 },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: status === "issued" ? "issued" : "partially_issued",
      entityType: MATERIAL_REQUEST_ENTITY_TYPE,
      entityId: request.id,
      summary: `Issued ${input.lines.length} line(s) against ${request.number}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "material.issued",
      {
        materialRequestId: request.id,
        number: request.number,
        ticketId: request.ticketId,
        fullyIssued: status === "issued",
      },
      { actorId: actor.actorId },
    );

    return status;
  });

  return { status: updated };
}

/**
 * Takes the tools back (§7).
 *
 * §7: "Unreturned tools appear on an outstanding-custody list per technician. **Tools disappear
 * otherwise; this is universal.**" Returned quantity goes back into stock; consumed quantity does
 * not, because it no longer exists.
 */
export async function returnMaterialsService(
  actor: ActorMeta,
  input: {
    requestId: string;
    lines: { lineNo: number; returned?: number; consumed?: number }[];
  },
) {
  const request = await loadRequest(input.requestId);

  for (const entry of input.lines) {
    const line = request.lines.find((l) => l.lineNo === entry.lineNo);
    if (!line) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `${request.number} has no line ${entry.lineNo}.`,
      });
    }
    const accountedFor =
      Number(line.qtyReturned) +
      Number(line.qtyConsumed) +
      (entry.returned ?? 0) +
      (entry.consumed ?? 0);
    if (accountedFor > Number(line.qtyIssued)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          `Line ${entry.lineNo} (${line.description}) had ${line.qtyIssued.toString()} issued. ` +
          `Returning and consuming more than that would make the custody list wrong.`,
      });
    }
  }

  await db.$transaction(async (tx) => {
    for (const entry of input.lines) {
      const line = request.lines.find((l) => l.lineNo === entry.lineNo)!;
      const returned = entry.returned ?? 0;
      const consumed = entry.consumed ?? 0;

      await tx.materialRequestLine.update({
        where: { id: line.id },
        data: {
          qtyReturned: { increment: new Prisma.Decimal(returned) },
          qtyConsumed: { increment: new Prisma.Decimal(consumed) },
          status:
            Number(line.qtyReturned) + returned + Number(line.qtyConsumed) + consumed >=
            Number(line.qtyIssued)
              ? consumed > 0
                ? "consumed"
                : "returned"
              : line.status,
        },
      });

      if (line.stockItemId && returned > 0) {
        await tx.stockItem.update({
          where: { id: line.stockItemId },
          data: { qtyOnHand: { increment: new Prisma.Decimal(returned) } },
        });
        await tx.stockMovement.create({
          data: {
            stockItemId: line.stockItemId,
            type: "return",
            quantity: new Prisma.Decimal(returned),
            ticketId: request.ticketId,
            requestId: request.id,
            reference: `${request.number} line ${line.lineNo}`,
            byId: actor.actorId,
          },
        });
      }

      if (line.stockItemId && consumed > 0) {
        // Consumed stock does not come back. The movement is recorded anyway so `qtyOnHand` stays
        // explainable — the issue already took it out, this says where it went.
        await tx.stockMovement.create({
          data: {
            stockItemId: line.stockItemId,
            type: "consume",
            quantity: new Prisma.Decimal(0),
            ticketId: request.ticketId,
            requestId: request.id,
            reference: `${request.number} line ${line.lineNo} consumed on site`,
            byId: actor.actorId,
          },
        });
      }
    }

    const fresh = await tx.materialRequestLine.findMany({
      where: { requestId: request.id },
      select: { itemType: true, qtyIssued: true, qtyReturned: true, qtyConsumed: true },
    });
    const stillOut = outstandingCustody(
      fresh.map((l) => ({
        itemType: l.itemType,
        description: "",
        qtyIssued: Number(l.qtyIssued),
        qtyReturned: Number(l.qtyReturned),
        qtyConsumed: Number(l.qtyConsumed),
      })),
    );

    await tx.materialRequest.update({
      where: { id: request.id },
      data: { returnedAt: stillOut.length === 0 ? new Date() : null, version: { increment: 1 } },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "returned",
      entityType: MATERIAL_REQUEST_ENTITY_TYPE,
      entityId: request.id,
      summary:
        `Recorded returns against ${request.number}` +
        (stillOut.length > 0
          ? ` — ${stillOut.length} line(s) still out`
          : " — nothing outstanding"),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { settled: true as const };
}

// ---- reading ------------------------------------------------------------------------------------

/** §1's Gate 2 for one ticket. §8's mobilization will call exactly this. */
export async function materialGateForTicket(ticketId: string) {
  const ticket = await db.ticket.findFirst({
    where: { id: ticketId, deletedAt: null },
    select: {
      id: true,
      number: true,
      materialRequestStatus: true,
      materialRequests: {
        where: { deletedAt: null },
        select: { id: true, number: true, status: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!ticket) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That ticket no longer exists." });
  }

  return { ...materialGate(ticket, ticket.materialRequests), requests: ticket.materialRequests };
}

export async function getMaterialRequestService(requestId: string) {
  const request = await db.materialRequest.findFirst({
    where: { id: requestId, deletedAt: null },
    include: {
      lines: { orderBy: { lineNo: "asc" }, include: { stockItem: true } },
      ticket: { select: { id: true, number: true, title: true } },
    },
  });
  if (!request) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That material request no longer exists." });
  }

  return {
    ...request,
    editable: isMaterialRequestEditable(request.status),
    lines: request.lines.map((line) => ({
      ...line,
      quantity: line.quantity.toString(),
      qtyIssued: line.qtyIssued.toString(),
      qtyReturned: line.qtyReturned.toString(),
      qtyConsumed: line.qtyConsumed.toString(),
      outstanding: custodyOutstandingQty({
        itemType: line.itemType,
        description: line.description,
        qtyIssued: Number(line.qtyIssued),
        qtyReturned: Number(line.qtyReturned),
        qtyConsumed: Number(line.qtyConsumed),
      }),
      calibration: calibrationCheck(line.stockItem, line.itemType),
    })),
  };
}

export async function listMaterialRequestsService(
  filter: { ticketId?: string; status?: string } = {},
) {
  return db.materialRequest.findMany({
    where: {
      deletedAt: null,
      ...(filter.ticketId ? { ticketId: filter.ticketId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    include: {
      ticket: { select: { id: true, number: true, title: true } },
      _count: { select: { lines: true } },
    },
    orderBy: [{ neededBy: "asc" }, { createdAt: "desc" }],
    take: 200,
  });
}

/**
 * §7's outstanding-custody list, per person.
 *
 * "Unreturned tools appear on an outstanding-custody list per technician. Tools disappear
 * otherwise; this is universal." Grouped by whoever the request was raised for, because that is who
 * somebody has to go and ask.
 */
export async function outstandingCustodyService() {
  const requests = await db.materialRequest.findMany({
    where: { deletedAt: null, issuedAt: { not: null }, returnedAt: null },
    include: {
      lines: true,
      ticket: { select: { id: true, number: true, title: true } },
    },
  });

  const rows = requests.flatMap((request) => {
    const out = outstandingCustody(
      request.lines.map((line) => ({
        itemType: line.itemType,
        description: line.description,
        qtyIssued: Number(line.qtyIssued),
        qtyReturned: Number(line.qtyReturned),
        qtyConsumed: Number(line.qtyConsumed),
      })),
    );
    return out.map((line) => ({
      requestId: request.id,
      number: request.number,
      requestedById: request.requestedById,
      ticket: request.ticket,
      returnDueAt: request.returnDueAt,
      itemType: line.itemType,
      description: line.description,
      outstanding: custodyOutstandingQty(line),
    }));
  });

  return rows;
}

// ---- the store's own records --------------------------------------------------------------------

export async function listStockService(user: AuthedUser, filter: { search?: string } = {}) {
  void user;
  return db.stockItem.findMany({
    where: {
      deletedAt: null,
      ...(filter.search
        ? {
            OR: [
              { name: { contains: filter.search, mode: "insensitive" as const } },
              { sku: { contains: filter.search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: [{ category: "asc" }, { name: "asc" }],
    take: 300,
  });
}

export async function upsertStockItemService(
  actor: ActorMeta,
  input: {
    id?: string | null;
    sku: string;
    name: string;
    category: string;
    unit: string;
    qtyOnHand?: number;
    reorderLevel?: number;
    location?: string | null;
    calibrationDueAt?: Date | null;
  },
) {
  const data = {
    sku: input.sku.trim(),
    name: input.name.trim(),
    category: input.category,
    unit: input.unit,
    reorderLevel: new Prisma.Decimal(input.reorderLevel ?? 0),
    location: input.location ?? null,
    calibrationDueAt: input.calibrationDueAt ?? null,
  };

  const item = input.id
    ? await db.stockItem.update({ where: { id: input.id }, data })
    : await db.stockItem.create({
        data: { ...data, qtyOnHand: new Prisma.Decimal(input.qtyOnHand ?? 0) },
      });

  await db.$transaction(async (tx) => {
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: input.id ? "updated" : "created",
      entityType: "StockItem",
      entityId: item.id,
      summary: `${input.id ? "Updated" : "Added"} stock item ${item.sku} — ${item.name}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { id: item.id, sku: item.sku };
}

/**
 * A counted correction, with the count recorded as a movement.
 *
 * §7 asks for `lastCountedAt`, and the reason to record the movement as well as the new figure is
 * the same one the movement table exists for: a quantity that changed with no row explaining it is
 * indistinguishable from stock walking out of the door.
 */
export async function adjustStockService(
  actor: ActorMeta,
  input: { stockItemId: string; countedQty: number; reference?: string },
) {
  const item = await db.stockItem.findFirst({
    where: { id: input.stockItemId, deletedAt: null },
  });
  if (!item) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That stock item no longer exists." });
  }

  const delta = input.countedQty - Number(item.qtyOnHand);

  await db.$transaction(async (tx) => {
    await tx.stockItem.update({
      where: { id: item.id },
      data: {
        qtyOnHand: new Prisma.Decimal(input.countedQty),
        lastCountedAt: new Date(),
        version: { increment: 1 },
      },
    });
    await tx.stockMovement.create({
      data: {
        stockItemId: item.id,
        type: "adjustment",
        quantity: new Prisma.Decimal(delta),
        reference: input.reference ?? "Stock count",
        byId: actor.actorId,
      },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "counted",
      entityType: "StockItem",
      entityId: item.id,
      summary:
        `Counted ${item.sku}: ${item.qtyOnHand.toString()} → ${input.countedQty} ` +
        `(${delta >= 0 ? "+" : ""}${delta})`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { qtyOnHand: input.countedQty };
}

// ---- helpers ------------------------------------------------------------------------------------

async function loadRequest(requestId: string) {
  const request = await db.materialRequest.findFirst({
    where: { id: requestId, deletedAt: null },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  if (!request) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That material request no longer exists." });
  }
  return request;
}
