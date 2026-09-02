import { Document, Page, Text, View, Image } from "@react-pdf/renderer";
import { pdfStyles as s, PDF_COLORS } from "@/server/core/quotation/pdf/theme";

/**
 * The site inspection report (specs/04-operations-projects.md §6.1), as a download.
 *
 * Generated once the survey is genuinely finished — §6.1's own gate, `inspectionCompleteness`, is
 * what "completed" already means: when it happened, who went, and what they found. Asked for by the
 * company on 2026-09-03: *"once all details in the site inspection is accomplished, create a pdf
 * site inspection report. include the pictures in the report."* — the photographs and sketches are
 * why a surveyor climbs a ladder rather than phoning it in, and a report that summarised them as
 * "6 photos attached" would be handing the reader back to the app to see what the visit actually
 * found.
 */

export interface SiteInspectionPhoto {
  /** A data URI, already fetched and encoded — see `imageDataUri` in render.tsx for why. */
  src: string;
  caption: string;
}

export interface SiteInspectionReportPdfProps {
  company: { name: string; addressLines: string[]; tin: string; contactNumber: string };
  logoSrc: string;

  number: string;
  statusLabel: string;

  /** "Ticket" / "Project" / "Inquiry", whichever this inspection was raised from. */
  linkedToLabel: string | null;
  linkedToValue: string | null;

  customerName: string | null;
  siteName: string | null;
  siteAddress: string | null;

  scheduledFor: string | null;
  inspectedAt: string | null;
  attendees: string;

  findings: string | null;

  tagNumbers: string[];
  hazards: string[];
  permitsRequired: string[];
  accessConstraints: string | null;

  utilities: { key: string; label: string; available: boolean | null; note: string | null }[];
  measurements: { label: string; value: string; unit: string }[];

  scopeChangeIdentified: boolean;
  scopeChangeNotes: string | null;

  photos: SiteInspectionPhoto[];
  sketches: SiteInspectionPhoto[];
  /** True when one or more photos/sketches could not be embedded (an unreadable image format) —
   *  said on the page rather than silently producing a report with fewer pictures than were taken. */
  omittedImageCount: number;

  requestedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  generatedAt: string;
}

const photoStyles = {
  grid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 10, marginTop: 4 },
  item: { width: 160 },
  image: {
    width: 160,
    height: 120,
    objectFit: "cover" as const,
    borderWidth: 0.5,
    borderColor: PDF_COLORS.border,
  },
  caption: { fontSize: 7, color: PDF_COLORS.textMuted, marginTop: 2 },
};

function List({ items }: { items: string[] }) {
  if (items.length === 0) return <Text style={s.value}>—</Text>;
  return <Text style={s.value}>{items.join(", ")}</Text>;
}

function PhotoGrid({ items }: { items: SiteInspectionPhoto[] }) {
  return (
    <View style={photoStyles.grid}>
      {items.map((photo, index) => (
        <View key={index} style={photoStyles.item} wrap={false}>
          {/* eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf's Image has no alt prop */}
          <Image src={photo.src} style={photoStyles.image} />
          <Text style={photoStyles.caption}>{photo.caption}</Text>
        </View>
      ))}
    </View>
  );
}

