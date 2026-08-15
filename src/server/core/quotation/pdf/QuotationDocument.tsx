import { Document, Image, Page, Text, View } from "@react-pdf/renderer";
import { pdfStyles as s } from "./theme";

/**
 * The customer-facing quotation PDF (specs/02-quotation.md §7).
 *
 * ## Cost cannot appear here, because it cannot be expressed here
 *
 * §7: "Line-item **cost columns must never appear** on the customer PDF." That is enforced by the
 * type, not by remembering: `CustomerLine` has no cost, markup or margin field, so a future edit
 * that tries to print one does not compile. The internal costing sheet is a separate document with
 * a separate props type.
 *
 * This matters more than the usual "types catch bugs" argument. A cost column leaking onto a
 * customer quotation is not a rendering glitch — it is AIES's margin handed to the buyer, in a
 * document they keep, discovered only when they use it in the next negotiation.
 *
 * ## Sections
 *
 * §7 lists them and this follows in order: header block with company details and document number,
 * customer and site block, scope of work, line table (grouped, optional lines separated and
 * excluded from the total), commercial summary, delivery lead time, payment terms, warranty,
 * validity, exclusions and assumptions, standard terms, signature block.
 */

export interface CustomerLine {
  lineNo: number;
  groupLabel: string | null;
  description: string;
  longDescription: string | null;
  manufacturer: string | null;
  modelNumber: string | null;
  quantity: string;
  unit: string;
  /** Formatted for display, currency symbol included — the document does no arithmetic. */
  unitPrice: string;
  lineTotal: string;
  leadTimeDays: number | null;
  isOptional: boolean;
}

export interface CustomerQuotationPdfProps {
  documentNumber: string;
  revision: number;
  title: string;
  issuedOn: string;
  validUntil: string;

  company: { name: string; addressLines: string[]; tin: string; contactNumber: string };

  customer: {
    name: string;
    code: string;
    address: string | null;
    contactName: string | null;
    contactEmail: string | null;
  };
  site: { name: string; address: string | null } | null;

  scopeOfWork: string;
  exclusions: string | null;
  assumptions: string | null;

  lines: CustomerLine[];

  /** Pre-formatted money strings. The document renders; the server decides. */
  totals: {
    subtotal: string;
    discount: string | null;
    /** e.g. "7.5%", so the reduction is legible as a rate and not only as an amount. */
    discountPct: string | null;
    /** The subtotal after the discount, stated explicitly rather than left to be inferred. */
    netAfterDiscount: string | null;
    vatLabel: string;
    vat: string | null;
    grandTotal: string;
  };

  terms: {
    deliveryLeadTime: string | null;
    incoterm: string | null;
    paymentTerms: string | null;
    warranty: string | null;
  };

  preparedBy: string;
  /** Absolute path or data URI to the lockup PNG. */
  logoSrc: string;
  standardTerms: string[];
}

const COLS = { no: 24, desc: 231, qty: 46, unit: 32, price: 88, total: 94 };

