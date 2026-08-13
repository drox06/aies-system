import { Document, Page, Text, View, Image } from "@react-pdf/renderer";
import { pdfStyles as s } from "./theme";

/**
 * The supplier price request (specs/02-quotation.md §3.2).
 *
 * §3.2 asks for two artefacts and they are not the same thing: a **request body** to paste into an
 * email, and a **PDF** to attach. The body is what a supplier's sales desk reads; this is what their
 * engineering department prints, marks up and files.
 *
 * So it is deliberately not a quotation with the prices removed. It carries no AIES pricing, no
 * customer name and no margin — a supplier who learns which customer this is for, and what AIES is
 * selling it at, has everything they need to go around AIES. What it does carry is the four things
 * §3.2 says a response must contain, printed as an empty column each, so the document itself asks
 * the questions.
 */

export interface RfqLine {
  lineNo: number;
  description: string;
  manufacturer: string | null;
  modelNumber: string | null;
  quantity: string;
  unit: string;
}

export interface RfqPdfProps {
  number: string;
  issuedOn: string;
  dueBy: string | null;
  company: { name: string; addressLines: string[]; tin: string; contactNumber: string };
  supplier: { name: string; contactName: string | null };
  /** Free text from whoever raised it — tolerances, a site constraint. */
  notes: string | null;
  lines: RfqLine[];
  requestedBy: string;
  logoSrc: string;
}

const COLS = { no: 24, desc: 210, qty: 60, price: 90, lead: 70, valid: 61 };

export function RfqDocument(props: RfqPdfProps) {
  return (
    <Document
      title={`${props.number} — request for pricing`}
      author={props.company.name}
      subject={`Request for pricing to ${props.supplier.name}`}
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
            <Text style={s.docTitle}>REQUEST FOR PRICING</Text>
            <Text style={[s.value, s.muted, { marginTop: 6, lineHeight: 1.35 }]}>
              {props.supplier.contactName
                ? `For the attention of ${props.supplier.contactName}, ${props.supplier.name}`
                : props.supplier.name}
            </Text>
          </View>
          <View style={{ textAlign: "right" }}>
            <Text style={s.docNumber}>{props.number}</Text>
            <Text style={s.small}>Issued {props.issuedOn}</Text>
            {props.dueBy && <Text style={s.small}>Response wanted by {props.dueBy}</Text>}
          </View>
        </View>

        <Text style={[s.value, { marginTop: 14 }]}>
          We are preparing a proposal for a customer and would be grateful for your best pricing on
          the items below. Please complete the four right-hand columns, or reply with your own
          quotation referencing {props.number}.
        </Text>

        {props.notes && <Text style={[s.small, s.muted, { marginTop: 6 }]}>{props.notes}</Text>}

        <View style={[s.tableHeader, { marginTop: 12 }]}>
          <Text style={[s.th, { width: COLS.no }]}>#</Text>
          <Text style={[s.th, { width: COLS.desc }]}>Item</Text>
          <Text style={[s.th, s.right, { width: COLS.qty }]}>Qty</Text>
          {/* Empty columns rather than a covering note: the document asks the questions itself, so a
              response that comes back on this page is already complete. */}
          <Text style={[s.th, s.right, { width: COLS.price }]}>Unit price</Text>
          <Text style={[s.th, s.right, { width: COLS.lead }]}>Lead time</Text>
          <Text style={[s.th, s.right, { width: COLS.valid }]}>Valid until</Text>
        </View>

        {props.lines.map((line) => (
          <View key={line.lineNo} style={s.tr} wrap={false}>
            <Text style={{ width: COLS.no }}>{line.lineNo}</Text>
            <View style={{ width: COLS.desc }}>
              <Text>{line.description}</Text>
              {(line.manufacturer ?? line.modelNumber) && (
                <Text style={[s.small, s.muted]}>
                  {[line.manufacturer, line.modelNumber].filter(Boolean).join(" · ")}
                </Text>
              )}
            </View>
            <Text style={[s.right, { width: COLS.qty }]}>
              {line.quantity} {line.unit}
            </Text>
            <Text style={[s.right, { width: COLS.price }]}> </Text>
            <Text style={[s.right, { width: COLS.lead }]}> </Text>
            <Text style={[s.right, { width: COLS.valid }]}> </Text>
          </View>
        ))}

        <Text style={[s.small, s.muted, { marginTop: 14 }]}>
          Please state the currency your prices are in, and whether they are ex-works or delivered.
        </Text>

        <View style={{ marginTop: 20 }}>
          <Text style={s.label}>Requested by</Text>
          <Text style={s.value}>{props.requestedBy}</Text>
        </View>

        <Text
          style={s.footer}
          fixed
          render={({ pageNumber, totalPages }) =>
            `${props.number} · Page ${pageNumber} of ${totalPages}`
          }
        />
      </Page>
    </Document>
  );
}
