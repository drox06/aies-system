import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import {
  checkCustomerPoAgainstQuotation,
  summariseCheck,
  type PoCheckLine,
  type PoCheckResult,
} from "./po-verification";

/**
 * §3: verifying a customer PO, and turning it into the obligation.
 *
 * §1 calls this "the pivot point… where the deal stops being a sales artifact and becomes an
 * obligation", and everything downstream — procurement, finance, operations — hangs off the sales
 * order this creates. Which is why §3 puts a gate in front of it.
 */

export const SALES_ORDER_ENTITY_TYPE = "SalesOrder";
export const SALES_ORDER_DOCUMENT_TYPE = "sales_order";

/**
 * Runs §3's check and reports, without writing anything.
 *
 * A query rather than a step in the creation path, because the screen has to show the findings
 * *before* anybody commits to them — §3: "Discrepancies are surfaced on screen and must be resolved
 * (accept, or raise a quotation revision) before the sales order is created."
 */
export async function checkCustomerPoService(input: {
  customerPOId: string;
  /** Line quantities as printed on the customer's document, typed by whoever is looking at it. */
  poLines?: PoCheckLine[];
}): Promise<PoCheckResult & { quotationNumber: string | null; summary: string }> {
  const po = await db.customerPO.findFirst({
    where: { id: input.customerPOId, deletedAt: null },
    include: {
      quotation: {
        include: { lines: { orderBy: { lineNo: "asc" } } },
      },
    },
  });
  if (!po) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That purchase order no longer exists." });
  }

  if (!po.quotation) {
    // §2 allows a PO against no quotation — "a repeat order on agreed prices". There is nothing to
    // compare it against, and saying so is more useful than an empty findings list that reads like
    // a pass.
    const result: PoCheckResult = { discrepancies: [], ok: true, quantitiesChecked: false };
    return {
      ...result,
      quotationNumber: null,
      summary:
        "No quotation is linked to this purchase order, so there is nothing to check it against.",
    };
  }

  const result = checkCustomerPoAgainstQuotation({
    quotation: {
      number: po.quotation.number,
      total: Number(po.quotation.total),
      currency: po.quotation.currency,
      lines: po.quotation.lines
        // §7 keeps optional lines off the total, so they are not part of what was agreed and must
        // not be reported as "quoted but not ordered".
        .filter((line) => !line.isOptional)
        .map((line) => ({
          lineNo: line.lineNo,
          description: line.description,
          quantity: Number(line.quantity),
        })),
    },
    po: {
      poNumber: po.poNumber,
      amount: Number(po.amount),
      currency: po.currency,
      lines: input.poLines,
    },
  });

  return { ...result, quotationNumber: po.quotation.number, summary: summariseCheck(result) };
}

/**
 * Records the decision §3 asks for: the differences were looked at and accepted, or there were none.
 *
 * The **reason is required when anything was found**, and that is the whole value of the step. A
 * `verified` flag with no explanation answers "did somebody check?" and not "what did they see, and
 * why was it alright" — and the second question is the one asked six months later when the customer
 * disputes what they ordered.
 */
