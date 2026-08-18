import { Document, Page, Text, View, Image } from "@react-pdf/renderer";
import { PDF_COLORS, pdfStyles as s } from "@/server/core/quotation/pdf/theme";

/**
 * The method statement, as a document (specs/04-operations-projects.md §6.2).
 *
 * §6.2 requires the client to approve the methodology before work starts, always. Until now the only
 * way to put one in front of a client was to describe it — the record lived on a screen behind a
 * login nobody outside AIES has. The company asked for it directly: "make the completed method
 * downloadable so that there is an option for review and sending the pdf to the client."
 *
 * ## What it prints, and why in this order
 *
 * A method statement is read by two different people and it has to serve both. The client's engineer
 * reads the top half — scope, sequence, duration — to decide whether to let AIES on site. The crew
 * reads the bottom half — tools, permits, safety, contingency — on the morning of the job. So the
 * commercial argument comes first and the operational detail second, and neither is summarised away.
 *
 * ## What it deliberately does not do
 *
 *  - **It does not print as approved unless it is.** A draft carries a plain DRAFT mark. A document
 *    that looks final and is not is how somebody works to a method nobody agreed to.
 *  - **It does not hide an empty section.** A method statement with no permits listed and no safety
 *    plan is a fact the reader should see, not a gap the layout closes over — the missing sections
 *    are exactly what a client's engineer will ask about.
 */

export interface MethodStep {
  step: number | string;
  description: string;
  durationHours: string | null;
  crew: string | null;
}

export interface MethodManpower {
  role: string;
  count: string;
  notes: string | null;
}

export interface MethodMaterial {
  description: string;
  quantity: string;
  unit: string | null;
}

export interface MethodStatementPdfProps {
  company: { name: string; addressLines: string[] };
  logoSrc: string | null;

  number: string;
  revision: number;
  title: string;
  status: string;
  statusLabel: string;
  isFinal: boolean;

  customerName: string | null;
  siteName: string | null;
  ticketNumber: string | null;
  projectCode: string | null;

  scopeSummary: string;
  durationDays: number | null;
  steps: MethodStep[];
  manpower: MethodManpower[];
  tools: string[];
  materials: MethodMaterial[];
  permits: string[];
  safetyPlan: string | null;
  hasJsa: boolean;
  environmental: string | null;
  mobilizationPlan: string | null;
  demobilizationPlan: string | null;
  contingencyPlan: string | null;

  preparedBy: string | null;
  approvedBy: string | null;
  clientDecisionAt: string | null;
  printedAt: string;
}

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 14 }} wrap={false}>
      <Text style={s.sectionHeading}>{heading}</Text>
      {children}
    </View>
  );
}

/** An empty section says so rather than vanishing — see the note at the top of this file. */
function Nothing({ what }: { what: string }) {
  return <Text style={{ ...s.small, color: PDF_COLORS.textMuted }}>None recorded — {what}</Text>;
}

