import React from "react";
import { Document, Image, Page, Text, View } from "@react-pdf/renderer";
import { PDF_COLORS, pdfStyles as s } from "@/server/core/quotation/pdf/theme";
import type { CompanyDetails } from "@/server/core/company";
import { VAT_MODE_LABELS, type VatMode } from "@/server/core/finance/invoice-rules";
import { peso, asDate } from "./format";

/**
 * §3's Billing Statement — the document that actually asks the customer for money.
 *
 * ## What was missing
 *
 * §3's own table is explicit about what this record is for: "Demands payment for a milestone." Until
 * now `issueStatementService` only flipped a status column — nothing rendered, nothing printable,
 * nothing a finance person could attach to an email. A customer told "your statement has been issued"
 * had no document to point to. Found while walking §3 end to end with EA (2026-09-06); logged in
 * docs/DECISIONS.md #181.
 *
 * ## This is not the Service Invoice
 *
 * §3's two-document model again: this demands, the invoice receipts. This document never shows the
 * three-way VAT-able/exempt/zero-rated split §3.3 asks for on *invoice* PDFs specifically — that
 * breakdown is computed once, when the payment is recorded, and belongs on the document that triggers
 * VAT. Printing it here from figures that could still change before payment would risk a statement
 * that quietly disagreed with the invoice raised against it.
 *
 * ## Draft and cancelled both print, both say so
 *
 * A draft is still being checked and has not been sent to anyone — sending it by accident is a real
 * failure mode, so it carries a watermark nobody could miss. A cancelled statement is retained rather
 * than deleted (§3, same rule as the invoice series), so it still renders, marked, rather than
 * disappearing and leaving a number nobody can account for.
 */

export interface BillingStatementDocumentProps {
  company: CompanyDetails;
  logoSrc: string;
  statement: {
    number: string;
    type: string;
    status: string;
    statementDate: Date;
    dueDate: Date;
    /** Integer centavos throughout, like every finance figure in the platform. */
    subtotal: number;
    vatMode: VatMode;
    vatAmount: number;
    total: number;
    expectedWithholdingAmount: number;
    expectedNetCollectible: number;
    amountPaid: number;
    amountWithheldCredited: number;
    balance: number;
    poReference: string | null;
    drReferences: string[];
    srReferences: string[];
    tcCertificateRef: string | null;
    notes: string | null;
    terms: string | null;
    cancelledReason: string | null;
  };
  salesOrderNumber: string | null;
  customer: {
    name: string;
    tin: string | null;
    addressLines: string[];
    withholdsEWT: boolean;
  };
  lines: {
    description: string;
    /** Decimal as a string — printed as typed, trailing zeros trimmed. */
    quantity: string;
    unit: string;
    unitPrice: number;
    lineTotal: number;
  }[];
}

const COLS = { desc: 235, qty: 50, unit: 45, price: 90, total: 95 };

function qty(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toString() : value;
}