export async function verifyCustomerPoService(
  actor: ActorMeta,
  input: { customerPOId: string; poLines?: PoCheckLine[]; acceptanceNote?: string | null },
) {
  const check = await checkCustomerPoService({
    customerPOId: input.customerPOId,
    poLines: input.poLines,
  });

  if (!check.ok) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `This purchase order cannot be verified yet: ` +
        check.discrepancies
          .filter((d) => d.severity === "blocking")
          .map((d) => d.message)
          .join(" "),
    });
  }

  const note = input.acceptanceNote?.trim() ?? "";
  if (check.discrepancies.length > 0 && note.length < 3) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${check.discrepancies.length} difference(s) from the quotation need a word of explanation ` +
        `before this can be verified. What did the customer actually order, and why is it alright?`,
    });
  }

  return db.$transaction(async (tx) => {
    const po = await tx.customerPO.update({
      where: { id: input.customerPOId },
      data: {
        status: "verified",
        // Kept on the record as well as in the audit log, the same shape §4's requirements override
        // uses: the log is the evidence, this is what the next person to open the PO reads.
        discrepancyNotes:
          check.discrepancies.length > 0
            ? `${check.summary}\n\n${check.discrepancies.map((d) => `• ${d.message}`).join("\n")}` +
              `\n\nAccepted: ${note}`
            : null,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "customer_po_verified",
      entityType: "CustomerPO",
      entityId: po.id,
      summary:
        `Verified PO ${po.poNumber} against ${check.quotationNumber ?? "no quotation"}. ` +
        check.summary +
        (note ? ` Accepted: ${note}` : "") +
        (check.quantitiesChecked ? "" : " Line quantities were not captured."),
      diff: { status: { from: "received", to: "verified" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return po;
  });
}

/**
 * §3's sales order creation: "copies quotation lines".
 *
 * A **copy**, not a reference, and for the reason every other copy in this build exists: the
 * quotation can be revised afterwards, and the obligation is to what the customer ordered on the
 * day — not to whatever the document says later. `quotationLineId` keeps the trail back.
 *
 * ## `requiresExecution` is the decision this function actually makes
 *
 * §3: "Lines whose `itemType` is service/labour, or whose product is flagged as requiring
 * installation, set `requiresExecution = true`. If any line requires execution, `executionStatus`
 * starts at `pending` and module 04 is signalled."
 *
 * That flag is what separates a delivery from a job. Get it wrong in one direction and a project
 * never reaches operations; wrong in the other and a box of spares generates an installation ticket
 * nobody needs.
 */
export async function createSalesOrderFromPoService(
  actor: ActorMeta,
  input: { customerPOId: string; requiredByDate?: Date | null; ownerId?: string | null },
) {
  const po = await db.customerPO.findFirst({
    where: { id: input.customerPOId, deletedAt: null },
    include: {
      salesOrder: { select: { id: true, number: true } },
      quotation: { include: { lines: { orderBy: { lineNo: "asc" } } } },
    },
  });
  if (!po) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That purchase order no longer exists." });
  }
  if (po.salesOrder) {
    // The unique constraint on `customerPOId` would catch this anyway; the message is the point.
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${po.salesOrder.number} was already raised from PO ${po.poNumber}. A second order against ` +
        `the same purchase order is the same money committed twice.`,
    });
  }
  if (!po.quotation) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `PO ${po.poNumber} is not linked to a quotation, so there are no lines to copy. Link it to ` +
        `the quotation it answers first.`,
    });
  }
  if (po.status !== "verified") {
    // §3's gate, stated plainly. This is the sentence that makes the check more than a screen.
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `PO ${po.poNumber} has not been verified against ${po.quotation.number} yet. §3 puts that ` +
        `check before the sales order because it is unrecoverable afterwards — by the time goods ` +
        `are bought and shipped, a wrong quantity is stock nobody can bill for.`,
    });
  }

  const quoted = po.quotation.lines.filter((line) => !line.isOptional);
  if (quoted.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${po.quotation.number} has no lines to copy.`,
    });
  }

  const number = await allocateNumber(SALES_ORDER_DOCUMENT_TYPE);

  const lines = quoted.map((line, index) => ({
    lineNo: index + 1,
    quotationLineId: line.id,
    itemType: line.itemType,
    productId: line.productId,
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    unitPrice: line.unitPrice,
    lineTotal: line.lineTotal,
    unitCost: line.unitCost,
    // What the customer ordered is what is owed; nothing has been bought or delivered yet.
    qtyOrdered: line.quantity,
    requiresExecution: lineRequiresExecution(line.itemType),
    status: "pending",
  }));

  const anyExecution = lines.some((line) => line.requiresExecution);

  /*
    What the customer agreed to pay up front, from the term on their quotation.

    `downpaymentPct` is stored as a fraction on `PaymentTerm` — 0.30 for thirty per cent — and the
    gate's message multiplies by 100 to say so. Both sides of that have to agree, and this is the one
    place the conversion happens.

    A quotation with no payment term produces zero, which produces `not_required`. That is right: a
    deal nobody set terms on has no agreed downpayment, and inventing one here would gate procurement
    on a figure the customer never saw.
  */
  /*
    Read separately, because `Quotation` carries `paymentTermsId` as a plain column with no relation
    to `PaymentTerm` — module 02 stores the id and prints `paymentTermsText`, and never needed to
    join. Adding the relation would be tidier and is a migration on a schema about to take live data,
    for one read on one path. A findUnique is the smaller change.
  */
  const term = po.quotation!.paymentTermsId
    ? await db.paymentTerm.findUnique({
        where: { id: po.quotation!.paymentTermsId },
        select: { name: true, downpaymentPct: true },
      })
    : null;

  const downpaymentPct = Number(term?.downpaymentPct ?? 0);
  const downpaymentAmount = Number(po.quotation!.total) * downpaymentPct;

  const salesOrder = await db.$transaction(async (tx) => {
    const created = await tx.salesOrder.create({
      data: {
        number,
        accountId: po.accountId,
        siteId: po.quotation!.siteId,
        quotationId: po.quotation!.id,
        customerPOId: po.id,
        requiredByDate: input.requiredByDate ?? null,
        currency: po.quotation!.currency,
        subtotal: po.quotation!.subtotal,
        vatAmount: po.quotation!.vatAmount,
        total: po.quotation!.total,
        totalCost: po.quotation!.totalCost,
        marginAmount: po.quotation!.marginAmount,
        paymentTermsId: po.quotation!.paymentTermsId,
        /*
          §4's gate, finally connected to something.

          This was hardcoded `0` / `not_required` from module 03 session 1, with a comment saying
          module 05 would wire it "when the terms exist". The terms existed from module 05 session 1
          and nobody came back, so **every order ever raised had the gate switched off**: no order
          reached `awaiting_downpayment`, `downpaymentGate` never blocked, and procurement was
          ungated on the customer's money while looking gated. The company found it on 2026-08-19 by
          asking the reasonable question — "how is this cleared?" — and the honest answer was that
          nothing cleared it because nothing ever set it.

          The lesson is not "somebody forgot". It is that **a placeholder with a plausible value is
          invisible**: `not_required` is a legitimate state, so nothing looked wrong on any screen, in
          any test, or in the schema. A placeholder that had thrown, or that had been `null` on a
          non-nullable column, would have been found the same afternoon.

          `downpaymentAmount` is computed from the order total rather than the quotation's, so a
          rounding difference between the two cannot leave finance chasing a figure the order does
          not show.
        */
        downpaymentPct: downpaymentPct.toString(),
        downpaymentAmount: downpaymentAmount.toFixed(2),
        status: "open",
        procurementStatus: "pending",
        // No downpayment agreed means nothing to wait for. Starting at `awaiting_downpayment` on
        // those orders would put a gate indicator on every one of them for a condition nobody set.
        financeStatus: downpaymentPct > 0 ? "awaiting_downpayment" : "not_required",
        executionStatus: anyExecution ? "pending" : "not_required",
        ownerId: input.ownerId ?? actor.actorId,
        lines: { create: lines },
      },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "create",
      entityType: SALES_ORDER_ENTITY_TYPE,
      entityId: created.id,
      summary:
        `Raised ${created.number} from PO ${po.poNumber} against ${po.quotation!.number}: ` +
        `${lines.length} line(s), ${created.currency} ${created.total.toString()}` +
        (anyExecution ? ", with field work to schedule." : ", goods only."),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    /**
     * §3: "On `sales_order.created`, module 04 proposes a ticket set: executable lines →
     * `new_project` or `installation` tickets, goods-only lines → a `delivery` ticket… Each ticket
     * links back to the specific sales order lines it covers."
     *
     * So the payload carries the per-line execution flags rather than a summary — module 04 needs to
     * know *which* lines, not merely that some exist, and re-reading them would make the proposal a
     * function of whatever the order looks like when the job runs rather than when it was raised.
     */
    await emit(
      tx,
      "sales_order.created",
      {
        salesOrderId: created.id,
        number: created.number,
        accountId: created.accountId,
        siteId: created.siteId,
        quotationId: created.quotationId,
        customerPOId: created.customerPOId,
        requiredByDate: created.requiredByDate?.toISOString() ?? null,
        lines: created.lines.map((line) => ({
          salesOrderLineId: line.id,
          lineNo: line.lineNo,
          description: line.description,
          quantity: line.quantity.toString(),
          itemType: line.itemType,
          requiresExecution: line.requiresExecution,
        })),
      },
      { actorId: actor.actorId, requestId: actor.requestId },
    );

    return created;
  });

  return salesOrder;
}

/**
 * Whether a line implies somebody has to go and do something.
 *
 * §3 names two tests and only one is available today: `itemType` is service or labour. The second —
 * "whose product is flagged as requiring installation" — needs a flag on `Product` that does not
 * exist, and inventing one here would give module 04 a second mechanism to reconcile. Recorded
 * rather than silently half-implemented; a product-level flag joins this function when there is one.
 */
export function lineRequiresExecution(itemType: string): boolean {
  return itemType === "service" || itemType === "labour";
}

export async function getSalesOrderService(
  user: { id: string; permissions: ReadonlySet<string> },
  salesOrderId: string,
) {
  const order = await db.salesOrder.findFirst({
    where: {
      id: salesOrderId,
      deletedAt: null,
      // Record scoping, the same shape module 01 and 02 use: without `view_all`, your own orders.
      ...(user.permissions.has("sales_order.view_all") ? {} : { ownerId: user.id }),
    },
    include: {
      lines: { orderBy: { lineNo: "asc" } },
      account: { select: { id: true, code: true, name: true } },
      site: { select: { id: true, name: true, accessNotes: true } },
      quotation: { select: { id: true, number: true, revision: true } },
      customerPO: { select: { id: true, poNumber: true, poDate: true, fileId: true } },
    },
  });
  if (!order) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That sales order no longer exists." });
  }

  const canSeeCost = user.permissions.has("finance.view_cost");
  return {
    ...order,
    subtotal: order.subtotal.toString(),
    vatAmount: order.vatAmount.toString(),
    total: order.total.toString(),
    // Spec.md §4.3: cost and margin never reach a caller without `finance.view_cost`.
    totalCost: canSeeCost ? order.totalCost.toString() : null,
    marginAmount: canSeeCost ? order.marginAmount.toString() : null,
    downpaymentPct: order.downpaymentPct.toString(),
    downpaymentAmount: order.downpaymentAmount.toString(),
    lines: order.lines.map((line) => ({
      ...line,
      quantity: line.quantity.toString(),
      unitPrice: line.unitPrice.toString(),
      lineTotal: line.lineTotal.toString(),
      unitCost: canSeeCost ? line.unitCost.toString() : null,
      qtyOrdered: line.qtyOrdered.toString(),
      qtyReceived: line.qtyReceived.toString(),
      qtyDelivered: line.qtyDelivered.toString(),
    })),
  };
}

export async function listSalesOrdersService(
  user: { id: string; permissions: ReadonlySet<string> },
  params: { search?: string; status?: string } = {},
) {
  const search = params.search?.trim();
  const orders = await db.salesOrder.findMany({
    where: {
      deletedAt: null,
      ...(user.permissions.has("sales_order.view_all") ? {} : { ownerId: user.id }),
      ...(params.status ? { status: params.status } : {}),
      ...(search
        ? {
            OR: [
              { number: { contains: search, mode: "insensitive" as const } },
              { account: { name: { contains: search, mode: "insensitive" as const } } },
            ],
          }
        : {}),
    },
    orderBy: { orderDate: "desc" },
    include: {
      account: { select: { id: true, code: true, name: true } },
      customerPO: { select: { poNumber: true } },
      _count: { select: { lines: true } },
    },
  });

  return orders.map((order) => ({
    ...order,
    subtotal: order.subtotal.toString(),
    vatAmount: order.vatAmount.toString(),
    total: order.total.toString(),
    totalCost: undefined,
    marginAmount: undefined,
    downpaymentPct: order.downpaymentPct.toString(),
    downpaymentAmount: order.downpaymentAmount.toString(),
  }));
}

/**
 * Finance records that the customer's downpayment has arrived, which opens §4's gate.
 *
 * ## The other half of the gate
 *
 * `downpaymentGate` reads `financeStatus`, and until this existed nothing could move it. Orders were
 * created `not_required` and stayed there; had they been created `awaiting_downpayment` they would
 * have stayed *there*, and procurement would have been blocked on every order for ever. Wiring the
 * first half without this one would have replaced an invisible hole with a visible deadlock.
 *
 * ## Why it is deliberately small
 *
 * This records **that the money came**, not the accounting for it. §3's collections and the statement
 * chain in module 05 own where the payment sits, how it is allocated and what receipt it produces.
 * What procurement needs to know is one thing — may AIES commit money to suppliers yet — and that is
 * a single status with a date, a reference and a name against it.
 *
 * When §3's payments land, this becomes the thing that observes them rather than the thing that is
 * typed. It is deliberately shaped so that swap is a change of caller, not of meaning.
 *
 * ## What it refuses
 *
 * **An order with no downpayment agreed.** `not_required` is not a gate waiting to be opened, it is
 * the absence of one, and recording a downpayment against it would invent a term the customer never
 * agreed to.
 *
 * **Recording it twice.** The second call is refused rather than silently accepted, because a
 * duplicate would suggest two payments where there was one, and because a caller doing it twice has
 * usually mistaken which order they are on.
 */
export async function recordDownpaymentService(
  actor: ActorMeta,
  input: { salesOrderId: string; reference: string; receivedAt?: Date | null },
) {
  const order = await db.salesOrder.findFirst({
    where: { id: input.salesOrderId, deletedAt: null },
    select: {
      id: true,
      number: true,
      financeStatus: true,
      downpaymentPct: true,
      downpaymentAmount: true,
      currency: true,
    },
  });
  if (!order) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That sales order no longer exists." });
  }

  if (order.financeStatus === "not_required") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${order.number} has no downpayment agreed, so there is nothing waiting on one. Check the ` +
        `payment terms on the quotation if that is wrong.`,
    });
  }

  if (order.financeStatus !== "awaiting_downpayment") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${order.number} is already ${order.financeStatus.replace(/_/g, " ")}.`,
    });
  }

  const reference = input.reference.trim();
  if (reference.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Record how the money arrived — the deposit slip, the transfer reference, the cheque " +
        "number. This is what procurement is relying on when it commits to a supplier.",
    });
  }

  const receivedAt = input.receivedAt ?? new Date();
  if (receivedAt.getTime() > Date.now()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The downpayment cannot have arrived in the future. Check the date.",
    });
  }

  await db.$transaction(async (tx) => {
    await tx.salesOrder.update({
      where: { id: order.id },
      data: { financeStatus: "downpayment_received", version: { increment: 1 } },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "downpayment_received",
      entityType: SALES_ORDER_ENTITY_TYPE,
      entityId: order.id,
      summary:
        `Recorded the ${(Number(order.downpaymentPct) * 100).toFixed(0)}% downpayment on ` +
        `${order.number} — ${order.currency} ${Number(order.downpaymentAmount).toFixed(2)}, ` +
        `reference ${reference}`,
      diff: { financeStatus: { from: order.financeStatus, to: "downpayment_received" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { financeStatus: "downpayment_received" as const };
}