export function MethodStatementDocument(props: MethodStatementPdfProps) {
  return (
    <Document
      title={`${props.number} R${props.revision} — ${props.title}`}
      author={props.company.name}
    >
      <Page size="A4" style={s.page}>
        <View style={s.headerRow}>
          <View>
            {props.logoSrc && <Image src={props.logoSrc} style={s.logo} />}
            <Text style={s.companyName}>{props.company.name}</Text>
            {props.company.addressLines.map((line, index) => (
              <Text key={index} style={s.small}>
                {line}
              </Text>
            ))}
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={s.docTitle}>METHOD STATEMENT</Text>
            <Text style={s.docNumber}>
              {props.number} · R{props.revision}
            </Text>
            <Text style={s.small}>{props.statusLabel}</Text>
          </View>
        </View>

        {/* The one thing that must never be ambiguous on a printed copy. */}
        {!props.isFinal && (
          <View
            style={{
              marginTop: 10,
              padding: 6,
              borderWidth: 1,
              borderColor: PDF_COLORS.red500,
            }}
          >
            <Text style={{ ...s.small, fontFamily: "Helvetica-Bold" }}>
              DRAFT — not approved. This is not a document to work to.
            </Text>
          </View>
        )}

        <View style={{ marginTop: 14 }}>
          <Text style={{ ...s.docTitle, fontSize: 13 }}>{props.title}</Text>
          <View style={{ marginTop: 6 }}>
            {props.customerName && <Text style={s.small}>Customer: {props.customerName}</Text>}
            {props.siteName && <Text style={s.small}>Site: {props.siteName}</Text>}
            {props.ticketNumber && <Text style={s.small}>Ticket: {props.ticketNumber}</Text>}
            {props.projectCode && <Text style={s.small}>Project: {props.projectCode}</Text>}
            {props.durationDays !== null && (
              <Text style={s.small}>
                Planned duration: {props.durationDays} day{props.durationDays === 1 ? "" : "s"}
              </Text>
            )}
          </View>
        </View>

        <Section heading="Scope">
          <Text style={{ fontSize: 9 }}>{props.scopeSummary}</Text>
        </Section>

        <Section heading="Sequence of work">
          {props.steps.length === 0 ? (
            <Nothing what="the sequence has not been written yet" />
          ) : (
            props.steps.map((step, index) => (
              <View key={index} style={{ flexDirection: "row", marginTop: 4 }}>
                <Text style={{ fontSize: 9, width: 26 }}>{step.step}.</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 9 }}>{step.description}</Text>
                  {(step.durationHours || step.crew) && (
                    <Text style={{ ...s.small, color: PDF_COLORS.textMuted }}>
                      {[
                        step.durationHours ? `${step.durationHours} h` : null,
                        step.crew ? `crew: ${step.crew}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  )}
                </View>
              </View>
            ))
          )}
        </Section>

        <Section heading="Manpower">
          {props.manpower.length === 0 ? (
            <Nothing what="no roles have been planned" />
          ) : (
            props.manpower.map((row, index) => (
              <Text key={index} style={{ fontSize: 9 }}>
                {row.count} × {row.role}
                {row.notes ? ` — ${row.notes}` : ""}
              </Text>
            ))
          )}
        </Section>

        <Section heading="Tools and instruments">
          {props.tools.length === 0 ? (
            <Nothing what="nothing has been listed" />
          ) : (
            <Text style={{ fontSize: 9 }}>{props.tools.join(", ")}</Text>
          )}
        </Section>

        <Section heading="Materials">
          {props.materials.length === 0 ? (
            <Nothing what="nothing has been listed" />
          ) : (
            props.materials.map((row, index) => (
              <Text key={index} style={{ fontSize: 9 }}>
                {row.quantity} {row.unit ?? ""} — {row.description}
              </Text>
            ))
          )}
        </Section>

        <Section heading="Permits required">
          {props.permits.length === 0 ? (
            <Nothing what="none identified" />
          ) : (
            <Text style={{ fontSize: 9 }}>{props.permits.join(", ")}</Text>
          )}
        </Section>

        <Section heading="Safety">
          {props.safetyPlan ? (
            <Text style={{ fontSize: 9 }}>{props.safetyPlan}</Text>
          ) : (
            <Nothing what="no safety plan has been written" />
          )}
          <Text style={{ ...s.small, marginTop: 4, color: PDF_COLORS.textMuted }}>
            {props.hasJsa
              ? "A job safety analysis is attached to this method statement."
              : "No job safety analysis attached."}
          </Text>
        </Section>

        {props.environmental && (
          <Section heading="Environmental considerations">
            <Text style={{ fontSize: 9 }}>{props.environmental}</Text>
          </Section>
        )}

        {props.mobilizationPlan && (
          <Section heading="Mobilisation">
            <Text style={{ fontSize: 9 }}>{props.mobilizationPlan}</Text>
          </Section>
        )}

        {props.demobilizationPlan && (
          <Section heading="Demobilisation">
            <Text style={{ fontSize: 9 }}>{props.demobilizationPlan}</Text>
          </Section>
        )}

        {props.contingencyPlan && (
          <Section heading="Contingency">
            <Text style={{ fontSize: 9 }}>{props.contingencyPlan}</Text>
          </Section>
        )}

        {/*
          Signature block. Printed on every copy including drafts, because a method statement's whole
          purpose under §6.2 is to be signed — and a client who receives one without anywhere to sign
          sends back an email instead, which is exactly the artefact the gate refuses to accept.
        */}
        <View style={{ marginTop: 26 }} wrap={false}>
          <Text style={s.sectionHeading}>Acceptance</Text>
          <View style={{ flexDirection: "row", marginTop: 18, gap: 24 }}>
            <View style={{ flex: 1 }}>
              <View style={{ borderTopWidth: 1, borderTopColor: PDF_COLORS.textMuted }} />
              <Text style={s.small}>For {props.company.name}</Text>
              <Text style={{ ...s.small, color: PDF_COLORS.textMuted }}>
                {props.approvedBy ?? props.preparedBy ?? ""}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <View style={{ borderTopWidth: 1, borderTopColor: PDF_COLORS.textMuted }} />
              <Text style={s.small}>For {props.customerName ?? "the client"}</Text>
              <Text style={{ ...s.small, color: PDF_COLORS.textMuted }}>
                Name, position, date
                {props.clientDecisionAt ? ` — recorded ${props.clientDecisionAt}` : ""}
              </Text>
            </View>
          </View>
        </View>

        <Text
          style={s.footer}
          fixed
          render={({ pageNumber, totalPages }) =>
            `${props.number} R${props.revision} · printed ${props.printedAt} · page ${pageNumber} of ${totalPages}`
          }
        />
      </Page>
    </Document>
  );
}
