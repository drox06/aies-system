import { Document, Page, Text, View, Image } from "@react-pdf/renderer";
import { PDF_COLORS, pdfStyles as s } from "@/server/core/quotation/pdf/theme";

/**
 * A filled-in checklist, as a document (specs/04-operations-projects.md §15).
 *
 * §15's whole point is replacing "the undocumented, verbal way work is currently confirmed" with a
 * record somebody can read back — and a record that only exists behind a login is still not
 * something a customer can be handed to sign, or a technician can carry on a clipboard where there
 * is no signal. The company's own request: "all the checklists filled in on site should have a PDF
 * output, so it can be printed and signed."
 *
 * One template covers all eleven checklist keys (site inspection, mobilisation readiness, QA
 * inspection, loop check, toolbox talk, and the rest) — they share one schema (sections of items,
 * one answer per item), so the document is generic rather than templated per key.
 *
 * Same rule `MethodStatementDocument` follows: a draft prints, but says so. A checklist that looks
 * signed off and is not is exactly the "verbal confirmation" §15 exists to stop.
 */

export interface ChecklistPhoto {
  src: string;
  caption: string;
}

export interface ChecklistAnswerRow {
  key: string;
  label: string;
  typeLabel: string;
  /** The answer, already formatted for the item's type — "Pass", "4.2 mA", "Not applicable", "—". */
  answerText: string;
  note: string | null;
  failed: boolean;
  cause: string | null;
  action: string | null;
  photos: ChecklistPhoto[];
}

export interface ChecklistSectionRow {
  key: string;
  title: string;
  items: ChecklistAnswerRow[];
}

export interface ChecklistResponsePdfProps {
  company: { name: string; addressLines: string[] };
  logoSrc: string | null;

  templateName: string;
  templateKey: string;
  templateVersion: number;
  statusLabel: string;
  /** Only `complete` is final — see the note above `MethodStatementDocument`'s `isFinal`. */
  isFinal: boolean;

  linkedToLabel: string | null;
  linkedToValue: string | null;
  customerName: string | null;
  siteName: string | null;

  startedAt: string;
  completedAt: string | null;

  sections: ChecklistSectionRow[];
  summaryLine: string;
  failuresCount: number;

  signedByName: string | null;
  signedByPosition: string | null;
  signatureSrc: string | null;

  generatedAt: string;
}

function Nothing({ what }: { what: string }) {
  return <Text style={{ ...s.small, color: PDF_COLORS.textMuted }}>None — {what}.</Text>;
}

function PhotoRow({ items }: { items: ChecklistPhoto[] }) {
  if (items.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 3 }}>
      {items.map((photo, index) => (
        <View key={index} style={{ width: 100 }} wrap={false}>
          {/* eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf's Image has no alt prop */}
          <Image
            src={photo.src}
            style={{
              width: 100,
              height: 75,
              objectFit: "cover",
              borderWidth: 0.5,
              borderColor: PDF_COLORS.border,
            }}
          />
          <Text style={{ fontSize: 6.5, color: PDF_COLORS.textMuted, marginTop: 1 }}>
            {photo.caption}
          </Text>
        </View>
      ))}
    </View>
  );
}

function AnswerItem({ row }: { row: ChecklistAnswerRow }) {
  return (
    <View style={{ marginTop: 6 }} wrap={false}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ fontSize: 9, flex: 1 }}>{row.label}</Text>
        <Text
          style={{
            fontSize: 9,
            fontFamily: "Helvetica-Bold",
            color: row.failed ? PDF_COLORS.danger : PDF_COLORS.text,
          }}
        >
          {row.answerText}
        </Text>
      </View>
      {row.note && (
        <Text style={{ ...s.small, color: PDF_COLORS.textMuted, marginTop: 1 }}>{row.note}</Text>
      )}
      <PhotoRow items={row.photos} />
      {/* §15's conditional logic: a failure's cause and action are mandatory, so they print here. */}
      {row.failed && (
        <View
          style={{
            marginTop: 3,
            padding: 4,
            borderWidth: 0.75,
            borderColor: PDF_COLORS.danger,
          }}
        >
          <Text style={{ fontSize: 8 }}>
            <Text style={{ fontFamily: "Helvetica-Bold" }}>Cause: </Text>
            {row.cause ?? "—"}
          </Text>
          <Text style={{ fontSize: 8, marginTop: 1 }}>
            <Text style={{ fontFamily: "Helvetica-Bold" }}>Action taken: </Text>
            {row.action ?? "—"}
          </Text>
        </View>
      )}
    </View>
  );
}

