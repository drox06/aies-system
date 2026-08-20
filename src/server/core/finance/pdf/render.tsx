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
import {
  ServiceInvoiceDocument,
  type ServiceInvoiceDocumentProps,
} from "@/server/core/finance/pdf/ServiceInvoiceDocument";

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