export function QuotationDocument(props: CustomerQuotationPdfProps) {
  const counted = props.lines.filter((line) => !line.isOptional);
  const optional = props.lines.filter((line) => line.isOptional);

  return (
    <Document
      title={`${props.documentNumber} — ${props.title}`}
      author={props.company.name}
      subject={`Quotation for ${props.customer.name}`}
    >
      <Page size="A4" style={s.page}>
        <View style={s.headerRow} fixed>
          {/* eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf's Image has no alt prop */}
          <Image src={props.logoSrc} style={s.logo} />
          <View style={s.companyBlock}>
            <Text style={s.companyName}>{props.company.name}</Text>
            {props.company.addressLines.map((line) => (
              <Text key={line}>{line}</Text>
            ))}
            <Text>TIN {props.company.tin}</Text>
            <Text>{props.company.contactNumber}</Text>
          </View>
        </View>
        <View style={s.headerRule} fixed />

        <View style={s.headerRow}>
          <View style={{ maxWidth: 330 }}>
            <Text style={s.docTitle}>QUOTATION</Text>
            {/* The proposal title sits directly under the word QUOTATION and was crowding it. A
                long title also has to be allowed to wrap without colliding with the number block
                on the right, hence the width cap above. */}
            <Text style={[s.value, s.muted, { marginTop: 6, lineHeight: 1.35 }]}>
              {props.title}
            </Text>
          </View>
          <View style={{ textAlign: "right" }}>
            <Text style={s.docNumber}>{props.documentNumber}</Text>
            <Text style={s.small}>Issued {props.issuedOn}</Text>
            <Text style={s.small}>Valid until {props.validUntil}</Text>
          </View>
        </View>

        <View style={[s.twoCol, { marginTop: 14 }]}>
          <View style={s.col}>
            <Text style={s.label}>Quotation to</Text>
            <Text style={[s.value, s.bold]}>{props.customer.name}</Text>
            {props.customer.address && <Text style={s.value}>{props.customer.address}</Text>}
            {props.customer.contactName && (
              <Text style={s.value}>Attn: {props.customer.contactName}</Text>
            )}
            {props.customer.contactEmail && (
              <Text style={[s.value, s.muted]}>{props.customer.contactEmail}</Text>
            )}
          </View>
          <View style={s.col}>
            {/* §5's site access notes are internal; only the site's identity belongs here. */}
            <Text style={s.label}>Site</Text>
            <Text style={s.value}>{props.site?.name ?? props.customer.name}</Text>
            {props.site?.address && <Text style={s.value}>{props.site.address}</Text>}
          </View>
        </View>

        <Text style={s.sectionHeading}>Scope of work</Text>
        <Text style={s.value}>{props.scopeOfWork || "—"}</Text>

        <Text style={s.sectionHeading}>Pricing</Text>
        <LineTable lines={counted} />

        {optional.length > 0 && (
          <>
            {/* §7: optional lines "clearly separated and excluded from the total". */}
            <Text style={[s.sectionHeading, { marginTop: 10 }]}>Optional items</Text>
            <LineTable lines={optional} />
            <Text style={s.optionalNote}>
              Optional items are quoted for your consideration and are not included in the total
              below.
            </Text>
          </>
        )}

        <View style={s.totalsBlock}>
          <View style={s.totalsRow}>
            <Text style={s.muted}>Subtotal</Text>
            <Text>{props.totals.subtotal}</Text>
          </View>
          {/* §8's negotiated price, shown as three steps rather than one number.
              The line amounts above are the full price, so a customer can see what was quoted,
              what came off, and what is left — reducing the line amounts *and* printing a discount
              row would show the same reduction twice. */}
          {props.totals.discount && (
            <>
              <View style={s.totalsRow}>
                <Text style={s.muted}>
                  Less discount{props.totals.discountPct ? ` (${props.totals.discountPct})` : ""}
                </Text>
                <Text>− {props.totals.discount}</Text>
              </View>
              {props.totals.netAfterDiscount && (
                <View style={s.totalsRow}>
                  <Text style={s.muted}>Subtotal after discount</Text>
                  <Text>{props.totals.netAfterDiscount}</Text>
                </View>
              )}
            </>
          )}
          {props.totals.vat && (
            <View style={s.totalsRow}>
              <Text style={s.muted}>{props.totals.vatLabel}</Text>
              <Text>{props.totals.vat}</Text>
            </View>
          )}
          <View style={s.totalsGrand}>
            <Text style={s.bold}>Total</Text>
            <Text style={s.bold}>{props.totals.grandTotal}</Text>
          </View>
        </View>

        <Text style={s.sectionHeading}>Commercial terms</Text>
        <View style={s.twoCol}>
          <View style={s.col}>
            <Term label="Delivery lead time" value={props.terms.deliveryLeadTime} />
            <Term label="Delivery term" value={props.terms.incoterm} />
          </View>
          <View style={s.col}>
            <Term label="Payment terms" value={props.terms.paymentTerms} />
            <Term label="Warranty" value={props.terms.warranty} />
          </View>
        </View>

        {(props.exclusions || props.assumptions) && (
          <>
            <Text style={s.sectionHeading}>Exclusions and assumptions</Text>
            {props.exclusions && (
              <Text style={s.value}>
                <Text style={s.bold}>Exclusions: </Text>
                {props.exclusions}
              </Text>
            )}
            {props.assumptions && (
              <Text style={s.value}>
                <Text style={s.bold}>Assumptions: </Text>
                {props.assumptions}
              </Text>
            )}
          </>
        )}

        <Text style={s.sectionHeading}>Terms and conditions</Text>
        <View>
          {props.standardTerms.map((term, index) => (
            <Text key={index} style={s.terms}>
              {index + 1}. {term}
            </Text>
          ))}
        </View>

        <View style={s.signatureRow} wrap={false}>
          <View style={s.signatureBox}>
            <Text style={s.label}>Prepared by</Text>
            <View style={s.signatureLine}>
              <Text style={s.small}>{props.preparedBy}</Text>
              <Text style={[s.small, s.muted]}>{props.company.name}</Text>
            </View>
          </View>
          <View style={s.signatureBox}>
            <Text style={s.label}>Conforme — accepted by</Text>
            <View style={s.signatureLine}>
              <Text style={[s.small, s.muted]}>Name, signature and date</Text>
              <Text style={[s.small, s.muted]}>{props.customer.name}</Text>
            </View>
          </View>
        </View>

        <View style={s.footer} fixed>
          <Text>
            Doc No. {props.documentNumber} · Rev. {props.revision}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

function Term({ label, value }: { label: string; value: string | null }) {
  return (
    <View style={{ marginBottom: 4 }}>
      <Text style={s.label}>{label}</Text>
      <Text style={s.value}>{value || "—"}</Text>
    </View>
  );
}

/**
 * The line table, grouped by `groupLabel`.
 *
 * Groups are rendered in first-appearance order rather than sorted, because the order the preparer
 * chose is the order the customer will read — §2's grouping is "Supply / Installation / Spares",
 * which is a narrative sequence, not an alphabet.
 */
function LineTable({ lines }: { lines: CustomerLine[] }) {
  const groups: { label: string | null; lines: CustomerLine[] }[] = [];
  for (const line of lines) {
    const label = line.groupLabel?.trim() || null;
    const last = groups.at(-1);
    if (last && last.label === label) last.lines.push(line);
    else groups.push({ label, lines: [line] });
  }

  return (
    <View>
      <View style={s.tableHeader} fixed>
        <Text style={[s.th, { width: COLS.no }]}>#</Text>
        <Text style={[s.th, { width: COLS.desc }]}>Description</Text>
        <Text style={[s.th, s.right, { width: COLS.qty }]}>Qty</Text>
        <Text style={[s.th, { width: COLS.unit }]}>Unit</Text>
        <Text style={[s.th, s.right, { width: COLS.price }]}>Unit price</Text>
        <Text style={[s.th, s.right, { width: COLS.total }]}>Amount</Text>
      </View>

      {groups.map((group, groupIndex) => (
        <View key={groupIndex}>
          {group.label && (
            <View style={s.groupRow}>
              <Text style={s.groupLabel}>{group.label}</Text>
            </View>
          )}
          {group.lines.map((line) => (
            <View key={line.lineNo} style={s.tr} wrap={false}>
              <Text style={{ width: COLS.no }}>{line.lineNo}</Text>
              <View style={{ width: COLS.desc }}>
                <Text>{line.description}</Text>
                {(line.manufacturer || line.modelNumber) && (
                  <Text style={[s.small, s.muted]}>
                    {[line.manufacturer, line.modelNumber].filter(Boolean).join(" ")}
                  </Text>
                )}
                {line.longDescription && (
                  <Text style={[s.small, s.muted]}>{line.longDescription}</Text>
                )}
                {line.leadTimeDays !== null && (
                  <Text style={[s.small, s.muted]}>Lead time {line.leadTimeDays} days</Text>
                )}
              </View>
              <Text style={[s.right, { width: COLS.qty }]}>{line.quantity}</Text>
              <Text style={{ width: COLS.unit }}>{line.unit}</Text>
              <Text style={[s.right, { width: COLS.price }]}>{line.unitPrice}</Text>
              <Text style={[s.right, { width: COLS.total }]}>{line.lineTotal}</Text>
            </View>
          ))}
        </View>
      ))}

      {lines.length === 0 && (
        <View style={s.tr}>
          <Text style={s.muted}>No items.</Text>
        </View>
      )}
    </View>
  );
}