export function ChecklistResponseDocument(props: ChecklistResponsePdfProps) {
  return (
    <Document title={`${props.templateName} v${props.templateVersion}`} author={props.company.name}>
      <Page size="A4" style={s.page}>
        <View style={s.headerRow}>
          <View>
            {/* eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf's Image has no alt prop */}
            {props.logoSrc && <Image src={props.logoSrc} style={s.logo} />}
            <Text style={s.companyName}>{props.company.name}</Text>
            {props.company.addressLines.map((line, index) => (
              <Text key={index} style={s.small}>
                {line}
              </Text>
            ))}
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={s.docTitle}>CHECKLIST</Text>
            <Text style={s.docNumber}>
              {props.templateKey} · v{props.templateVersion}
            </Text>
            <Text style={s.small}>{props.statusLabel}</Text>
          </View>
        </View>

        {!props.isFinal && (
          <View
            style={{ marginTop: 10, padding: 6, borderWidth: 1, borderColor: PDF_COLORS.red500 }}
          >
            <Text style={{ ...s.small, fontFamily: "Helvetica-Bold" }}>
              DRAFT — not signed off. This does not certify the procedure was completed.
            </Text>
          </View>
        )}

        <View style={{ marginTop: 14 }}>
          <Text style={{ ...s.docTitle, fontSize: 13 }}>{props.templateName}</Text>
          <View style={{ marginTop: 6 }}>
            {props.linkedToLabel && (
              <Text style={s.small}>
                {props.linkedToLabel}: {props.linkedToValue}
              </Text>
            )}
            {props.customerName && <Text style={s.small}>Customer: {props.customerName}</Text>}
            {props.siteName && <Text style={s.small}>Site: {props.siteName}</Text>}
            <Text style={s.small}>Started: {props.startedAt}</Text>
            {props.completedAt && <Text style={s.small}>Signed off: {props.completedAt}</Text>}
          </View>
        </View>

        <View style={{ marginTop: 10 }}>
          <Text style={{ ...s.small, fontFamily: "Helvetica-Bold" }}>
            {props.summaryLine}
            {props.failuresCount > 0 && (
              <Text style={{ color: PDF_COLORS.danger }}>
                {" "}
                — {props.failuresCount} failure{props.failuresCount === 1 ? "" : "s"}
              </Text>
            )}
          </Text>
        </View>

        {props.sections.map((section) => (
          <View key={section.key} style={{ marginTop: 12 }} wrap={false}>
            <Text style={s.sectionHeading}>{section.title}</Text>
            {section.items.length === 0 ? (
              <Nothing what="nothing in this section" />
            ) : (
              section.items.map((row) => <AnswerItem key={row.key} row={row} />)
            )}
          </View>
        ))}

        <View style={{ marginTop: 26 }} wrap={false}>
          <Text style={s.sectionHeading}>Sign-off</Text>
          <View style={{ flexDirection: "row", marginTop: 12, gap: 24 }}>
            <View style={{ flex: 1 }}>
              {props.signatureSrc && (
                /* eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf's Image has no alt prop */
                <Image src={props.signatureSrc} style={{ width: 140, height: 50 }} />
              )}
              <View style={{ borderTopWidth: 1, borderTopColor: PDF_COLORS.textMuted }} />
              <Text style={s.small}>Signature</Text>
              <Text style={{ ...s.small, color: PDF_COLORS.textMuted }}>
                {props.signedByName ?? "Not yet signed"}
                {props.signedByPosition ? `, ${props.signedByPosition}` : ""}
              </Text>
            </View>
          </View>
        </View>

        <Text
          style={s.footer}
          fixed
          render={({ pageNumber, totalPages }) =>
            `${props.templateKey} v${props.templateVersion} · printed ${props.generatedAt} · page ${pageNumber} of ${totalPages}`
          }
        />
      </Page>
    </Document>
  );
}
