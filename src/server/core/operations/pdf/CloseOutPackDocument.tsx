import { Document, Page, Text, View, Image } from "@react-pdf/renderer";
import { PDF_COLORS, pdfStyles as s } from "@/server/core/quotation/pdf/theme";

/**
 * The project close-out pack (specs/04-operations-projects.md §12).
 *
 * §12: "**Close-out pack**, generated as one indexed PDF and filed as a controlled document: cover
 * sheet, scope summary, approved methodology, site inspection report, delivery receipts, material
 * list, QA records, T&C certificate and test results, service reports, calibration and test
 * certificates, as-built documentation, spare parts list, warranty statement, training record, punch
 * list closure, and customer acceptance certificate."
 *
 * ## What this generates, and what it does not
 *
 * This is the **cover sheet, the index and the summary sections** — the parts AIES writes. It states,
 * for each of §12's sixteen items, whether the document exists and where it is filed.
 *
 * It does **not** append the attached files themselves. Doing that means merging arbitrary uploaded
 * bytes — PDFs, photographs, and whatever a customer emailed — into one stream, which needs a PDF
 * manipulation library this project does not carry and cannot do at all for non-PDF attachments.
 * See docs/DECISIONS.md #73.
 *
 * The index is the point either way. A pack whose index says "as-built documentation: not on file"
 * is more use than one that silently omits the section, because the first tells a project manager
 * what to go and get.
 */

export interface PackIndexEntry {
  item: string;
  present: boolean;
  /** Where it is: a document number, a count, or why there is none. */
  reference: string;
}

export interface PackBlocker {
  label: string;
  blocking: boolean;
  detail: string;
  owner: string;
}

export interface PackTicket {
  number: string;
  title: string;
  type: string;
  status: string;
}

export interface CloseOutPackPdfProps {
  company: { name: string; addressLines: string[]; tin: string; contactNumber: string };
  customer: { name: string };
  projectCode: string;
  projectName: string;
  scopeOfWork: string;
  status: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualEnd: string | null;
  closedAt: string | null;
  approvedBy: string | null;
  generatedAt: string;
  canClose: boolean;
  blockers: PackBlocker[];
  checklist: PackBlocker[];
  index: PackIndexEntry[];
  tickets: PackTicket[];
  lessonsLearned: string | null;
  logoSrc: string;
}

