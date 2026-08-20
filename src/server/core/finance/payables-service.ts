import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { payableAgeing, threeWayMatch } from "@/server/core/finance/payables-rules";

export const SUPPLIER_INVOICE_ENTITY_TYPE = "SupplierInvoice";
export const SUPPLIER_INVOICE_DOCUMENT_TYPE = "supplier_invoice";

/**
 * §7's payables — recording a supplier's bill and checking it against what AIES ordered and received.
 *
 * ## Why the match runs at recording time and is stored
 *
 * The finding is a fact about a moment. Re-running the comparison later, against a purchase order
 * somebody has since amended or a receipt corrected, would quietly change what was disputed and why —
 * and the dispute is the thing a supplier is being telephoned about. The same reasoning that stores a
 * warranty determination rather than recomputing it, and for the same reason: a position the company
 * took on a date must survive the records moving underneath it.
 *
 * Re-running it deliberately is a separate act, and it says what changed.
 */

/**
 * What has actually been received and accepted against a supplier PO, in money.
 *
 * Accepted rather than delivered: §6 of module 03 distinguishes the two, and goods rejected at
 * receiving are not something AIES owes for. Valued at the PO's own line prices, because that is what
 * the invoice will be compared against — valuing them at anything else would manufacture a
 * discrepancy out of the valuation method.
 */
async function receivedValueFor(supplierPOId: string): Promise<number | null> {
  const lines = await db.supplierPOLine.findMany({
    where: { supplierPOId },
    select: { qtyReceived: true, unitCost: true },
  });
  if (lines.length === 0) return null;

  return lines.reduce((sum, line) => sum + Number(line.qtyReceived) * Number(line.unitCost), 0);
}

