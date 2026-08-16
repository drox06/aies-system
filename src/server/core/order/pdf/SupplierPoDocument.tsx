import { Document, Page, Text, View, Image } from "@react-pdf/renderer";
import { pdfStyles as s } from "@/server/core/quotation/pdf/theme";

/**
 * The supplier purchase order (specs/03-order-procurement.md §5).
 *
 * §5: "**Issue manually.** As with supplier RFQs, the system generates the branded PO PDF and the
 * draft email text; a person sends it and marks it sent."
 *
 * Unlike the RFQ — which deliberately carries no prices, no customer and no margin, because a
 * supplier who learns those can go around AIES — this document *is* the commercial commitment. It
 * has to state exactly what is being bought, at what price, on what terms, and be signed. What it
 * still does not carry is the customer's name or AIES's selling price: the supplier needs neither,
 * and the same reasoning that keeps them off the RFQ keeps them off this.
 *
 * The landed-cost charges are **not** printed either, and that is deliberate rather than an
 * oversight. Freight, duties and brokerage are AIES's own costs of getting the goods here; they are
 * not part of what this supplier is owed, and printing them on their order would invite them to
 * quote against a number that is not theirs. They live on the record for module 09's margin.
 */

export interface SupplierPoLine {
  lineNo: number;
  description: string;
  manufacturer: string | null;
  modelNumber: string | null;
  quantity: string;
  unit: string;
  unitCost: string;
  lineTotal: string;
  leadTimeDays: number | null;
}

export interface SupplierPoPdfProps {
  number: string;
  poDate: string;
  company: { name: string; addressLines: string[]; tin: string; contactNumber: string };
  supplier: {
    name: string;
    contactName: string | null;
    addressLines: string[];
    paymentTerms: string | null;
  };
  currency: string;
  incoterm: string | null;
  shipmentMode: string | null;
  expectedShipDate: string | null;
  expectedArrivalDate: string | null;
  deliverTo: { addressLines: string[] };
  lines: SupplierPoLine[];
  subtotal: string;
  notes: string | null;
  approvedBy: string | null;
  logoSrc: string;
}

/** Widths summing to the 515pt of usable page between the A4 margins. */
const COLS = { no: 20, desc: 200, qty: 60, unit: 80, lead: 70, total: 85 };

export function SupplierPoDocument(props: SupplierPoPdfProps) {
  return (
    <Document
      title={`${props.number} — purchase order`}
      author={props.company.name}
      subject={`Purchase order to ${props.supplier.name}`}
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
            <Text style={s.docTitle}>PURCHASE ORDER</Text>
            <Text style={[s.value, { marginTop: 6, lineHeight: 1.35 }]}>
              {props.supplier.contactName
                ? `For the attention of ${props.supplier.contactName}`
                : "To"}
            </Text>
            <Text style={s.value}>{props.supplier.name}</Text>
            {props.supplier.addressLines.map((line) => (
              <Text key={line} style={[s.small, s.muted]}>
                {line}
              </Text>
            ))}
          </View>
          <View style={{ textAlign: "right" }}>
            <Text style={s.docNumber}>{props.number}</Text>
            <Text style={s.small}>Dated {props.poDate}</Text>
            <Text style={s.small}>All amounts in {props.currency}</Text>
          </View>
        </View>

        <Text style={[s.value, { marginTop: 14 }]}>
          Please supply the items below in accordance with this order. Quote {props.number} on your
          acknowledgement, packing list and invoice.
        </Text>

        <View style={[s.tableHeader, { marginTop: 12 }]}>
          <Text style={[s.th, { width: COLS.no }]}>#</Text>
          <Text style={[s.th, { width: COLS.desc }]}>Item</Text>
          <Text style={[s.th, s.right, { width: COLS.qty }]}>Qty</Text>
          <Text style={[s.th, s.right, { width: COLS.unit }]}>Unit price</Text>
          <Text style={[s.th, s.right, { width: COLS.lead }]}>Lead time</Text>
          <Text style={[s.th, s.right, { width: COLS.total }]}>Amount</Text>
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
            <Text style={[s.right, { width: COLS.unit }]}>{line.unitCost}</Text>
            <Text style={[s.right, { width: COLS.lead }]}>
              {line.leadTimeDays ? `${line.leadTimeDays} d` : "—"}
            </Text>
            <Text style={[s.right, { width: COLS.total }]}>{line.lineTotal}</Text>
          </View>
        ))}

        <View style={[s.tr, { marginTop: 4 }]}>
          <Text style={{ width: COLS.no + COLS.desc + COLS.qty + COLS.unit + COLS.lead }} />
          <Text style={[s.right, s.label, { width: COLS.total }]}>Order total</Text>
        </View>
        <View style={s.tr}>
          <Text style={{ width: COLS.no + COLS.desc + COLS.qty + COLS.unit + COLS.lead }} />
          <Text style={[s.right, s.docNumber, { width: COLS.total }]}>
            {props.currency} {props.subtotal}
          </Text>
        </View>

        <View style={{ marginTop: 18 }}>
          <Text style={s.label}>Terms</Text>
          <Text style={s.value}>
            {[
              props.supplier.paymentTerms,
              props.incoterm,
              props.shipmentMode ? `by ${props.shipmentMode}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "As previously agreed."}
          </Text>
          {(props.expectedShipDate ?? props.expectedArrivalDate) && (
            <Text style={[s.small, s.muted, { marginTop: 2 }]}>
              {props.expectedShipDate ? `Ship by ${props.expectedShipDate}. ` : ""}
              {props.expectedArrivalDate ? `Required here by ${props.expectedArrivalDate}.` : ""}
            </Text>
          )}
        </View>

        <View style={{ marginTop: 12 }}>
          <Text style={s.label}>Deliver to</Text>
          {props.deliverTo.addressLines.map((line) => (
            <Text key={line} style={s.value}>
              {line}
            </Text>
          ))}
        </View>

        {props.notes && (
          <View style={{ marginTop: 12 }}>
            <Text style={s.label}>Notes</Text>
            <Text style={s.value}>{props.notes}</Text>
          </View>
        )}

        <View style={{ marginTop: 24 }}>
          <Text style={s.label}>Authorised by</Text>
          {/* The approver's name, because §5 routes every PO through the VP and a purchase order
              nobody signed is not a commitment the supplier can rely on. */}
          <Text style={s.value}>{props.approvedBy ?? "—"}</Text>
          <Text style={[s.small, s.muted, { marginTop: 2 }]}>{props.company.name}</Text>
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
