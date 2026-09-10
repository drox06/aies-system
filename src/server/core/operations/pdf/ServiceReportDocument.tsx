import { Document, Page, Text, View, Image } from "@react-pdf/renderer";
import { PDF_COLORS, pdfStyles as s } from "@/server/core/quotation/pdf/theme";

/**
 * The service report, as a document (specs/04-operations-projects.md §12).
 *
 * App-authored reports only — one written on the customer's own form and uploaded already signed
 * (`ServiceReport.externalDocument`) already exists as that signed document; AIES generating a second
 * PDF for it would be a copy of a copy, not the record. `renderServiceReportPdf` refuses those.
 *
 * Company's own request: printed and signed, same reasoning as `ChecklistResponseDocument` — a
 * report that only exists behind a login cannot be handed to a customer at all.
 */

export interface ServiceReportPart {
  description: string;
  partNumber: string | null;
  quantity: string;
  unit: string | null;
  fromStock: boolean;
}

export interface ServiceReportPhoto {
  src: string;
  caption: string;
}

export interface ServiceReportPdfProps {
  company: { name: string; addressLines: string[] };
  logoSrc: string | null;

  number: string;
  statusLabel: string;
  /** A draft has not been reviewed or signed by anyone yet — see the note above `isDraft`'s use. */
  isDraft: boolean;

  ticketNumber: string;
  projectCode: string | null;
  customerName: string | null;
  siteName: string | null;

  startedAt: string | null;
  finishedAt: string | null;
  travelTimeMin: number | null;
  standbyTimeMin: number | null;

  workPerformed: string;
  findings: string | null;
  recommendations: string | null;

  parts: ServiceReportPart[];
  equipment: { description: string; tagNumber: string | null }[];

  followUpRequired: boolean;
  followUpNotes: string | null;

  photos: ServiceReportPhoto[];
  omittedImageCount: number;

  customerSignatureSrc: string | null;
  /** Who actually signed — distinct from `customerName` above, which is the account's name. */
  signerName: string | null;
  signerPosition: string | null;
  signatureWaiverReason: string | null;
  technicianSignatureSrc: string | null;
  preparedByName: string | null;

  generatedAt: string;
}

function Nothing({ what }: { what: string }) {
  return <Text style={{ ...s.small, color: PDF_COLORS.textMuted }}>None recorded — {what}.</Text>;
}

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 12 }} wrap={false}>
      <Text style={s.sectionHeading}>{heading}</Text>
      {children}
    </View>
  );
}

