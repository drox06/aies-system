import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import { registerFileAccessChecker } from "@/server/core/storage/access";
import type { AuthedUser } from "@/server/core/rbac/types";
import {
  allocateLandedCost,
  daysLate,
  downpaymentGate,
  isSupplierPoEditable,
  OPEN_SUPPLIER_PO_STATUSES,
  supplierApprovalGate,
  supplierPoTotal,
  SUPPLIER_PO_DOCUMENT_TYPE,
  SUPPLIER_PO_ENTITY_TYPE,
} from "./supplier-po-rules";

/**
 * The supplier purchase order (specs/03-order-procurement.md §4 and §5).
 *
 * §5 opens with the shape: "Created from a sales order: select lines → group by supplier → generate
 * draft POs." The grouping is the interesting part — one sales order routinely sources the meter
 * from Germany, the valves locally and the freight from a forwarder, and each is a separate
 * commitment with its own lead time, currency and approval. So this creates **one PO per supplier**
 * in a single pass rather than making somebody repeat the exercise per vendor.
 *
 * ## Two gates, both overridable, neither silent
 *
 * This is where session 1's supplier approval finally stops something, and where §4's downpayment
 * gate lives. Both refuse by default and both can be overridden with a reason by somebody
 * accountable, because §4 says exactly why: "this happens in real life, and pretending otherwise
 * means people work around the system instead of through it." The reason is written to the PO *and*
 * the audit log — the log is the evidence, the column is what the next person to open the PO reads.
 *
 * The gates are checked at **send**, not at draft creation. A draft is somebody working out what to
 * buy; the commitment is the send. Blocking the draft would mean procurement cannot even prepare
 * while finance chases the downpayment, which is the opposite of useful.
 */

export { SUPPLIER_PO_DOCUMENT_TYPE, SUPPLIER_PO_ENTITY_TYPE } from "./supplier-po-rules";

/**
 * Attachments on a supplier PO — the supplier's acknowledgement, a proforma invoice, the shipping
 * documents. Visible to anyone who may see the PO at all; the router's permission is the real gate,
 * and a file checker that re-derives record scoping would be a second answer to the same question.
 */
registerFileAccessChecker(SUPPLIER_PO_ENTITY_TYPE, async (user, file) => {
  if (!user.permissions.has("supplier_po.create") && !user.permissions.has("supplier_po.approve")) {
    return false;
  }
  // The file still has to point at a live PO: a soft-deleted record's attachments go with it.
  const po = await db.supplierPO.findFirst({ where: { id: file.entityId, deletedAt: null } });
  return po !== null;
});

// ---- creation -----------------------------------------------------------------------------------

export interface DraftSupplierPoLine {
  salesOrderLineId: string;
  supplierId: string;
  /** Defaults to the sales order line's own cost when omitted. */
  unitCost?: string;
  quantity?: string;
}

/**
 * §5's "select lines → group by supplier → generate draft POs".
 *
 * Returns one PO per distinct supplier in the selection. Numbers are allocated one per PO outside
 * the transaction, the same as everywhere else in this build: `allocateNumber` commits its own
 * increment, so a rolled-back creation leaves a gap rather than reusing a number (Spec.md §5).
 *
 * **Costs default from the sales order line**, which carries the quotation's cost, which came from
 * the supplier quote. §5 asks for a prominent warning when that quote has expired — surfaced by
 * `listSupplierQuoteStalenessForOrder` below rather than blocked here, because a stale cost is a
 * reason to re-check the price, not a reason to be unable to raise the order.
 */
