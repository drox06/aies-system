import { Document, Page, Text, View } from "@react-pdf/renderer";
import { PDF_COLORS, pdfStyles as s } from "./theme";

/**
 * The internal costing sheet (specs/02-quotation.md §7).
 *
 * "Build a separate internal costing sheet PDF for management, watermarked INTERNAL."
 *
 * A **separate document with a separate props type**, not a flag on the customer one. A single
 * component with `showCosts` would be one boolean away from printing margin on a document a
 * customer keeps, and that boolean would eventually be passed from a variable. Two documents cannot
 * make that mistake.
 *
 * It is deliberately plain. Nobody signs this, nobody receives it, and the only questions it
 * answers are "what did this cost us" and "where is the margin thin".
 */

export interface CostingLine {
  lineNo: number;
  groupLabel: string | null;
  description: string;
  quantity: string;
  unit: string;
  /** Landed cost in the quotation's currency, pre-formatted. */
  unitCost: string;
  unitPrice: string;
  lineCost: string;
  lineTotal: string;
  lineMargin: string;
  /** Percent, one decimal, or null when the line has no price. */
  marginPct: string | null;
  belowFloor: boolean;
  isOptional: boolean;
}

export interface CostingSheetPdfProps {
  documentNumber: string;
  revision: number;
  title: string;
  generatedOn: string;
  generatedFor: string;

  company: { name: string };
  customer: { name: string; code: string };

  currency: string;
  /** The FX assumptions the costs were landed at — §4 wants the buffer shown, not hidden. */
  fxNote: string | null;

  lines: CostingLine[];

  totals: {
    subtotal: string;
    totalCost: string;
    marginAmount: string;
    marginPct: string | null;
    grandTotal: string;
  };
  marginFloorPct: number | null;
}

const COLS = {
  no: 20,
  desc: 150,
  qty: 38,
  cost: 68,
  price: 68,
  lineCost: 68,
  amount: 68,
  margin: 68,
};

export function CostingSheetDocument(props: CostingSheetPdfProps) {
  return (
    <Document
      title={`INTERNAL — costing for ${props.documentNumber}`}
      author={props.company.name}
      subject="Internal costing sheet — not for distribution"
    >
      <Page size="A4" orientation="landscape" style={s.page}>
        <Text style={s.watermark} fixed>
          INTERNAL
        </Text>

        <View style={s.internalBanner} fixed>
          <Text>
            INTERNAL — COSTING AND MARGIN. NOT FOR THE CUSTOMER. DO NOT ATTACH TO CORRESPONDENCE.
          </Text>
        </View>

        <View style={s.headerRow}>
          <View style={{ maxWidth: 480 }}>
            <Text style={s.docTitle}>Costing sheet</Text>
            {/* The quotation title sits directly under the heading and was crowding it — the same
                fix as the customer document's. The width cap lets a long title wrap instead of
                running into the document number on the right. */}
            <Text style={[s.value, s.muted, { marginTop: 6, lineHeight: 1.35 }]}>
              {props.title}
            </Text>
          </View>
          <View style={{ textAlign: "right" }}>
            <Text style={s.docNumber}>{props.documentNumber}</Text>
            <Text style={s.small}>
              {props.customer.name} · {props.customer.code}
            </Text>
            <Text style={s.small}>
              Generated {props.generatedOn} for {props.generatedFor}
            </Text>
          </View>
        </View>
        <View style={s.headerRule} />

        {props.fxNote && (
          <Text style={[s.small, s.muted, { marginBottom: 6 }]}>{props.fxNote}</Text>
        )}

        <View style={s.tableHeader}>
          <Text style={[s.th, { width: COLS.no }]}>#</Text>
          <Text style={[s.th, { width: COLS.desc }]}>Description</Text>
          <Text style={[s.th, s.right, { width: COLS.qty }]}>Qty</Text>
          <Text style={[s.th, s.right, { width: COLS.cost }]}>Unit cost</Text>
          <Text style={[s.th, s.right, { width: COLS.price }]}>Unit price</Text>
          <Text style={[s.th, s.right, { width: COLS.lineCost }]}>Line cost</Text>
          <Text style={[s.th, s.right, { width: COLS.amount }]}>Amount</Text>
          <Text style={[s.th, s.right, { width: COLS.margin }]}>Margin</Text>
        </View>

        {props.lines.map((line) => (
          <View key={line.lineNo} style={s.tr} wrap={false}>
            <Text style={{ width: COLS.no }}>{line.lineNo}</Text>
            <View style={{ width: COLS.desc }}>
              <Text>{line.description}</Text>
              {(line.groupLabel || line.isOptional) && (
                <Text style={[s.small, s.muted]}>
                  {[line.groupLabel, line.isOptional ? "optional — excluded from total" : null]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              )}
            </View>
            <Text style={[s.right, { width: COLS.qty }]}>
              {line.quantity} {line.unit}
            </Text>
            <Text style={[s.right, { width: COLS.cost }]}>{line.unitCost}</Text>
            <Text style={[s.right, { width: COLS.price }]}>{line.unitPrice}</Text>
            <Text style={[s.right, { width: COLS.lineCost }]}>{line.lineCost}</Text>
            <Text style={[s.right, { width: COLS.amount }]}>{line.lineTotal}</Text>
            <Text
              style={[
                s.right,
                { width: COLS.margin },
                // §4's per-line heat: the only colour on this document, so it is the only thing
                // that catches the eye.
                line.belowFloor ? { color: PDF_COLORS.danger, fontFamily: "Helvetica-Bold" } : {},
              ]}
            >
              {line.lineMargin}
              {line.marginPct ? ` (${line.marginPct})` : ""}
            </Text>
          </View>
        ))}

        <View style={[s.totalsBlock, { width: 260 }]}>
          <View style={s.totalsRow}>
            <Text style={s.muted}>Subtotal (excluding optional)</Text>
            <Text>{props.totals.subtotal}</Text>
          </View>
          <View style={s.totalsRow}>
            <Text style={s.muted}>Total cost</Text>
            <Text>{props.totals.totalCost}</Text>
          </View>
          <View style={s.totalsGrand}>
            <Text style={s.bold}>Gross margin</Text>
            <Text style={s.bold}>
              {props.totals.marginAmount}
              {props.totals.marginPct ? ` (${props.totals.marginPct})` : ""}
            </Text>
          </View>
          <View style={s.totalsRow}>
            <Text style={s.muted}>Quoted total</Text>
            <Text>{props.totals.grandTotal}</Text>
          </View>
        </View>

        {props.marginFloorPct !== null && props.lines.some((line) => line.belowFloor) && (
          <Text style={[s.small, { color: PDF_COLORS.danger, marginTop: 8 }]}>
            One or more lines fall below the {props.marginFloorPct}% margin floor. Issuing this
            quotation requires quotation.override_margin_floor, held by the president and
            vice-president only.
          </Text>
        )}

        <View style={s.footer} fixed>
          <Text>
            INTERNAL · Doc No. {props.documentNumber} · Rev. {props.revision}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