export async function recordSupplierInvoiceService(
  actor: ActorMeta,
  input: {
    supplierId: string;
    supplierPOId?: string | null;
    supplierRef: string;
    invoiceDate: Date;
    dueDate?: Date | null;
    amount: number;
    vatAmount?: number | null;
    currency?: string;
    notes?: string | null;
  },
) {
  const supplier = await db.supplier.findFirst({
    where: { id: input.supplierId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!supplier) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That supplier does not exist." });
  }

  const supplierRef = input.supplierRef.trim();
  if (supplierRef.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Record the supplier's own invoice number. Every follow-up call quotes theirs, not ours.",
    });
  }

  if (input.amount <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "An invoice for nothing is not an invoice. Check the amount.",
    });
  }

  /*
    A supplier billing the same reference twice is the commonest duplicate-payment cause there is —
    usually a statement chasing an invoice already sent, keyed again by somebody who has not seen the
    first. Refused rather than warned: unlike a repeated export, there is no legitimate version of
    this, and the correct action is always to find the existing record.
  */
  const duplicate = await db.supplierInvoice.findFirst({
    where: { deletedAt: null, supplierId: supplier.id, supplierRef },
    select: { number: true },
  });
  if (duplicate) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${supplier.name} invoice ${supplierRef} is already recorded as ${duplicate.number}. ` +
        `Paying it twice is the commonest way money leaves a business by accident.`,
    });
  }

  const order = input.supplierPOId
    ? await db.supplierPO.findFirst({
        where: { id: input.supplierPOId, deletedAt: null },
        select: { id: true, number: true, total: true },
      })
    : null;

  const received = order ? await receivedValueFor(order.id) : null;

  const match = threeWayMatch({
    invoiceAmount: input.amount,
    orderTotal: order ? Number(order.total) : null,
    receivedValue: received,
  });

  const number = await allocateNumber(SUPPLIER_INVOICE_DOCUMENT_TYPE);

  const created = await db.$transaction(async (tx) => {
    const row = await tx.supplierInvoice.create({
      data: {
        number,
        supplierId: supplier.id,
        supplierPOId: order?.id ?? null,
        supplierRef,
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate ?? null,
        amount: input.amount.toFixed(2),
        vatAmount:
          input.vatAmount === null || input.vatAmount === undefined
            ? null
            : input.vatAmount.toFixed(2),
        currency: input.currency ?? "PHP",
        // The match decides the status. A person choosing it would make "matched" an opinion, and
        // the whole value of a three-way check is that it is not one.
        status: match.matched ? "matched" : "disputed",
        // Cast because Prisma types a Json column as an object shape; an array of findings is
        // valid JSON and the narrower type is Prisma being conservative rather than a real rule.
        matchFindings: match.findings as unknown as Prisma.InputJsonValue,
        notes: input.notes?.trim() || null,
        recordedById: actor.actorId,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "create",
      entityType: SUPPLIER_INVOICE_ENTITY_TYPE,
      entityId: row.id,
      summary:
        `Recorded ${row.number} — ${supplier.name} invoice ${supplierRef}, ` +
        `${row.currency} ${input.amount.toFixed(2)}` +
        (match.matched
          ? ", matched against the order and receipts"
          : `, disputed: ${match.findings.map((finding) => finding.kind).join(", ")}`),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return row;
  });

  return { id: created.id, number: created.number, match };
}

/**
 * Approving a disputed invoice for payment, which requires saying why.
 *
 * §7 does not build a payment run, so "approved" here means *cleared to pay* rather than paid. The
 * reason matters more than the status: an invoice that failed its match and was approved anyway is
 * either a discrepancy somebody investigated and accepted, or one nobody looked at, and only the
 * written reason separates the two.
 */
export async function approveSupplierInvoiceService(
  actor: ActorMeta,
  input: { id: string; overrideReason?: string | null },
) {
  const invoice = await db.supplierInvoice.findFirst({
    where: { id: input.id, deletedAt: null },
    select: { id: true, number: true, status: true, supplierRef: true },
  });
  if (!invoice) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That invoice no longer exists." });
  }
  if (invoice.status === "approved" || invoice.status === "paid") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${invoice.number} is already ${invoice.status}.`,
    });
  }

  const reason = input.overrideReason?.trim() ?? "";
  if (invoice.status === "disputed" && reason.length < 10) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This invoice did not match its order and receipts. Say what was checked and why it is " +
        "being paid anyway — an unexplained override is indistinguishable from nobody looking.",
    });
  }

  await db.$transaction(async (tx) => {
    await tx.supplierInvoice.update({
      where: { id: invoice.id },
      data: {
        status: "approved",
        approvedById: actor.actorId,
        approvedAt: new Date(),
        disputeOverrideReason: invoice.status === "disputed" ? reason : null,
        version: { increment: 1 },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "approve",
      entityType: SUPPLIER_INVOICE_ENTITY_TYPE,
      entityId: invoice.id,
      summary:
        invoice.status === "disputed"
          ? `Approved ${invoice.number} despite its match findings — ${reason}`
          : `Approved ${invoice.number} for payment`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { status: "approved" as const };
}

/**
 * The payables list, aged.
 *
 * Ordered by due date rather than by amount, because the question a payables list answers is "what
 * is about to be late", and a large invoice due next month is not more urgent than a small one that
 * was due last week.
 */
export async function payablesService(filter: { openOnly?: boolean } = {}) {
  const rows = await db.supplierInvoice.findMany({
    where: {
      deletedAt: null,
      ...(filter.openOnly === false ? {} : { status: { notIn: ["paid"] } }),
    },
    select: {
      id: true,
      number: true,
      supplierRef: true,
      invoiceDate: true,
      dueDate: true,
      amount: true,
      currency: true,
      status: true,
      matchFindings: true,
      disputeOverrideReason: true,
      supplierId: true,
      supplierPOId: true,
    },
    orderBy: [{ dueDate: "asc" }, { invoiceDate: "asc" }],
    take: 300,
  });

  /*
    Names fetched rather than joined: `SupplierInvoice` carries its supplier and order as plain id
    columns with no Prisma relation, the same shape `Quotation.paymentTermsId` has. Two small
    queries beat a migration on a schema about to take live data, and a payables list that shows
    "cm7x…" instead of a supplier name is a list nobody can act on.
  */
  const [suppliers, orders] = await Promise.all([
    db.supplier.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.supplierId))] } },
      select: { id: true, name: true },
    }),
    db.supplierPO.findMany({
      where: {
        id: {
          in: [...new Set(rows.map((row) => row.supplierPOId).filter((id): id is string => !!id))],
        },
      },
      select: { id: true, number: true },
    }),
  ]);
  const supplierById = new Map(suppliers.map((supplier) => [supplier.id, supplier]));
  const orderById = new Map(orders.map((order) => [order.id, order]));

  const now = new Date();
  const decorated = rows.map((row) => ({
    id: row.id,
    number: row.number,
    supplierRef: row.supplierRef,
    supplier: supplierById.get(row.supplierId) ?? null,
    supplierPO: row.supplierPOId ? (orderById.get(row.supplierPOId) ?? null) : null,
    invoiceDate: row.invoiceDate,
    dueDate: row.dueDate,
    amount: row.amount.toString(),
    currency: row.currency,
    status: row.status,
    ageing: payableAgeing(row.dueDate, now),
    findings: (row.matchFindings ?? []) as { kind: string; note: string }[],
    disputeOverrideReason: row.disputeOverrideReason,
  }));

  const totals = new Map<string, number>();
  for (const row of decorated) {
    totals.set(row.ageing, (totals.get(row.ageing) ?? 0) + Number(row.amount));
  }

  return {
    rows: decorated,
    byAgeing: Object.fromEntries(totals),
    disputedCount: decorated.filter((row) => row.status === "disputed").length,
    total: decorated.reduce((sum, row) => sum + Number(row.amount), 0).toFixed(2),
  };
}