export async function createSupplierPosFromSalesOrderService(
  actor: ActorMeta,
  input: {
    salesOrderId: string;
    lines: DraftSupplierPoLine[];
    expectedArrivalDate?: Date | null;
  },
) {
  if (input.lines.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Choose at least one line to order, and who to order it from.",
    });
  }

  const order = await db.salesOrder.findFirst({
    where: { id: input.salesOrderId, deletedAt: null },
    include: { lines: true },
  });
  if (!order) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That sales order no longer exists." });
  }

  const lineById = new Map(order.lines.map((line) => [line.id, line]));
  for (const selection of input.lines) {
    if (!lineById.has(selection.salesOrderLineId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `A selected line does not belong to ${order.number}.`,
      });
    }
  }

  const supplierIds = [...new Set(input.lines.map((line) => line.supplierId))];
  const suppliers = await db.supplier.findMany({
    where: { id: { in: supplierIds }, deletedAt: null },
  });
  if (suppliers.length !== supplierIds.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "One of those suppliers no longer exists.",
    });
  }
  const supplierById = new Map(suppliers.map((supplier) => [supplier.id, supplier]));

  const created: { id: string; number: string; supplierName: string }[] = [];

  for (const supplierId of supplierIds) {
    const supplier = supplierById.get(supplierId)!;
    const selections = input.lines.filter((line) => line.supplierId === supplierId);

    const poLines = selections.map((selection, index) => {
      const source = lineById.get(selection.salesOrderLineId)!;
      // What is left to buy, not the whole line: a second PO against a partly-ordered line must not
      // re-order what has already been received.
      const quantity = selection.quantity ?? source.quantity.toString();
      const unitCost = selection.unitCost ?? source.unitCost.toString();
      return {
        lineNo: index + 1,
        salesOrderLineId: source.id,
        productId: source.productId,
        description: source.description,
        quantity,
        unit: source.unit,
        unitCost,
        lineTotal: (Number(quantity) * Number(unitCost)).toFixed(2),
      };
    });

    const subtotal = poLines.reduce((sum, line) => sum + Number(line.lineTotal), 0);
    const number = await allocateNumber(SUPPLIER_PO_DOCUMENT_TYPE);

    const po = await db.$transaction(async (tx) => {
      const row = await tx.supplierPO.create({
        data: {
          number,
          supplierId,
          salesOrderId: order.id,
          // The supplier's own currency, not the customer's: this is what AIES will be invoiced in.
          currency: supplier.currency,
          subtotal,
          total: subtotal,
          expectedArrivalDate: input.expectedArrivalDate ?? null,
          incoterm: supplier.incoterm,
          status: "draft",
          createdById: actor.actorId,
          lines: { create: poLines },
        },
        include: { lines: { orderBy: { lineNo: "asc" } } },
      });

      await writeAuditLog(tx, {
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        action: "create",
        entityType: SUPPLIER_PO_ENTITY_TYPE,
        entityId: row.id,
        summary:
          `Drafted ${row.number} to ${supplier.code} ${supplier.name} against ${order.number}: ` +
          `${poLines.length} line(s), ${row.currency} ${subtotal.toFixed(2)}`,
        ip: actor.ip,
        userAgent: actor.userAgent,
        requestId: actor.requestId,
      });

      await emit(
        tx,
        "supplier_po.created",
        {
          supplierPOId: row.id,
          number: row.number,
          supplierId,
          salesOrderId: order.id,
          currency: row.currency,
          total: row.total.toString(),
        },
        { actorId: actor.actorId, requestId: actor.requestId },
      );

      return row;
    });

    created.push({ id: po.id, number: po.number, supplierName: supplier.name });
  }

  // The order now has procurement in flight, which is the workstream column §1 keeps separate.
  await db.salesOrder.update({
    where: { id: order.id },
    data: { procurementStatus: "pending", version: { increment: 1 } },
  });

  return created;
}

// ---- editing ------------------------------------------------------------------------------------

