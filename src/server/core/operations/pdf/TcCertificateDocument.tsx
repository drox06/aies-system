import { Document, Page, Text, View, Image } from "@react-pdf/renderer";
import { PDF_COLORS, pdfStyles as s } from "@/server/core/quotation/pdf/theme";

/**
 * The testing and commissioning certificate (specs/04-operations-projects.md §10).
 *
 * §10: "Generates a Testing & Commissioning Certificate PDF for customer signature. **This is a
 * primary billing trigger document.**"
 *
 * Which decides what the page has to carry. A document somebody bills against has to survive being
 * read months later by a person who was not there, so every test prints with the criterion it was
 * judged against **and where that criterion came from** — the provenance docs/DECISIONS.md #69 exists
 * to protect. A certificate showing "12.0 — PASS" proves nothing; one showing "12.0 against 4–20,
 * from quotation line 3" is an argument.
 *
 * The two things this document deliberately does not do:
 *
 *  - **It does not hide the weak parts.** Criteria nobody could tie to a quoted line print as
 *    "stated on site", and unresolved tests print as unresolved rather than being dropped. A
 *    certificate that quietly omits its awkward rows is worth less than one that carries them,
 *    because the customer's engineer will find them anyway and then doubt the rest.
 *  - **It does not print a result the record does not have.** An incomplete commissioning renders
 *    as a draft with the result blank, not as an accepted one waiting for a signature.
 */

export interface TcCertificateTest {
  test: string;
  criterion: string;
  measured: string;
  unit: string | null;
  verdict: "pass" | "fail" | "indeterminate";
  /** "Quotation line" or "Stated on site" — §10's provenance, printed. */
  source: string;
  promiseText: string | null;
}

export interface TcCertificatePunchItem {
  description: string;
  severity: string;
  owner: string | null;
  dueAt: string | null;
  status: string;
}

export interface TcCertificatePdfProps {
  number: string;
  company: { name: string; addressLines: string[]; tin: string; contactNumber: string };
  customer: { name: string; site: string | null };
  ticketNumber: string;
  projectCode: string | null;
  startedAt: string;
  completedAt: string | null;
  result: string | null;
  resultLabel: string | null;
  witnessedByCustomer: boolean;
  customerWitnessName: string | null;
  customerWitnessPosition: string | null;
  signedBy: string | null;
  signedAt: string | null;
  hasCustomerSignature: boolean;
  signOffRemarks: string | null;
  instruments: string[];
  tests: TcCertificateTest[];
  punchItems: TcCertificatePunchItem[];
  statedCriteriaCount: number;
  logoSrc: string;
}

const COLS = { test: 150, criterion: 90, measured: 70, verdict: 55, source: 150 };

const VERDICT_LABEL: Record<string, string> = {
  pass: "In spec",
  fail: "OUT OF SPEC",
  indeterminate: "Unresolved",
};