/**
 * The suppliers a bill could arrive from, each with the orders it might answer.
 *
 * ## Why this is not `listSuppliers`
 *
 * Module 03 has a supplier list already, gated on `supplier.manage`. A finance clerk keying an
 * invoice is not managing the supplier register and should not need rights over it — and the useful
 * question here is narrower anyway: *which orders am I plausibly about to be billed for*. So this
 * returns only suppliers with at least one order that has been sent, and each order carries what it
 * was for and what has already been billed against it.
 *
 * `alreadyBilled` matters on screen. §7 refuses a duplicate **supplier reference**, which catches the
 * commonest double-payment, but it cannot catch the same goods billed twice under two references.
 * Showing what a PO already carries lets a person notice that before it becomes a payment.
 */
export async function billableSuppliersService() {
  const orders = await db.supplierPO.findMany({
    where: {
      deletedAt: null,
      // Nothing before `sent` — an order still in draft has not been placed, so no invoice can
      // honestly answer it, and offering one invites a bill against something nobody ordered.
      status: { in: ["sent", "acknowledged", "partially_received", "received"] },
    },
    select: {
      id: true,
      number: true,
      supplierId: true,
      total: true,
      currency: true,
      status: true,
      poDate: true,
    },
    orderBy: { poDate: "desc" },
    take: 300,
  });

  const supplierIds = [...new Set(orders.map((order) => order.supplierId))];
  const [suppliers, billed] = await Promise.all([
    db.supplier.findMany({
      where: { id: { in: supplierIds }, deletedAt: null },
      select: { id: true, name: true, currency: true, paymentTerms: true },
      orderBy: { name: "asc" },
    }),
    db.supplierInvoice.findMany({
      where: { deletedAt: null, supplierPOId: { in: orders.map((order) => order.id) } },
      select: { supplierPOId: true, amount: true },
    }),
  ]);

  const billedByPo = new Map<string, number>();
  for (const invoice of billed) {
    if (!invoice.supplierPOId) continue;
    billedByPo.set(
      invoice.supplierPOId,
      (billedByPo.get(invoice.supplierPOId) ?? 0) + Number(invoice.amount),
    );
  }

  return suppliers.map((supplier) => ({
    id: supplier.id,
    name: supplier.name,
    currency: supplier.currency,
    paymentTerms: supplier.paymentTerms,
    orders: orders
      .filter((order) => order.supplierId === supplier.id)
      .map((order) => ({
        id: order.id,
        number: order.number,
        total: order.total.toString(),
        currency: order.currency,
        status: order.status,
        poDate: order.poDate,
        alreadyBilled: (billedByPo.get(order.id) ?? 0).toFixed(2),
      })),
  }));
}
