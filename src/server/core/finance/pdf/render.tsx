/*
  React in scope explicitly, so this module can be rendered outside Next's compiler.

  tsconfig sets `jsx: preserve` — Next applies the automatic runtime, and anything running the file
  directly (a script, a test) gets classic-runtime JSX and a bare `React is not defined`. That is
  what happened the first time this was exercised. The import costs nothing at runtime and is the
  difference between a document that can be proved to render and one that can only be assumed to.
*/
import React from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { getCompanyDetails } from "@/server/core/company";
// The logo cache and date formatter live with the quotation PDFs, which reached this first — reused
// here rather than duplicated, so there is one cached read of the ~200kB lockup for the whole process.
import { logoDataUri } from "@/server/core/quotation/pdf/render";
import {
  ServiceInvoiceDocument,
  type ServiceInvoiceDocumentProps,
} from "@/server/core/finance/pdf/ServiceInvoiceDocument";
import {
  BillingStatementDocument,
  type BillingStatementDocumentProps,
} from "@/server/core/finance/pdf/BillingStatementDocument";
import {
  StatementOfAccountDocument,
  type StatementOfAccountDocumentProps,
} from "@/server/core/finance/pdf/StatementOfAccountDocument";
import { ageingBucket, type AgeingBucket } from "@/server/core/finance/invoice-rules";

/**
 * Assembling §3's service invoice from the records it was derived from.
 *
 * Everything printed is **read back from the stored invoice**, never recomputed. The VAT split, the
 * withholding and the net were decided at the moment the payment was recorded, and a document that
 * recalculated them at print time could disagree with the copy the customer already has — which,
 * on a BIR-numbered document, is not a display bug but a discrepancy in a statutory filing.
 *
 * The statements it settles are read live, because their *descriptions* are context rather than
 * figures; the amounts shown against them come from the allocation, which is what the payment
 * actually applied.
 */

function addressLines(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const address = raw as Record<string, unknown>;
  // The same order the delivery documents print, so a customer sees one address across the platform.
  return [address.line1, address.barangay, address.city, address.province, address.postalCode]
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .reduce<string[]>((lines, part, index) => {
      if (index === 0) return [part];
      const last = lines[lines.length - 1]!;
      // Keep the block to two or three lines rather than one word per line.
      return last.length + part.length > 48
        ? [...lines, part]
        : [...lines.slice(0, -1), `${last}, ${part}`];
    }, []);
}

export async function buildServiceInvoicePdfProps(
  invoiceId: string,
): Promise<ServiceInvoiceDocumentProps> {
  const invoice = await db.serviceInvoice.findFirst({ where: { id: invoiceId } });
  if (!invoice) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That service invoice no longer exists." });
  }

  const [account, payment, statements, allocations] = await Promise.all([
    db.customerAccount.findUnique({
      where: { id: invoice.accountId },
      select: { name: true, legalName: true, tin: true, billingAddress: true },
    }),
    db.payment.findUnique({
      where: { id: invoice.paymentId },
      select: { number: true, method: true, reference: true, receivedAt: true },
    }),
    db.billingStatement.findMany({
      where: { id: { in: invoice.billingStatementIds } },
      select: { id: true, number: true, lines: { select: { description: true }, take: 1 } },
    }),
    db.paymentAllocation.findMany({
      where: { paymentId: invoice.paymentId },
      select: { billingStatementId: true, amount: true },
    }),
  ]);

  const allocatedTo = new Map(allocations.map((a) => [a.billingStatementId, a.amount]));

  return {
    company: getCompanyDetails(),
    invoice: {
      number: invoice.number,
      invoiceDate: invoice.invoiceDate,
      status: invoice.status,
      cancellationReason: invoice.cancellationReason,
      vatableSales: invoice.vatableSales,
      vatExemptSales: invoice.vatExemptSales,
      zeroRatedSales: invoice.zeroRatedSales,
      vatAmount: invoice.vatAmount,
      grossAmount: invoice.grossAmount,
      withholdingTaxAmount: invoice.withholdingTaxAmount,
      netAmountReceived: invoice.netAmountReceived,
    },
    customer: {
      // The registered name where there is one: a BIR document names the legal entity, not the
      // shorthand the sales team files it under.
      name: account?.legalName ?? account?.name ?? "Unknown customer",
      tin: account?.tin ?? null,
      addressLines: addressLines(account?.billingAddress),
    },
    payment: {
      number: payment?.number ?? "—",
      method: payment?.method ?? "unknown",
      reference: payment?.reference ?? null,
      receivedAt: payment?.receivedAt ?? invoice.invoiceDate,
    },
    statements: statements.map((statement) => ({
      number: statement.number,
      description: statement.lines[0]?.description ?? "Services rendered",
      amount: allocatedTo.get(statement.id) ?? 0,
    })),
  };
}

export async function renderServiceInvoicePdf(invoiceId: string): Promise<Buffer> {
  return renderToBuffer(
    <ServiceInvoiceDocument {...await buildServiceInvoicePdfProps(invoiceId)} />,
  );
}