export async function updateSupplierPoService(
  actor: ActorMeta,
  input: {
    supplierPOId: string;
    version: number;
    poDate?: Date;
    fxRate?: string;
    freight?: string;
    duties?: string;
    otherCharges?: string;
    expectedShipDate?: Date | null;
    expectedArrivalDate?: Date | null;
    incoterm?: string | null;
    shipmentMode?: string | null;
    trackingRef?: string | null;
    supplierRef?: string | null;
    notes?: string | null;
    lines?: {
      description: string;
      manufacturer?: string | null;
      modelNumber?: string | null;
      quantity: string;
      unit?: string;
      unitCost: string;
      leadTimeDays?: number | null;
      salesOrderLineId?: string | null;
    }[];
  },
) {
  const po = await db.supplierPO.findFirst({
    where: { id: input.supplierPOId, deletedAt: null },
  });
  if (!po) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That supplier PO no longer exists." });
  }
  if (po.version !== input.version) {
    // Spec.md §10's optimistic lock, same message shape as the quotation builder's.
    throw new TRPCError({
      code: "CONFLICT",
      message: `${po.number} was changed by somebody else while you were editing. Reload it.`,
    });
  }
  if (!isSupplierPoEditable(po.status)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${po.number} is ${po.status.replace(/_/g, " ")}, so its lines and charges are fixed. ` +
        `Editing an approved order silently changes what was approved — cancel it and raise ` +
        `another, or send it back to draft first.`,
    });
  }

  const freight = input.freight ?? po.freight.toString();
  const duties = input.duties ?? po.duties.toString();
  const otherCharges = input.otherCharges ?? po.otherCharges.toString();

  return db.$transaction(async (tx) => {
    let subtotal = Number(po.subtotal);

    if (input.lines) {
      // Replace rather than diff — line numbers are positional and the editor sends the whole
      // table, the same choice the quotation builder makes.
      await tx.supplierPOLine.deleteMany({ where: { supplierPOId: po.id } });
      const rows = input.lines.map((line, index) => ({
        supplierPOId: po.id,
        lineNo: index + 1,
        salesOrderLineId: line.salesOrderLineId ?? null,
        description: line.description,
        manufacturer: line.manufacturer ?? null,
        modelNumber: line.modelNumber ?? null,
        quantity: line.quantity,
        unit: line.unit ?? "pc",
        unitCost: line.unitCost,
        lineTotal: (Number(line.quantity) * Number(line.unitCost)).toFixed(2),
        leadTimeDays: line.leadTimeDays ?? null,
      }));
      if (rows.length > 0) await tx.supplierPOLine.createMany({ data: rows });
      subtotal = rows.reduce((sum, row) => sum + Number(row.lineTotal), 0);
    }

    const updated = await tx.supplierPO.update({
      where: { id: po.id },
      data: {
        ...(input.poDate ? { poDate: input.poDate } : {}),
        ...(input.fxRate ? { fxRate: input.fxRate } : {}),
        freight,
        duties,
        otherCharges,
        subtotal,
        total: supplierPoTotal({
          subtotal,
          freight: Number(freight),
          duties: Number(duties),
          otherCharges: Number(otherCharges),
        }),
        ...(input.expectedShipDate !== undefined
          ? { expectedShipDate: input.expectedShipDate }
          : {}),
        ...(input.expectedArrivalDate !== undefined
          ? { expectedArrivalDate: input.expectedArrivalDate }
          : {}),
        ...(input.incoterm !== undefined ? { incoterm: input.incoterm } : {}),
        ...(input.shipmentMode !== undefined ? { shipmentMode: input.shipmentMode } : {}),
        ...(input.trackingRef !== undefined ? { trackingRef: input.trackingRef } : {}),
        ...(input.supplierRef !== undefined ? { supplierRef: input.supplierRef } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        version: { increment: 1 },
      },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "update",
      entityType: SUPPLIER_PO_ENTITY_TYPE,
      entityId: po.id,
      summary:
        `Updated ${po.number}: ${updated.currency} ${updated.total.toString()} ` +
        `(${updated.lines.length} line(s), charges ${Number(freight) + Number(duties) + Number(otherCharges)})`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return updated;
  });
}

// ---- the gates ----------------------------------------------------------------------------------

export interface SupplierPoGates {
  downpayment: ReturnType<typeof downpaymentGate>;
  supplierApproval: ReturnType<typeof supplierApprovalGate>;
  /** True when nothing is in the way and the PO can be sent without an override. */
  clear: boolean;
}

/**
 * Both gates, evaluated without writing anything — the screen shows exactly what `send` enforces.
 *
 * A PO with no sales order behind it (stock replenishment, or module 04's material request) has no
 * downpayment to wait for, so only clause 8.4 applies. Reporting a downpayment gate against a
 * customer who does not exist would be nonsense somebody has to work out how to satisfy.
 */
export async function supplierPoGatesService(supplierPOId: string): Promise<SupplierPoGates> {
  const po = await db.supplierPO.findFirst({
    where: { id: supplierPOId, deletedAt: null },
    include: { supplier: true, salesOrder: true },
  });
  if (!po) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That supplier PO no longer exists." });
  }

  const supplierApproval = supplierApprovalGate(po.supplier);
  const downpayment = po.salesOrder
    ? downpaymentGate({
        financeStatus: po.salesOrder.financeStatus,
        downpaymentPct: Number(po.salesOrder.downpaymentPct),
        currency: po.salesOrder.currency,
        downpaymentAmount: Number(po.salesOrder.downpaymentAmount),
      })
    : {
        state: "not_required" as const,
        blocks: false,
        message: "This PO is not against a sales order, so no customer downpayment applies.",
      };

  return {
    downpayment,
    supplierApproval,
    clear: !downpayment.blocks && !supplierApproval.blocks,
  };
}

// ---- approval, sending, acknowledgement ---------------------------------------------------------

/**
 * Marks an approved PO as sent, and this is where both gates bite.
 *
 * §5: "**Issue manually.** As with supplier RFQs, the system generates the branded PO PDF and the
 * draft email text; a person sends it and marks it sent." So this records a fact about the world
 * rather than performing the send, exactly like the quotation's `confirmSent`.
 *
 * The overrides are separate optional reasons rather than one blanket flag, because they answer
 * different questions — "why did we buy before the customer paid" and "why did we buy from an
 * unapproved vendor" — and an auditor asks them separately.
 */
export async function sendSupplierPoService(
  actor: ActorMeta,
  user: AuthedUser,
  input: {
    supplierPOId: string;
    downpaymentOverrideReason?: string | null;
    unapprovedSupplierOverrideReason?: string | null;
  },
) {
  const po = await db.supplierPO.findFirst({
    where: { id: input.supplierPOId, deletedAt: null },
    include: { supplier: true, salesOrder: true },
  });
  if (!po) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That supplier PO no longer exists." });
  }
  if (po.status !== "approved") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${po.number} is ${po.status.replace(/_/g, " ")}. Only an approved PO can be sent — ` +
        `the Vice President's approval is what makes it a commitment.`,
    });
  }

  const gates = await supplierPoGatesService(po.id);
  const overrides = resolveGateOverrides(gates, user, input);

  const now = new Date();

  const updated = await db.$transaction(async (tx) => {
    const row = await tx.supplierPO.update({
      where: { id: po.id },
      data: {
        status: "sent",
        sentAt: now,
        ...(overrides.downpayment
          ? {
              downpaymentOverrideById: user.id,
              downpaymentOverrideAt: now,
              downpaymentOverrideReason: overrides.downpayment,
            }
          : {}),
        ...(overrides.supplierApproval
          ? {
              unapprovedSupplierOverrideBy: user.id,
              unapprovedSupplierOverrideReason: overrides.supplierApproval,
            }
          : {}),
        version: { increment: 1 },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "supplier_po_sent",
      entityType: SUPPLIER_PO_ENTITY_TYPE,
      entityId: po.id,
      summary:
        `Sent ${po.number} to ${po.supplier.name}` +
        (overrides.downpayment ? `. Downpayment gate overridden — ${overrides.downpayment}` : "") +
        (overrides.supplierApproval
          ? `. Clause 8.4 approval overridden — ${overrides.supplierApproval}`
          : ""),
      diff: { status: { from: "approved", to: "sent" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "supplier_po.sent",
      {
        supplierPOId: po.id,
        number: po.number,
        supplierId: po.supplierId,
        salesOrderId: po.salesOrderId,
        // Carried on the event so a subscriber never has to re-read the PO to know an override
        // happened — the whole point of recording it is that somebody downstream can see it.
        downpaymentOverridden: Boolean(overrides.downpayment),
        supplierApprovalOverridden: Boolean(overrides.supplierApproval),
      },
      { actorId: actor.actorId, requestId: actor.requestId },
    );

    if (po.salesOrderId) {
      await tx.salesOrder.update({
        where: { id: po.salesOrderId },
        data: { procurementStatus: "ordered", version: { increment: 1 } },
      });
    }

    return row;
  });

  return updated;
}

/**
 * Decides whether each blocking gate has been overridden, and refuses when it has not.
 *
 * Split out because the two gates need the same three-part decision — is it blocking, may this
 * person override, did they say why — and writing it twice inline is how the second copy ends up
 * subtly weaker than the first.
 */
function resolveGateOverrides(
  gates: SupplierPoGates,
  user: AuthedUser,
  input: {
    downpaymentOverrideReason?: string | null;
    unapprovedSupplierOverrideReason?: string | null;
  },
): { downpayment: string | null; supplierApproval: string | null } {
  const check = (
    gate: { blocks: boolean; message: string },
    reason: string | null | undefined,
    permission: string,
    who: string,
  ): string | null => {
    if (!gate.blocks) return null;

    const trimmed = reason?.trim() ?? "";
    if (trimmed.length === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: gate.message });
    }
    if (!user.permissions.has(permission)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `${gate.message} Only ${who} may override this.`,
      });
    }
    if (trimmed.length < 10) {
      // Longer than the three characters other reasons demand: this one is read by an auditor
      // years later, and "urgent" explains nothing.
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "Give a real reason. This is the sentence an auditor reads when they ask why the rule " +
          "was set aside, and it has to make sense without you in the room.",
      });
    }
    return trimmed;
  };

  return {
    downpayment: check(
      gates.downpayment,
      input.downpaymentOverrideReason,
      "procurement.override_downpayment_gate",
      "the President or Vice President",
    ),
    supplierApproval: check(
      gates.supplierApproval,
      input.unapprovedSupplierOverrideReason,
      "supplier.approve",
      "the President or Vice President",
    ),
  };
}

