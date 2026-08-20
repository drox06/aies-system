import React from "react";
import { Document, Page, Text, View } from "@react-pdf/renderer";
import { PDF_COLORS, pdfStyles } from "@/server/core/quotation/pdf/theme";
import type { CompanyDetails } from "@/server/core/company";

/**
 * §3's Service Invoice — the BIR document evidencing the sale.
 *
 * ## Why this is not the quotation document with different words
 *
 * A quotation is a commercial offer AIES can lay out as it likes. This is a **statutory document**,
 * and §3.3 names what it must carry: the VAT breakdown, the company TIN, and the customer TIN. The
 * layout is therefore built around those rather than around looking handsome — the VAT summary is a
 * block of its own, and the two TINs sit where somebody checking compliance looks first.
 *
 * It was also, until 2026-08-20, **not built at all**. AIES issued BIR-numbered invoices and could
 * neither print nor send them, because the two-document model's second half stopped at a database
 * row. docs/DECISIONS.md #135.
 *
 * ## The cancelled case is printed, not hidden
 *
 * §3: *"Cancelled or voided invoices are retained and marked, never deleted or renumbered."* A
 * cancelled invoice still prints, with the cancellation across it, because the number exists in the
 * BIR series and AIES has to be able to account for it. Refusing to render it would leave the
 * company unable to show what a number was used for — which is precisely what BIR asks.
 */

export interface ServiceInvoiceDocumentProps {
  company: CompanyDetails;
  invoice: {
    number: string;
    invoiceDate: Date;
    status: string;
    cancellationReason: string | null;
    /** Integer centavos throughout, as everywhere §3 touches. */
    vatableSales: number;
    vatExemptSales: number;
    zeroRatedSales: number;
    vatAmount: number;
    grossAmount: number;
    withholdingTaxAmount: number;
    netAmountReceived: number;
  };
  customer: {
    name: string;
    tin: string | null;
    addressLines: string[];
  };
  payment: {
    number: string;
    method: string;
    reference: string | null;
    receivedAt: Date;
  };
  /** The statements this invoice settles — §3 models the relationship through the payment. */
  statements: { number: string; description: string; amount: number }[];
}