/**
 * Assembling §3's billing statement — the document that asks for the money.
 *
 * Unlike the service invoice, nothing here is frozen at a prior moment: a statement can move through
 * `partially_paid` while more payments arrive, so `amountPaid`/`balance` are read live rather than
 * carried from when it was issued. That is correct for this document specifically, because it is not
 * the BIR record — it is allowed to say "here is what is now outstanding."
 */
export async function buildBillingStatementPdfProps(
  statementId: string,
): Promise<BillingStatementDocumentProps> {
  const statement = await db.billingStatement.findFirst({
    where: { id: statementId, deletedAt: null },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  if (!statement) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That statement no longer exists." });
  }

  const [account, salesOrder] = await Promise.all([
    db.customerAccount.findUnique({
      where: { id: statement.accountId },
      select: {
        name: true,
        legalName: true,
        tin: true,
        billingAddress: true,
        withholdsEWT: true,
      },
    }),
    statement.salesOrderId
      ? db.salesOrder.findUnique({
          where: { id: statement.salesOrderId },
          select: { number: true },
        })
      : Promise.resolve(null),
  ]);

  return {
    company: getCompanyDetails(),
    logoSrc: logoDataUri(),
    statement: {
      number: statement.number,
      type: statement.type,
      status: statement.status,
      statementDate: statement.statementDate,
      dueDate: statement.dueDate,
      subtotal: statement.subtotal,
      vatMode: statement.vatMode as BillingStatementDocumentProps["statement"]["vatMode"],
      vatAmount: statement.vatAmount,
      total: statement.total,
      expectedWithholdingAmount: statement.expectedWithholdingAmount,
      expectedNetCollectible: statement.expectedNetCollectible,
      amountPaid: statement.amountPaid,
      amountWithheldCredited: statement.amountWithheldCredited,
      balance: statement.balance,
      poReference: statement.poReference,
      drReferences: statement.drReferences,
      srReferences: statement.srReferences,
      tcCertificateRef: statement.tcCertificateRef,
      notes: statement.notes,
      terms: statement.terms,
      cancelledReason: statement.cancelledReason,
    },
    salesOrderNumber: salesOrder?.number ?? null,
    customer: {
      name: account?.legalName ?? account?.name ?? "Unknown customer",
      tin: account?.tin ?? null,
      addressLines: addressLines(account?.billingAddress),
      withholdsEWT: account?.withholdsEWT ?? false,
    },
    lines: statement.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity.toString(),
      unit: line.unit,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
    })),
  };
}

export async function renderBillingStatementPdf(statementId: string): Promise<Buffer> {
  return renderToBuffer(
    <BillingStatementDocument {...await buildBillingStatementPdfProps(statementId)} />,
  );
}

/**
 * Assembling §3.3/§5's statement of account — one customer's open statements, aged, generated fresh
 * on every request rather than read from a stored row (there is no stored row; see the document's own
 * note on why not).
 */
export async function buildStatementOfAccountPdfProps(
  accountId: string,
): Promise<StatementOfAccountDocumentProps> {
  const account = await db.customerAccount.findFirst({
    where: { id: accountId, deletedAt: null },
    select: {
      name: true,
      legalName: true,
      tin: true,
      code: true,
      billingAddress: true,
      withholdsEWT: true,
    },
  });
  if (!account) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That account no longer exists." });
  }

  // The exact filter `receivablesService` uses, scoped to one account: open, unpaid, not a draft
  // nobody has asked the customer for yet.
  const statements = await db.billingStatement.findMany({
    where: {
      accountId,
      deletedAt: null,
      status: { in: ["issued", "partially_paid", "overdue"] },
      balance: { gt: 0 },
    },
    orderBy: { dueDate: "asc" },
  });

  const now = new Date();
  const rows = statements.map((statement) => ({
    number: statement.number,
    statementDate: statement.statementDate,
    dueDate: statement.dueDate,
    total: statement.total,
    amountPaid: statement.amountPaid,
    balance: statement.balance,
    bucket: ageingBucket(statement.dueDate, now),
  }));

  const buckets: Record<AgeingBucket, number> = {
    current: 0,
    "1-30": 0,
    "31-60": 0,
    "61-90": 0,
    "90+": 0,
  };
  for (const row of rows) buckets[row.bucket] += row.balance;

  return {
    company: getCompanyDetails(),
    logoSrc: logoDataUri(),
    generatedAt: now,
    customer: {
      name: account.legalName ?? account.name,
      code: account.code,
      tin: account.tin ?? null,
      addressLines: addressLines(account.billingAddress),
      withholdsEWT: account.withholdsEWT,
    },
    rows,
    buckets,
    totalOutstanding: rows.reduce((sum, row) => sum + row.balance, 0),
  };
}

export async function renderStatementOfAccountPdf(accountId: string): Promise<Buffer> {
  return renderToBuffer(
    <StatementOfAccountDocument {...await buildStatementOfAccountPdfProps(accountId)} />,
  );
}