export function TcCertificateDocument(props: TcCertificatePdfProps) {
  const draft = !props.completedAt || !props.result;

  return (
    <Document
      title={`${props.number} — testing and commissioning certificate`}
      author={props.company.name}
      subject={`Commissioning of ${props.ticketNumber} for ${props.customer.name}`}
    >
      <Page size="A4" style={s.page}>
        {draft && (
          <View style={s.internalBanner} fixed>
            <Text>
              DRAFT — commissioning is not complete. This is not a certificate and nothing should be
              billed against it.
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

        <Text style={s.docTitle}>Testing &amp; Commissioning Certificate</Text>
        <Text style={s.docNumber}>{props.number}</Text>

        <View style={s.twoCol}>
          <View style={s.col}>
            <Text style={s.label}>Customer</Text>
            <Text style={s.value}>{props.customer.name}</Text>
            {props.customer.site && <Text style={s.value}>{props.customer.site}</Text>}
          </View>
          <View style={s.col}>
            <Text style={s.label}>Reference</Text>
            <Text style={s.value}>Ticket {props.ticketNumber}</Text>
            {props.projectCode && <Text style={s.value}>Project {props.projectCode}</Text>}
          </View>
        </View>

        <View style={s.twoCol}>
          <View style={s.col}>
            <Text style={s.label}>Commissioned</Text>
            <Text style={s.value}>
              {props.startedAt}
              {props.completedAt ? ` to ${props.completedAt}` : " — not yet completed"}
            </Text>
          </View>
          <View style={s.col}>
            <Text style={s.label}>Result</Text>
            <Text style={s.value}>{props.resultLabel ?? "Not yet determined"}</Text>
          </View>
        </View>

        <Text style={s.sectionHeading}>Test results</Text>
        <View style={s.tableHeader}>
          <Text style={[s.th, { width: COLS.test }]}>Test</Text>
          <Text style={[s.th, { width: COLS.criterion }]}>Criterion</Text>
          <Text style={[s.th, { width: COLS.measured }]}>Measured</Text>
          <Text style={[s.th, { width: COLS.verdict }]}>Result</Text>
          <Text style={[s.th, { width: COLS.source }]}>Criterion from</Text>
        </View>

        {props.tests.map((test, index) => (
          <View key={index} style={s.tr} wrap={false}>
            <Text style={{ width: COLS.test, fontSize: 8 }}>{test.test}</Text>
            <Text style={{ width: COLS.criterion, fontSize: 8 }}>{test.criterion}</Text>
            <Text style={{ width: COLS.measured, fontSize: 8 }}>
              {test.measured}
              {test.unit ? ` ${test.unit}` : ""}
            </Text>
            <Text
              style={[
                { width: COLS.verdict, fontSize: 8 },
                test.verdict === "fail" ? { color: PDF_COLORS.danger } : {},
              ]}
            >
              {VERDICT_LABEL[test.verdict] ?? test.verdict}
            </Text>
            <Text style={{ width: COLS.source, fontSize: 7.5, color: "#666" }}>
              {test.promiseText ? `${test.source} — ${test.promiseText}` : test.source}
            </Text>
          </View>
        ))}

        {props.tests.length === 0 && (
          <Text style={s.muted}>No tests recorded on this commissioning.</Text>
        )}

        {/*
          §10's provenance, said plainly rather than left for the reader to infer from the last
          column. A certificate whose criteria were written on the day is still a certificate — it is
          just worth knowing which kind you are holding.
        */}
        {props.statedCriteriaCount > 0 && (
          <Text style={s.optionalNote}>
            {props.statedCriteriaCount} of {props.tests.length} criteria were stated on site rather
            than read from the accepted quotation.
          </Text>
        )}

        {props.instruments.length > 0 && (
          <>
            <Text style={s.sectionHeading}>Instruments used</Text>
            <Text style={s.small}>{props.instruments.join(", ")}</Text>
          </>
        )}

        {props.punchItems.length > 0 && (
          <>
            <Text style={s.sectionHeading}>Punch list</Text>
            {props.punchItems.map((item, index) => (
              <View key={index} style={s.tr} wrap={false}>
                <Text style={{ width: 300, fontSize: 8 }}>{item.description}</Text>
                <Text
                  style={[
                    { width: 90, fontSize: 8 },
                    item.severity === "critical" ? { color: PDF_COLORS.danger } : {},
                  ]}
                >
                  {item.severity}
                </Text>
                <Text style={{ width: 125, fontSize: 8 }}>
                  {item.owner ?? "unassigned"}
                  {item.dueAt ? ` · ${item.dueAt}` : ""}
                </Text>
              </View>
            ))}
            <Text style={s.optionalNote}>
              Acceptance with a punch list is acceptance of the work, not closure of these items.
            </Text>
          </>
        )}

        {!props.witnessedByCustomer && (
          <Text style={s.optionalNote}>
            The customer did not witness commissioning. Recorded deliberately.
            {props.signOffRemarks ? ` ${props.signOffRemarks}` : ""}
          </Text>
        )}

        <View style={s.signatureRow} wrap={false}>
          <View style={s.signatureBox}>
            <View style={s.signatureLine} />
            <Text style={s.small}>For {props.company.name}</Text>
            <Text style={s.small}>{props.signedBy ?? " "}</Text>
            <Text style={s.small}>{props.signedAt ?? " "}</Text>
          </View>
          <View style={s.signatureBox}>
            <View style={s.signatureLine} />
            <Text style={s.small}>For {props.customer.name}</Text>
            <Text style={s.small}>{props.customerWitnessName ?? " "}</Text>
            <Text style={s.small}>{props.customerWitnessPosition ?? " "}</Text>
          </View>
        </View>

        {!props.hasCustomerSignature && props.signOffRemarks && (
          <Text style={s.optionalNote}>
            Signed off without a customer signature on file: {props.signOffRemarks}
          </Text>
        )}

        <Text
          style={s.footer}
          fixed
          render={({ pageNumber, totalPages }) =>
            `${props.number} · page ${pageNumber} of ${totalPages}`
          }
        />
      </Page>
    </Document>
  );
}