const peso = (centavos: number) =>
  `PHP ${(centavos / 100).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const asDate = (value: Date) =>
  value.toLocaleDateString("en-PH", { day: "numeric", month: "long", year: "numeric" });

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 2 }}>
      <Text style={bold ? { fontFamily: "Helvetica-Bold" } : undefined}>{label}</Text>
      <Text style={bold ? { fontFamily: "Helvetica-Bold" } : undefined}>{value}</Text>
    </View>
  );
}

export function ServiceInvoiceDocument({
  company,
  invoice,
  customer,
  payment,
  statements,
}: ServiceInvoiceDocumentProps) {
  const cancelled = invoice.status === "cancelled";

  return (
    <Document title={invoice.number}>
      <Page size="A4" style={pdfStyles.page}>
        {/*
          The cancellation, first and unmissable.

          A cancelled invoice that looks like a valid one is worse than no document — somebody will
          file it. It prints because the number must be accountable, and it says so at the top.
        */}
        {cancelled && (
          <View
            style={{
              borderWidth: 2,
              borderColor: PDF_COLORS.danger,
              padding: 8,
              marginBottom: 12,
            }}
          >
            <Text style={{ fontFamily: "Helvetica-Bold", color: PDF_COLORS.danger, fontSize: 14 }}>
              CANCELLED
            </Text>
            <Text style={{ color: PDF_COLORS.danger, marginTop: 2 }}>
              This invoice has been cancelled and is not valid for input VAT.
              {invoice.cancellationReason ? ` Reason: ${invoice.cancellationReason}` : ""}
            </Text>
          </View>
        )}

        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <View style={{ maxWidth: 280 }}>
            <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 13, color: PDF_COLORS.navy800 }}>
              {company.name}
            </Text>
            {company.addressLines.map((line) => (
              <Text key={line} style={{ color: PDF_COLORS.textMuted }}>
                {line}
              </Text>
            ))}
            <Text style={{ marginTop: 2 }}>TIN: {company.tin}</Text>
            <Text style={{ color: PDF_COLORS.textMuted }}>{company.contactNumber}</Text>
          </View>

          <View style={{ alignItems: "flex-end" }}>
            <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 16, color: PDF_COLORS.navy800 }}>
              SERVICE INVOICE
            </Text>
            <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 12, marginTop: 2 }}>
              {invoice.number}
            </Text>
            <Text style={{ color: PDF_COLORS.textMuted, marginTop: 2 }}>
              {asDate(invoice.invoiceDate)}
            </Text>
          </View>
        </View>

        <View
          style={{
            marginTop: 16,
            borderTopWidth: 1,
            borderTopColor: PDF_COLORS.border,
            paddingTop: 10,
          }}
        >
          <Text style={{ color: PDF_COLORS.textMuted, fontSize: 8 }}>BILLED TO</Text>
          <Text style={{ fontFamily: "Helvetica-Bold", marginTop: 2 }}>{customer.name}</Text>
          {customer.addressLines.map((line, index) => (
            <Text key={index} style={{ color: PDF_COLORS.textMuted }}>
              {line}
            </Text>
          ))}
          {/*
            The customer's TIN, and its absence said out loud.

            §3.3 requires it on the document. A blank line would let an invoice go out looking
            complete while missing something the BIR expects, so a missing TIN prints as missing.
          */}
          <Text style={{ marginTop: 2 }}>
            TIN: {customer.tin ?? "not on file — obtain before filing"}
          </Text>
        </View>

        <View style={{ marginTop: 16 }}>
          <Text style={{ color: PDF_COLORS.textMuted, fontSize: 8 }}>FOR</Text>
          {statements.map((statement) => (
            <View
              key={statement.number}
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                marginTop: 4,
                borderBottomWidth: 1,
                borderBottomColor: PDF_COLORS.border,
                paddingBottom: 4,
              }}
            >
              <View style={{ maxWidth: 380 }}>
                <Text>{statement.description}</Text>
                <Text style={{ color: PDF_COLORS.textMuted, fontSize: 8 }}>
                  Statement {statement.number}
                </Text>
              </View>
              <Text>{peso(statement.amount)}</Text>
            </View>
          ))}
        </View>

        {/*
          §3.3's VAT breakdown.

          All three sales classes are printed even at zero, because a BIR-facing document that omits
          a class leaves the reader unable to tell "none" from "not considered" — the same rule this
          platform applies to an empty cost category or an unanswered warranty date.
        */}
        <View
          style={{
            marginTop: 16,
            backgroundColor: PDF_COLORS.surface2,
            padding: 10,
            width: 280,
            alignSelf: "flex-end",
          }}
        >
          <Row label="VAT-able sales" value={peso(invoice.vatableSales)} />
          <Row label="VAT-exempt sales" value={peso(invoice.vatExemptSales)} />
          <Row label="Zero-rated sales" value={peso(invoice.zeroRatedSales)} />
          <Row label="VAT (12%)" value={peso(invoice.vatAmount)} />
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: PDF_COLORS.border,
              marginTop: 4,
              paddingTop: 4,
            }}
          >
            <Row label="Total amount due" value={peso(invoice.grossAmount)} bold />
          </View>
          {invoice.withholdingTaxAmount > 0 && (
            <>
              <Row
                label="Less: creditable tax withheld"
                value={`(${peso(invoice.withholdingTaxAmount)})`}
              />
              <Row label="Net amount received" value={peso(invoice.netAmountReceived)} bold />
            </>
          )}
        </View>

        <View
          style={{
            marginTop: 16,
            borderTopWidth: 1,
            borderTopColor: PDF_COLORS.border,
            paddingTop: 10,
          }}
        >
          <Text style={{ color: PDF_COLORS.textMuted, fontSize: 8 }}>PAYMENT RECEIVED</Text>
          <Text style={{ marginTop: 2 }}>
            {payment.method.replace(/_/g, " ")} on {asDate(payment.receivedAt)}
            {payment.reference ? ` · ${payment.reference}` : ""} · {payment.number}
          </Text>
          {invoice.withholdingTaxAmount > 0 && (
            <Text style={{ marginTop: 4, color: PDF_COLORS.textMuted }}>
              A BIR Form 2307 is required for the creditable tax withheld shown above.
            </Text>
          )}
        </View>

        <Text
          fixed
          style={{
            position: "absolute",
            bottom: 24,
            left: 40,
            right: 40,
            fontSize: 7,
            color: PDF_COLORS.textMuted,
            textAlign: "center",
          }}
        >
          {company.name} · TIN {company.tin} · This serves as your official receipt for the services
          rendered.
        </Text>
      </Page>
    </Document>
  );
}
