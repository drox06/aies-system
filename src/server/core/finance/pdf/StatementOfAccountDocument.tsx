import React from "react";
import { Document, Image, Page, Text, View } from "@react-pdf/renderer";
import { PDF_COLORS, pdfStyles as s } from "@/server/core/quotation/pdf/theme";
import type { CompanyDetails } from "@/server/core/company";
import type { AgeingBucket } from "@/server/core/finance/invoice-rules";
import { peso, asDate, shortDate } from "./format";

/**
 * §3.3 and §5's "Statement of account PDF per customer, generated on demand" — named twice in the
 * spec, once from the BIR/withholding side and once from the receivables side, because it is the
 * same document read two ways: what one customer currently owes AIES, aged.
 *
 * ## Generated, not stored
 *
 * Unlike a `BillingStatement` or `ServiceInvoice`, this carries no number and no row of its own. It
 * is a live read of `receivablesService`'s own data (open, unpaid statements) filtered to one
 * account — correct by construction, because there is only one place that figure is computed. Two
 * requests five minutes apart can legitimately produce different totals, which is right: it says what
 * is owed *now*, not what was owed when somebody last opened the screen.
 *
 * ## Only what is actually outstanding
 *
 * Drafts are excluded — nothing not yet issued has been asked of the customer, so it has no business
 * on a document telling them what they owe. Paid and cancelled statements are excluded for the same
 * reason `receivablesService` excludes them: this is a "what is left" document, not a full history.
 */

const BUCKET_LABELS: Readonly<Record<AgeingBucket, string>> = {
  current: "Not yet due",
  "1-30": "1-30 days",
  "31-60": "31-60 days",
  "61-90": "61-90 days",
  "90+": "Over 90 days",
};

export interface StatementOfAccountDocumentProps {
  company: CompanyDetails;
  logoSrc: string;
  generatedAt: Date;
  customer: {
    name: string;
    code: string;
    tin: string | null;
    addressLines: string[];
    withholdsEWT: boolean;
  };
  rows: {
    number: string;
    statementDate: Date;
    dueDate: Date;
    /** Integer centavos throughout. */
    total: number;
    amountPaid: number;
    balance: number;
    bucket: AgeingBucket;
  }[];
  buckets: Readonly<Record<AgeingBucket, number>>;
  totalOutstanding: number;
}

const COLS = { number: 95, dated: 75, due: 75, total: 85, paid: 85, balance: 100 };
const BUCKETS: readonly AgeingBucket[] = ["current", "1-30", "31-60", "61-90", "90+"];

export function StatementOfAccountDocument({
  company,
  logoSrc,
  generatedAt,
  customer,
  rows,
  buckets,
  totalOutstanding,
}: StatementOfAccountDocumentProps) {
  return (
    <Document title={`Statement of account — ${customer.name}`}>
      <Page size="A4" style={s.page}>
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
            <Text style={s.docTitle}>STATEMENT OF ACCOUNT</Text>
            <Text style={[s.value, s.muted, { marginTop: 4 }]}>
              What is currently owed, as of the date below.
            </Text>
          </View>
          <View style={{ textAlign: "right" }}>
            <Text style={s.small}>Generated {asDate(generatedAt)}</Text>
          </View>
        </View>

        <View style={{ marginTop: 14 }}>
          <Text style={s.label}>Account</Text>
          <Text style={[s.value, s.bold]}>{customer.name}</Text>
          <Text style={s.value}>{customer.code}</Text>
          {customer.addressLines.map((line, index) => (
            <Text key={index} style={s.value}>
              {line}
            </Text>
          ))}
          <Text style={s.value}>TIN: {customer.tin ?? "not on file"}</Text>
        </View>

        {rows.length === 0 ? (
          <Text style={[s.value, { marginTop: 20 }]}>
            No open statements. This account has no outstanding balance as of the date above.
          </Text>
        ) : (
          <>
            <Text style={s.sectionHeading}>Ageing</Text>
            <View style={s.tableHeader}>
              {BUCKETS.map((bucket) => (
                <Text key={bucket} style={[s.th, s.right, { width: 515 / BUCKETS.length }]}>
                  {BUCKET_LABELS[bucket]}
                </Text>
              ))}
            </View>
            <View style={s.tr}>
              {BUCKETS.map((bucket) => (
                <Text key={bucket} style={[s.right, { width: 515 / BUCKETS.length }]}>
                  {peso(buckets[bucket])}
                </Text>
              ))}
            </View>

            <Text style={[s.sectionHeading, { marginTop: 16 }]}>Open statements</Text>
            <View style={s.tableHeader}>
              <Text style={[s.th, { width: COLS.number }]}>Statement</Text>
              <Text style={[s.th, { width: COLS.dated }]}>Dated</Text>
              <Text style={[s.th, { width: COLS.due }]}>Due</Text>
              <Text style={[s.th, s.right, { width: COLS.total }]}>Total</Text>
              <Text style={[s.th, s.right, { width: COLS.paid }]}>Paid</Text>
              <Text style={[s.th, s.right, { width: COLS.balance }]}>Balance</Text>
            </View>
            {rows.map((row) => (
              <View key={row.number} style={s.tr}>
                <Text style={{ width: COLS.number }}>{row.number}</Text>
                <Text style={{ width: COLS.dated }}>{shortDate(row.statementDate)}</Text>
                <Text style={{ width: COLS.due }}>{shortDate(row.dueDate)}</Text>
                <Text style={[s.right, { width: COLS.total }]}>{peso(row.total)}</Text>
                <Text style={[s.right, { width: COLS.paid }]}>{peso(row.amountPaid)}</Text>
                <View style={{ width: COLS.balance }}>
                  <Text style={s.right}>{peso(row.balance)}</Text>
                  <Text style={[s.right, s.small, s.muted]}>{BUCKET_LABELS[row.bucket]}</Text>
                </View>
              </View>
            ))}

            <View style={s.totalsBlock}>
              <View style={s.totalsGrand}>
                <Text style={s.bold}>Total outstanding</Text>
                <Text style={s.bold}>{peso(totalOutstanding)}</Text>
              </View>
            </View>

            {customer.withholdsEWT && (
              <Text style={{ marginTop: 8, fontSize: 8, color: PDF_COLORS.textMuted }}>
                This account withholds tax. The balances above are the full amounts billed; less
                will arrive in cash where a BIR Form 2307 is owed against a payment.
              </Text>
            )}
          </>
        )}

        <View style={s.footer} fixed>
          <Text>Statement of account · {customer.name}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