export function BillingStatementDocument({
  company,
  logoSrc,
  statement,
  salesOrderNumber,
  customer,
  lines,
}: BillingStatementDocumentProps) {
  const cancelled = statement.status === "cancelled";
  const draft = statement.status === "draft";
  const typeLabel = `${statement.type.replace(/_/g, " ")} statement`;

  return (
    <Document title={statement.number}>
      <Page size="A4" style={s.page}>
        {cancelled && (
          <View
            style={{ borderWidth: 2, borderColor: PDF_COLORS.danger, padding: 8, marginBottom: 12 }}
          >
            <Text style={{ fontFamily: "Helvetica-Bold", color: PDF_COLORS.danger, fontSize: 14 }}>
              CANCELLED
            </Text>
            <Text style={{ color: PDF_COLORS.danger, marginTop: 2 }}>
              This statement has been withdrawn. It is not a request for payment.
              {statement.cancelledReason ? ` Reason: ${statement.cancelledReason}` : ""}
            </Text>
          </View>
        )}

        <View style={s.headerRow}>
          {/* eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf's Image has no alt prop */}
          <Image src={logoSrc} style={s.logo} />
          <View style={s.companyBlock}>
            <Text style={s.companyName}>{company.name}</Text>
            {company.addressLines.map((line) => (
              <Text key={line}>{line}</Text>
            ))}
            <Text>TIN {company.tin}</Text>
            <Text>{company.contactNumber}</Text>
          </View>
        </View>
        <View style={s.headerRule} />

        <View style={s.headerRow}>
          <View style={{ maxWidth: 280 }}>
            <Text style={s.docTitle}>BILLING STATEMENT</Text>
            <Text style={[s.value, s.muted, { marginTop: 4, textTransform: "capitalize" }]}>
              {typeLabel}
            </Text>
          </View>
          <View style={{ textAlign: "right" }}>
            <Text style={s.docNumber}>{statement.number}</Text>
            <Text style={s.small}>Dated {asDate(statement.statementDate)}</Text>
            <Text style={s.small}>Due {asDate(statement.dueDate)}</Text>
          </View>
        </View>

        <View style={[s.twoCol, { marginTop: 14 }]}>
          <View style={s.col}>
            <Text style={s.label}>Bill to</Text>
            <Text style={[s.value, s.bold]}>{customer.name}</Text>
            {customer.addressLines.map((line, index) => (
              <Text key={index} style={s.value}>
                {line}
              </Text>
            ))}
            <Text style={s.value}>TIN: {customer.tin ?? "not on file"}</Text>
          </View>
          <View style={s.col}>
            <Text style={s.label}>Details</Text>
            <Text style={s.value}>Status: {statement.status.replace(/_/g, " ")}</Text>
            {salesOrderNumber && <Text style={s.value}>Sales order: {salesOrderNumber}</Text>}
            {statement.poReference && <Text style={s.value}>Your PO: {statement.poReference}</Text>}
          </View>
        </View>

        <Text style={s.sectionHeading}>What this covers</Text>
        <View style={s.tableHeader}>
          <Text style={[s.th, { width: COLS.desc }]}>Description</Text>
          {/* `paddingRight` rather than a gap on the row: a right-aligned cell's text sits flush
              against its own box edge, which is also where the left-aligned Unit column begins — with
              nothing between them the two words print as one ("QtyUnit"). */}
          <Text style={[s.th, s.right, { width: COLS.qty, paddingRight: 8 }]}>Qty</Text>
          <Text style={[s.th, { width: COLS.unit }]}>Unit</Text>
          <Text style={[s.th, s.right, { width: COLS.price }]}>Unit price</Text>
          <Text style={[s.th, s.right, { width: COLS.total }]}>Amount</Text>
        </View>
        {lines.map((line, index) => (
          <View key={index} style={s.tr}>
            <Text style={{ width: COLS.desc }}>{line.description}</Text>
            <Text style={[s.right, { width: COLS.qty, paddingRight: 8 }]}>
              {qty(line.quantity)}
            </Text>
            <Text style={{ width: COLS.unit }}>{line.unit}</Text>
            <Text style={[s.right, { width: COLS.price }]}>{peso(line.unitPrice)}</Text>
            <Text style={[s.right, { width: COLS.total }]}>{peso(line.lineTotal)}</Text>
          </View>
        ))}

        <View style={s.totalsBlock}>
          <View style={s.totalsRow}>
            <Text style={s.muted}>Subtotal</Text>
            <Text>{peso(statement.subtotal)}</Text>
          </View>
          {statement.vatAmount > 0 ? (
            <View style={s.totalsRow}>
              <Text style={s.muted}>VAT (12%)</Text>
              <Text>{peso(statement.vatAmount)}</Text>
            </View>
          ) : (
            <View style={s.totalsRow}>
              <Text style={s.muted}>VAT treatment</Text>
              <Text>{VAT_MODE_LABELS[statement.vatMode]}</Text>
            </View>
          )}
          <View style={s.totalsGrand}>
            <Text style={s.bold}>Amount due</Text>
            <Text style={s.bold}>{peso(statement.total)}</Text>
          </View>
          {statement.amountPaid > 0 && (
            <>
              <View style={s.totalsRow}>
                <Text style={s.muted}>Paid to date</Text>
                <Text>({peso(statement.amountPaid)})</Text>
              </View>
              {statement.amountWithheldCredited > 0 && (
                <View style={s.totalsRow}>
                  <Text style={s.muted}>Withheld tax credited</Text>
                  <Text>({peso(statement.amountWithheldCredited)})</Text>
                </View>
              )}
              <View style={s.totalsGrand}>
                <Text style={s.bold}>Balance still due</Text>
                <Text style={s.bold}>{peso(statement.balance)}</Text>
              </View>
            </>
          )}
        </View>

        {/*
          §3.2: "statements show the expected net collectible when the account withholds, so nobody
          is surprised when less money arrives than the statement said." Shown only while nothing has
          been paid yet — once a payment lands, the totals block above states the real figures.
        */}
        {!cancelled &&
          customer.withholdsEWT &&
          statement.expectedWithholdingAmount > 0 &&
          statement.amountPaid === 0 && (
            <Text style={{ marginTop: 8, fontSize: 8, color: PDF_COLORS.textMuted }}>
              This account withholds tax. Expect {peso(statement.expectedNetCollectible)} to arrive
              against this statement, with {peso(statement.expectedWithholdingAmount)} creditable
              once your BIR Form 2307 is received.
            </Text>
          )}

        {/* §3's supporting references — named because a collections conversation is won by naming
            the documents rather than insisting. */}
        {(statement.drReferences.length > 0 ||
          statement.srReferences.length > 0 ||
          statement.tcCertificateRef) && (
          <View style={{ marginTop: 14 }}>
            <Text style={s.sectionHeading}>References</Text>
            {statement.drReferences.length > 0 && (
              <Text style={s.value}>Delivery receipts: {statement.drReferences.join(", ")}</Text>
            )}
            {statement.srReferences.length > 0 && (
              <Text style={s.value}>Service reports: {statement.srReferences.join(", ")}</Text>
            )}
            {statement.tcCertificateRef && (
              <Text style={s.value}>T&C certificate: {statement.tcCertificateRef}</Text>
            )}
          </View>
        )}

        {statement.notes && (
          <View style={{ marginTop: 14 }}>
            <Text style={s.sectionHeading}>Notes</Text>
            <Text style={s.value}>{statement.notes}</Text>
          </View>
        )}

        {statement.terms && (
          <View style={{ marginTop: 14 }}>
            <Text style={s.sectionHeading}>Terms</Text>
            <Text style={s.value}>{statement.terms}</Text>
          </View>
        )}

        {draft && (
          <Text
            fixed
            style={{
              position: "absolute",
              top: 330,
              left: 0,
              right: 0,
              textAlign: "center",
              fontFamily: "Helvetica-Bold",
              fontSize: 70,
              color: PDF_COLORS.textMuted,
              opacity: 0.3,
              transform: "rotate(-28deg)",
            }}
          >
            DRAFT
          </Text>
        )}

        <View style={s.footer} fixed>
          <Text>
            {statement.number} · Not a BIR receipt — the Service Invoice, issued on payment, is that
            document.
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
