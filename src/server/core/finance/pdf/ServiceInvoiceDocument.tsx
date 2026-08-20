import React from "react";
import { Document, Page, Text, View } from "@react-pdf/renderer";
import { PDF_COLORS, pdfStyles } from "@/server/core/quotation/pdf/theme";
import type { CompanyDetails } from "@/server/core/company";

/**
 * §3's Service Invoice — the platform's record of the sale, and a reference for the official form.
 *
 * ## What this document is, and is not
 *
 * **It is not the official service invoice.** AIES issues that on an external, BIR-registered form,
 * which the company confirmed on 2026-08-20. This is the platform's record of the same transaction,
 * laid out so whoever fills that form has every figure in one place.
 *
 * That distinction is the reason the layout still follows §3.3 exactly — the VAT breakdown as its
 * own block, both TINs, all three sales classes. A reference document is only useful if it carries
 * precisely what the official one needs, in a shape somebody can transcribe without re-deriving
 * anything. Making it *look* less like an invoice would make it worse at its actual job.
 *
 * The footer says which it is, because a document that carries a number, a VAT breakdown and two
 * TINs will otherwise be taken for the real thing by somebody who has not been told.
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
            {/*
              Named for what it is, at the size somebody actually reads.

              "SERVICE INVOICE" alone, over a number in a BIR-looking series, is a document that
              gets filed as the real thing by anybody who does not reach the footer. The company
              confirmed on 2026-08-20 that the official invoice is issued on an external registered
              form and this never goes to a customer — so the heading says so rather than relying on
              a reader getting to the bottom of the page.
            */}
            <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 16, color: PDF_COLORS.navy800 }}>
              SERVICE INVOICE
            </Text>
            <Text
              style={{
                fontFamily: "Helvetica-Bold",
                fontSize: 9,
                color: PDF_COLORS.textMuted,
                letterSpacing: 1,
              }}
            >
              REFERENCE COPY
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
        <View style={{ marginTop: 16, width: 280, alignSelf: "flex-end" }}>
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

        {/*
          Not the official document.

          AIES issues its official service invoice on an external, BIR-registered form. This one is
          the platform's record of the same sale, printed so whoever fills that form has every
          figure in front of them — the VAT split, the withholding and the net — without going back
          through three screens to assemble it.

          The company said so on 2026-08-20, and the footer had to change with it: it previously
          read "this serves as your official receipt", which was a claim the platform is not
          entitled to make and which a customer could reasonably have filed as one.
        */}
        {/*
          The watermark, painted last so it sits over the content rather than under it.

          @react-pdf paints in document order, so "on top" means "written last" — it was drawn first
          and therefore behind, which on a page this dense meant it barely read at all.

          Over the top means it has to be much lighter than it would need to be underneath: this is a
          working sheet somebody transcribes figures from, and a watermark that obscures a single
          digit destroys the only purpose the document has. `surface2` is the palest token in the
          set. `fixed` so it repeats if the statement list ever runs to a second page.
        */}
        <Text
          fixed
          style={{
            position: "absolute",
            top: 330,
            left: 0,
            right: 0,
            textAlign: "center",
            fontFamily: "Helvetica-Bold",
            fontSize: 62,
            color: PDF_COLORS.surface2,
            transform: "rotate(-28deg)",
          }}
        >
          REFERENCE
        </Text>

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
          This serves as a reference for the official service invoice.
        </Text>
      </Page>
    </Document>
  );
}