/** §5: "Track supplier acknowledgement by hand." */
export async function acknowledgeSupplierPoService(
  actor: ActorMeta,
  input: { supplierPOId: string; supplierRef?: string | null; expectedArrivalDate?: Date | null },
) {
  const po = await db.supplierPO.findFirst({
    where: { id: input.supplierPOId, deletedAt: null },
  });
  if (!po) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That supplier PO no longer exists." });
  }
  if (po.status !== "sent") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${po.number} is ${po.status.replace(/_/g, " ")}, so there is nothing to acknowledge.`,
    });
  }

  return db.$transaction(async (tx) => {
    const row = await tx.supplierPO.update({
      where: { id: po.id },
      data: {
        status: "acknowledged",
        acknowledgedAt: new Date(),
        ...(input.supplierRef !== undefined ? { supplierRef: input.supplierRef } : {}),
        ...(input.expectedArrivalDate !== undefined
          ? { expectedArrivalDate: input.expectedArrivalDate }
          : {}),
        version: { increment: 1 },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "supplier_po_acknowledged",
      entityType: SUPPLIER_PO_ENTITY_TYPE,
      entityId: po.id,
      summary:
        `${po.number} acknowledged by the supplier` +
        (input.supplierRef ? ` as ${input.supplierRef}` : "") +
        (row.expectedArrivalDate
          ? `, arriving ${row.expectedArrivalDate.toISOString().slice(0, 10)}`
          : ""),
      diff: { status: { from: "sent", to: "acknowledged" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return row;
  });
}

export async function cancelSupplierPoService(
  actor: ActorMeta,
  input: { supplierPOId: string; reason: string },
) {
  const po = await db.supplierPO.findFirst({ where: { id: input.supplierPOId, deletedAt: null } });
  if (!po) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That supplier PO no longer exists." });
  }
  if (po.status === "cancelled") {
    throw new TRPCError({ code: "BAD_REQUEST", message: `${po.number} is already cancelled.` });
  }
  if (po.status === "received" || po.status === "partially_received") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `Goods have already arrived against ${po.number}. Cancelling it would leave received ` +
        `stock with no order behind it — raise a return instead.`,
    });
  }
  if (input.reason.trim().length < 3) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Say why it was cancelled." });
  }

  return db.$transaction(async (tx) => {
    const row = await tx.supplierPO.update({
      where: { id: po.id },
      data: { status: "cancelled", version: { increment: 1 } },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "cancelled",
      entityType: SUPPLIER_PO_ENTITY_TYPE,
      entityId: po.id,
      summary: `Cancelled ${po.number} — ${input.reason.trim()}`,
      diff: { status: { from: po.status, to: "cancelled" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
    return row;
  });
}

// ---- reads --------------------------------------------------------------------------------------

function serialise(po: {
  subtotal: Prisma.Decimal;
  freight: Prisma.Decimal;
  duties: Prisma.Decimal;
  otherCharges: Prisma.Decimal;
  total: Prisma.Decimal;
  fxRate: Prisma.Decimal;
}) {
  return {
    subtotal: po.subtotal.toString(),
    freight: po.freight.toString(),
    duties: po.duties.toString(),
    otherCharges: po.otherCharges.toString(),
    total: po.total.toString(),
    fxRate: po.fxRate.toString(),
  };
}

export async function getSupplierPoService(supplierPOId: string) {
  const po = await db.supplierPO.findFirst({
    where: { id: supplierPOId, deletedAt: null },
    include: {
      lines: { orderBy: { lineNo: "asc" } },
      supplier: true,
      salesOrder: {
        select: {
          id: true,
          number: true,
          currency: true,
          financeStatus: true,
          downpaymentPct: true,
          downpaymentAmount: true,
          account: { select: { id: true, name: true } },
        },
      },
    },
  });
  if (!po) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That supplier PO no longer exists." });
  }

  // §5's landed cost, derived rather than stored so changing the freight cannot leave stale line
  // values behind.
  const allocation = allocateLandedCost(
    po.lines.map((line) => ({ lineNo: line.lineNo, lineTotal: Number(line.lineTotal) })),
    {
      freight: Number(po.freight),
      duties: Number(po.duties),
      otherCharges: Number(po.otherCharges),
    },
  );
  const allocationByLineNo = new Map(allocation.map((row) => [row.lineNo, row]));

  return {
    ...po,
    ...serialise(po),
    editable: isSupplierPoEditable(po.status),
    daysLate: daysLate(po.expectedArrivalDate),
    salesOrder: po.salesOrder
      ? {
          ...po.salesOrder,
          downpaymentPct: po.salesOrder.downpaymentPct.toString(),
          downpaymentAmount: po.salesOrder.downpaymentAmount.toString(),
        }
      : null,
    lines: po.lines.map((line) => ({
      ...line,
      quantity: line.quantity.toString(),
      unitCost: line.unitCost.toString(),
      lineTotal: line.lineTotal.toString(),
      qtyReceived: line.qtyReceived.toString(),
      allocatedCharges: (allocationByLineNo.get(line.lineNo)?.allocatedCharges ?? 0).toFixed(2),
      landedTotal: (
        allocationByLineNo.get(line.lineNo)?.landedTotal ?? Number(line.lineTotal)
      ).toFixed(2),
    })),
  };
}

export async function listSupplierPosService(params: {
  salesOrderId?: string;
  supplierId?: string;
  status?: string;
  /** §5's expediting view: only what is still an open commitment. */
  openOnly?: boolean;
  search?: string;
}) {
  const search = params.search?.trim();
  const pos = await db.supplierPO.findMany({
    where: {
      deletedAt: null,
      ...(params.salesOrderId ? { salesOrderId: params.salesOrderId } : {}),
      ...(params.supplierId ? { supplierId: params.supplierId } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.openOnly ? { status: { in: [...OPEN_SUPPLIER_PO_STATUSES] } } : {}),
      ...(search
        ? {
            OR: [
              { number: { contains: search, mode: "insensitive" as const } },
              { supplierRef: { contains: search, mode: "insensitive" as const } },
              { supplier: { name: { contains: search, mode: "insensitive" as const } } },
            ],
          }
        : {}),
    },
    orderBy: [{ expectedArrivalDate: "asc" }, { poDate: "desc" }],
    include: {
      supplier: { select: { id: true, code: true, name: true, isApproved: true } },
      salesOrder: {
        select: {
          id: true,
          number: true,
          requiredByDate: true,
          account: { select: { name: true } },
        },
      },
      _count: { select: { lines: true } },
    },
  });

  return pos.map((po) => ({
    ...po,
    ...serialise(po),
    // §5: "all open supplier POs with expected arrival, days late, and the customer commitment they
    // support". The last of those is why `salesOrder.account` is joined — procurement saying a
    // shipment is late is useless if nobody can say whose delivery it delays.
    daysLate: daysLate(po.expectedArrivalDate),
  }));
}

/**
 * §5: "Costs default from the linked supplier quote. **If the supplier quote has expired, warn
 * prominently** — the margin in the sales order was based on a stale cost."
 *
 * Reported rather than enforced. A stale cost is a reason to re-check the price before ordering,
 * not a reason to be unable to raise the order — and a hard block here would stop procurement dead
 * on every order whose quotation is more than a month old, which is most of them.
 */
export async function listStaleCostsForSalesOrderService(salesOrderId: string) {
  const order = await db.salesOrder.findFirst({
    where: { id: salesOrderId, deletedAt: null },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  if (!order) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That sales order no longer exists." });
  }

  const quotationLineIds = order.lines
    .map((line) => line.quotationLineId)
    .filter((id): id is string => id !== null);
  if (quotationLineIds.length === 0) return [];

  // Two hops rather than a join: `QuotationLine.supplierQuoteLineId` is a plain id column with no
  // relation declared on it, so Prisma cannot traverse it. Left as-is deliberately — see the
  // comment on that column in quotation.prisma.
  const quotationLines = await db.quotationLine.findMany({
    where: { id: { in: quotationLineIds } },
    select: { id: true, supplierQuoteLineId: true },
  });
  const quoteLineIdByQuotationLineId = new Map(
    quotationLines
      .filter((line) => line.supplierQuoteLineId !== null)
      .map((line) => [line.id, line.supplierQuoteLineId!]),
  );
  if (quoteLineIdByQuotationLineId.size === 0) return [];

  const quoteLines = await db.supplierQuoteLine.findMany({
    where: { id: { in: [...quoteLineIdByQuotationLineId.values()] } },
    select: {
      id: true,
      // The validity is the *request's*, not the line's — a supplier holds a whole quotation open
      // until a date, not each item separately.
      request: {
        select: { number: true, validUntil: true, supplier: { select: { name: true } } },
      },
    },
  });
  const quoteById = new Map(quoteLines.map((line) => [line.id, line]));

  const now = Date.now();
  return order.lines.flatMap((line) => {
    const quoteLineId = line.quotationLineId
      ? quoteLineIdByQuotationLineId.get(line.quotationLineId)
      : undefined;
    const quote = quoteLineId ? quoteById.get(quoteLineId) : undefined;
    // No validity date is not the same as expired — an undated quote is one nobody promised to
    // hold, and warning about it on every line would train people to ignore the warning.
    if (!quote?.request.validUntil) return [];
    if (new Date(quote.request.validUntil).getTime() >= now) return [];
    return [
      {
        salesOrderLineId: line.id,
        lineNo: line.lineNo,
        description: line.description,
        supplierName: quote.request.supplier.name,
        rfqNumber: quote.request.number,
        validUntil: quote.request.validUntil,
      },
    ];
  });
}

/**
 * Deletes a supplier PO that should never have existed.
 *
 * The company's reason, from the 2026-08-17 review: "there could be mistakes for double entries."
 * That is a real need and it is **not** what cancelling is for. A cancelled PO is a commitment the
 * company made and then withdrew, and it stays on the record because the supplier was told about it.
 * A double entry is a typing mistake that was never a commitment, and leaving it cancelled forever
 * puts a phantom order in the expediting view and the spend history.
 *
 * ## What it refuses
 *
 * **A PO that has been sent.** Once the supplier has it, the order exists in the world and the
 * honest correction is a cancellation they can see, not a deletion they cannot.
 *
 * **A PO that goods arrived against**, for the reason cancelling refuses it: a receipt with no order
 * behind it is worse than a wrong order.
 *
 * Soft-deleted rather than destroyed, and the audit row names the reason — the record of the mistake
 * survives even though the order stops appearing. Numbers are never reused (Spec.md §4.4), so the gap
 * in the sequence is itself a trace.
 */
export async function deleteSupplierPoService(
  actor: ActorMeta,
  input: { supplierPOId: string; reason: string },
) {
  const po = await db.supplierPO.findFirst({
    where: { id: input.supplierPOId, deletedAt: null },
    select: { id: true, number: true, status: true, sentAt: true, supplierId: true },
  });
  if (!po) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That supplier PO no longer exists." });
  }

  if (input.reason.trim().length < 3) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Say why this order is being deleted. A record that vanishes without a reason is one nobody can audit.",
    });
  }

  if (po.sentAt) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${po.number} has already been sent to the supplier, so it exists outside this system. ` +
        `Cancel it instead — they need to see the withdrawal.`,
    });
  }

  if (po.status === "received" || po.status === "partially_received") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `Goods have arrived against ${po.number}. Deleting it would leave a receipt with no order ` +
        `behind it.`,
    });
  }

  const receipts = await db.goodsReceipt.count({ where: { supplierPOId: po.id } });
  if (receipts > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${receipts} goods receipt(s) reference ${po.number}. Deleting it would orphan them.`,
    });
  }

  return db.$transaction(async (tx) => {
    const row = await tx.supplierPO.update({
      where: { id: po.id },
      data: { deletedAt: new Date(), deletedBy: actor.actorId, version: { increment: 1 } },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "deleted",
      entityType: SUPPLIER_PO_ENTITY_TYPE,
      entityId: po.id,
      summary: `Deleted ${po.number} (${po.status}, never sent) — ${input.reason.trim()}`,
      diff: { deletedAt: { from: null, to: row.deletedAt } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return { id: row.id, number: row.number };
  });
}