function PhotoGrid({ items }: { items: ServiceReportPhoto[] }) {
  if (items.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 4 }}>
      {items.map((photo, index) => (
        <View key={index} style={{ width: 160 }} wrap={false}>
          {/* eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf's Image has no alt prop */}
          <Image
            src={photo.src}
            style={{
              width: 160,
              height: 120,
              objectFit: "cover",
              borderWidth: 0.5,
              borderColor: PDF_COLORS.border,
            }}
          />
          <Text style={{ fontSize: 7, color: PDF_COLORS.textMuted, marginTop: 2 }}>
            {photo.caption}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function ServiceReportDocument(props: ServiceReportPdfProps) {
  return (
    <Document title={`Service report — ${props.number}`} author={props.company.name}>
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
            <Text style={s.docTitle}>SERVICE REPORT</Text>
            <Text style={s.docNumber}>{props.number}</Text>
            <Text style={s.small}>{props.statusLabel}</Text>
          </View>
        </View>

        {props.isDraft && (
          <View
            style={{ marginTop: 10, padding: 6, borderWidth: 1, borderColor: PDF_COLORS.red500 }}
          >
            <Text style={{ ...s.small, fontFamily: "Helvetica-Bold" }}>
              DRAFT — not yet reviewed. This is not the customer&rsquo;s copy of record.
            </Text>
          </View>
        )}

        <View style={{ marginTop: 14 }}>
          <View style={s.twoCol}>
            <View style={s.col}>
              <Text style={s.label}>Customer</Text>
              <Text style={s.value}>{props.customerName ?? "—"}</Text>
              {props.siteName && <Text style={s.small}>{props.siteName}</Text>}
            </View>
            <View style={s.col}>
              <Text style={s.label}>Ticket</Text>
              <Text style={s.value}>{props.ticketNumber}</Text>
              {props.projectCode && <Text style={s.small}>Project {props.projectCode}</Text>}
            </View>
          </View>
          <View style={{ ...s.twoCol, marginTop: 8 }}>
            <View style={s.col}>
              <Text style={s.label}>Started</Text>
              <Text style={s.value}>{props.startedAt ?? "—"}</Text>
            </View>
            <View style={s.col}>
              <Text style={s.label}>Finished</Text>
              <Text style={s.value}>{props.finishedAt ?? "—"}</Text>
            </View>
          </View>
          {(props.travelTimeMin !== null || props.standbyTimeMin !== null) && (
            <Text style={{ ...s.small, marginTop: 4, color: PDF_COLORS.textMuted }}>
              {[
                props.travelTimeMin !== null ? `Travel: ${props.travelTimeMin} min` : null,
                props.standbyTimeMin !== null ? `Standby: ${props.standbyTimeMin} min` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          )}
        </View>

        <Section heading="Work performed">
          <Text style={{ fontSize: 9 }}>{props.workPerformed}</Text>
        </Section>

        {props.findings && (
          <Section heading="Findings">
            <Text style={{ fontSize: 9 }}>{props.findings}</Text>
          </Section>
        )}

        {props.recommendations && (
          <Section heading="Recommendations">
            <Text style={{ fontSize: 9 }}>{props.recommendations}</Text>
          </Section>
        )}

        <Section heading="Parts used">
          {props.parts.length === 0 ? (
            <Nothing what="no parts recorded" />
          ) : (
            props.parts.map((part, index) => (
              <Text key={index} style={{ fontSize: 9, marginTop: 2 }}>
                {part.quantity} {part.unit ?? ""} — {part.description}
                {part.partNumber ? ` (${part.partNumber})` : ""}
                {part.fromStock ? " · from stock" : ""}
              </Text>
            ))
          )}
        </Section>

        {props.equipment.length > 0 && (
          <Section heading="Equipment covered">
            {props.equipment.map((item, index) => (
              <Text key={index} style={{ fontSize: 9 }}>
                {item.description}
                {item.tagNumber ? ` — ${item.tagNumber}` : ""}
              </Text>
            ))}
          </Section>
        )}

        {props.followUpRequired && (
          <Section heading="Follow-up required">
            <Text style={{ fontSize: 9, color: PDF_COLORS.danger }}>
              {props.followUpNotes ?? "Follow-up flagged, no notes recorded."}
            </Text>
          </Section>
        )}

        {(props.photos.length > 0 || props.omittedImageCount > 0) && (
          <Section heading="Photographs">
            <PhotoGrid items={props.photos} />
            {props.omittedImageCount > 0 && (
              <Text style={{ ...s.small, marginTop: 4, color: PDF_COLORS.textMuted }}>
                {props.omittedImageCount} attached image{props.omittedImageCount === 1 ? "" : "s"}{" "}
                could not be embedded and are available in the app.
              </Text>
            )}
          </Section>
        )}

        <View style={{ marginTop: 26 }} wrap={false}>
          <Text style={s.sectionHeading}>Sign-off</Text>
          <View style={{ flexDirection: "row", marginTop: 12, gap: 24 }}>
            <View style={{ flex: 1 }}>
              {props.technicianSignatureSrc && (
                /* eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf's Image has no alt prop */
                <Image src={props.technicianSignatureSrc} style={{ width: 140, height: 50 }} />
              )}
              <View style={{ borderTopWidth: 1, borderTopColor: PDF_COLORS.textMuted }} />
              <Text style={s.small}>For {props.company.name}</Text>
              <Text style={{ ...s.small, color: PDF_COLORS.textMuted }}>
                {props.preparedByName ?? ""}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              {props.customerSignatureSrc && (
                /* eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf's Image has no alt prop */
                <Image src={props.customerSignatureSrc} style={{ width: 140, height: 50 }} />
              )}
              <View style={{ borderTopWidth: 1, borderTopColor: PDF_COLORS.textMuted }} />
              <Text style={s.small}>For {props.customerName ?? "the customer"}</Text>
              <Text style={{ ...s.small, color: PDF_COLORS.textMuted }}>
                {props.signerName ?? "Name, position, date"}
                {props.signerPosition ? `, ${props.signerPosition}` : ""}
              </Text>
              {!props.customerSignatureSrc && props.signatureWaiverReason && (
                <Text style={{ ...s.small, color: PDF_COLORS.textMuted, marginTop: 2 }}>
                  Signature waived — {props.signatureWaiverReason}
                </Text>
              )}
            </View>
          </View>
        </View>

        <Text
          style={s.footer}
          fixed
          render={({ pageNumber, totalPages }) =>
            `${props.number} · printed ${props.generatedAt} · page ${pageNumber} of ${totalPages}`
          }
        />
      </Page>
    </Document>
  );
}