export function CloseOutPackDocument(props: CloseOutPackPdfProps) {
  const open = !props.closedAt;

  return (
    <Document
      title={`${props.projectCode} — close-out pack`}
      author={props.company.name}
      subject={`Close-out pack for ${props.customer.name}`}
    >
      {/* Cover sheet */}
      <Page size="A4" style={s.page}>
        {open && (
          <View style={s.internalBanner} fixed>
            <Text>
              PROVISIONAL — this project is not closed. Issued for review, not as the controlled
              close-out record.
            </Text>
          </View>
        )}

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

        <Text style={s.docTitle}>Project Close-Out Pack</Text>
        <Text style={s.docNumber}>
          {props.projectCode} — {props.projectName}
        </Text>

        <View style={s.twoCol}>
          <View style={s.col}>
            <Text style={s.label}>Customer</Text>
            <Text style={s.value}>{props.customer.name}</Text>
          </View>
          <View style={s.col}>
            <Text style={s.label}>Status</Text>
            <Text style={s.value}>
              {props.closedAt ? `Closed ${props.closedAt}` : `Open — ${props.status}`}
            </Text>
          </View>
        </View>

        <View style={s.twoCol}>
          <View style={s.col}>
            <Text style={s.label}>Programme</Text>
            <Text style={s.value}>
              {props.plannedStart ?? "—"} to {props.plannedEnd ?? "—"}
              {props.actualEnd ? ` · finished ${props.actualEnd}` : ""}
            </Text>
          </View>
          <View style={s.col}>
            <Text style={s.label}>Issued</Text>
            <Text style={s.value}>{props.generatedAt}</Text>
            {props.approvedBy && <Text style={s.value}>Approved by {props.approvedBy}</Text>}
          </View>
        </View>

        <Text style={s.sectionHeading}>Scope of work</Text>
        <Text style={s.small}>{props.scopeOfWork}</Text>

        <Text style={s.sectionHeading}>Tickets on this project</Text>
        <View style={s.tableHeader}>
          <Text style={[s.th, { width: 90 }]}>Number</Text>
          <Text style={[s.th, { width: 260 }]}>Title</Text>
          <Text style={[s.th, { width: 80 }]}>Type</Text>
          <Text style={[s.th, { width: 85 }]}>Status</Text>
        </View>
        {props.tickets.map((ticket) => (
          <View key={ticket.number} style={s.tr} wrap={false}>
            <Text style={{ width: 90, fontSize: 8 }}>{ticket.number}</Text>
            <Text style={{ width: 260, fontSize: 8 }}>{ticket.title}</Text>
            <Text style={{ width: 80, fontSize: 8 }}>{ticket.type.replace(/_/g, " ")}</Text>
            <Text style={{ width: 85, fontSize: 8 }}>{ticket.status.replace(/_/g, " ")}</Text>
          </View>
        ))}
        {props.tickets.length === 0 && <Text style={s.muted}>No tickets on this project.</Text>}

        <Text
          style={s.footer}
          fixed
          render={({ pageNumber, totalPages }) =>
            `${props.projectCode} · close-out pack · page ${pageNumber} of ${totalPages}`
          }
        />
      </Page>

      {/* The index §12 asks for */}
      <Page size="A4" style={s.page}>
        <View style={s.headerRow} fixed>
          {/* eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf's Image has no alt prop */}
          <Image src={props.logoSrc} style={s.logo} />
          <View style={s.companyBlock}>
            <Text style={s.companyName}>{props.company.name}</Text>
            <Text>{props.projectCode} — close-out pack index</Text>
          </View>
        </View>
        <View style={s.headerRule} fixed />

        <Text style={s.docTitle}>Pack index</Text>
        <Text style={s.small}>
          §12&rsquo;s sixteen items. &ldquo;Not on file&rdquo; is stated rather than omitted — an
          index that hides its gaps tells a project manager nothing to go and get.
        </Text>

        <View style={s.tableHeader}>
          <Text style={[s.th, { width: 30 }]}>#</Text>
          <Text style={[s.th, { width: 220 }]}>Document</Text>
          <Text style={[s.th, { width: 70 }]}>On file</Text>
          <Text style={[s.th, { width: 195 }]}>Reference</Text>
        </View>

        {props.index.map((entry, i) => (
          <View key={entry.item} style={s.tr} wrap={false}>
            <Text style={{ width: 30, fontSize: 8 }}>{i + 1}</Text>
            <Text style={{ width: 220, fontSize: 8 }}>{entry.item}</Text>
            <Text
              style={[
                { width: 70, fontSize: 8 },
                entry.present ? {} : { color: PDF_COLORS.danger },
              ]}
            >
              {entry.present ? "Yes" : "No"}
            </Text>
            <Text style={{ width: 195, fontSize: 7.5, color: "#666" }}>{entry.reference}</Text>
          </View>
        ))}

        <Text style={s.sectionHeading}>Close-out blockers</Text>
        <Text style={s.small}>
          §12&rsquo;s six, computed from the project&rsquo;s own records rather than ticked by hand.
        </Text>
        {props.checklist.map((entry) => (
          <View key={entry.label} style={s.tr} wrap={false}>
            <Text
              style={[
                { width: 200, fontSize: 8 },
                entry.blocking ? { color: PDF_COLORS.danger } : {},
              ]}
            >
              {entry.label}
            </Text>
            <Text style={{ width: 190, fontSize: 8 }}>{entry.detail}</Text>
            <Text style={{ width: 125, fontSize: 7.5, color: "#666" }}>{entry.owner}</Text>
          </View>
        ))}

        {!props.canClose && (
          <Text style={s.optionalNote}>
            {props.blockers.length} blocker(s) outstanding. This pack is not the controlled
            close-out record until they are clear.
          </Text>
        )}

        {props.lessonsLearned && (
          <>
            <Text style={s.sectionHeading}>Lessons learned</Text>
            <Text style={s.small}>{props.lessonsLearned}</Text>
          </>
        )}

        <Text style={s.optionalNote}>
          The documents indexed above are filed against this project in the platform. This pack
          carries the index and AIES&rsquo;s own summary sections; the attachments themselves are
          retrieved from their records.
        </Text>

        <View style={s.signatureRow} wrap={false}>
          <View style={s.signatureBox}>
            <View style={s.signatureLine} />
            <Text style={s.small}>Prepared for {props.company.name}</Text>
            <Text style={s.small}>{props.approvedBy ?? " "}</Text>
          </View>
          <View style={s.signatureBox}>
            <View style={s.signatureLine} />
            <Text style={s.small}>Accepted for {props.customer.name}</Text>
          </View>
        </View>

        <Text
          style={s.footer}
          fixed
          render={({ pageNumber, totalPages }) =>
            `${props.projectCode} · close-out pack · page ${pageNumber} of ${totalPages}`
          }
        />
      </Page>
    </Document>
  );
}