export function SiteInspectionReportDocument(props: SiteInspectionReportPdfProps) {
  return (
    <Document
      title={`Site inspection report — ${props.number}`}
      author={props.company.name}
      subject={props.customerName ? `Site inspection for ${props.customerName}` : "Site inspection"}
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

        <Text style={s.docTitle}>Site Inspection Report</Text>
        <Text style={s.docNumber}>{props.number}</Text>
        <Text style={[s.value, s.muted]}>{props.statusLabel}</Text>

        <View style={s.twoCol}>
          <View style={s.col}>
            <Text style={s.label}>Customer</Text>
            <Text style={s.value}>{props.customerName ?? "—"}</Text>
            {props.siteName && <Text style={s.value}>{props.siteName}</Text>}
            {props.siteAddress && <Text style={[s.value, s.muted]}>{props.siteAddress}</Text>}
          </View>
          <View style={s.col}>
            {props.linkedToLabel && (
              <>
                <Text style={s.label}>{props.linkedToLabel}</Text>
                <Text style={s.value}>{props.linkedToValue}</Text>
              </>
            )}
            <Text style={[s.label, { marginTop: props.linkedToLabel ? 6 : 0 }]}>Visit</Text>
            <Text style={s.value}>
              {props.inspectedAt ? `Visited ${props.inspectedAt}` : "Not yet visited"}
              {props.scheduledFor ? ` · booked for ${props.scheduledFor}` : ""}
            </Text>
            <Text style={s.value}>Attended by: {props.attendees}</Text>
          </View>
        </View>

        {props.scopeChangeIdentified && (
          <View
            style={{
              marginTop: 12,
              padding: 8,
              borderWidth: 1,
              borderColor: "#B45309",
              backgroundColor: "#FEF3C7",
            }}
          >
            <Text style={[s.bold, { color: "#92400E" }]}>Scope change identified</Text>
            <Text style={{ marginTop: 2, color: "#92400E" }}>{props.scopeChangeNotes}</Text>
          </View>
        )}

        <Text style={s.sectionHeading}>Findings</Text>
        <Text style={s.value}>{props.findings ?? "—"}</Text>

        <Text style={s.sectionHeading}>Site detail</Text>
        <View style={s.twoCol}>
          <View style={s.col}>
            <Text style={s.label}>Tag numbers</Text>
            <List items={props.tagNumbers} />
            <Text style={[s.label, { marginTop: 6 }]}>Hazards</Text>
            <List items={props.hazards} />
          </View>
          <View style={s.col}>
            <Text style={s.label}>Permits required</Text>
            <List items={props.permitsRequired} />
            <Text style={[s.label, { marginTop: 6 }]}>Access constraints</Text>
            <Text style={s.value}>{props.accessConstraints || "—"}</Text>
          </View>
        </View>

        <Text style={s.sectionHeading}>Utilities on site</Text>
        {props.utilities.map((utility) => (
          <View key={utility.key} style={s.totalsRow}>
            <Text>{utility.label}</Text>
            <Text style={s.muted}>
              {utility.available === null
                ? "not checked"
                : utility.available
                  ? "available"
                  : "not available"}
              {utility.note ? ` — ${utility.note}` : ""}
            </Text>
          </View>
        ))}

        {props.measurements.length > 0 && (
          <>
            <Text style={s.sectionHeading}>Measurements</Text>
            <View style={s.tableHeader}>
              <Text style={[s.th, { width: 220 }]}>What was measured</Text>
              <Text style={[s.th, { width: 150 }]}>Value</Text>
              <Text style={[s.th, { width: 100 }]}>Unit</Text>
            </View>
            {props.measurements.map((row, index) => (
              <View key={index} style={s.tr}>
                <Text style={{ width: 220 }}>{row.label}</Text>
                <Text style={{ width: 150 }}>{row.value}</Text>
                <Text style={{ width: 100 }}>{row.unit}</Text>
              </View>
            ))}
          </>
        )}

        {props.photos.length > 0 && (
          <>
            <Text style={s.sectionHeading} break>
              Photographs
            </Text>
            <PhotoGrid items={props.photos} />
          </>
        )}

        {props.sketches.length > 0 && (
          <>
            <Text style={s.sectionHeading}>Sketches</Text>
            <PhotoGrid items={props.sketches} />
          </>
        )}

        {props.photos.length === 0 && props.sketches.length === 0 && (
          <>
            <Text style={s.sectionHeading}>Photographs</Text>
            <Text style={s.optionalNote}>None attached to this visit.</Text>
          </>
        )}

        {props.omittedImageCount > 0 && (
          <Text style={s.optionalNote}>
            {props.omittedImageCount} attached image{props.omittedImageCount === 1 ? "" : "s"} could
            not be embedded in this document and are available on the record itself.
          </Text>
        )}

        <View style={s.signatureRow} wrap={false}>
          <View style={s.signatureBox}>
            <View style={s.signatureLine} />
            <Text style={s.small}>Requested by: {props.requestedBy ?? "—"}</Text>
          </View>
          <View style={s.signatureBox}>
            <View style={s.signatureLine} />
            <Text style={s.small}>
              {props.approvedBy
                ? `Approved by: ${props.approvedBy}${props.approvedAt ? ` — ${props.approvedAt}` : ""}`
                : "Approval pending"}
            </Text>
          </View>
        </View>

        <Text
          style={s.footer}
          fixed
          render={({ pageNumber, totalPages }) =>
            `${props.number} · site inspection report · generated ${props.generatedAt} · page ${pageNumber} of ${totalPages}`
          }
        />
      </Page>
    </Document>
  );
}
