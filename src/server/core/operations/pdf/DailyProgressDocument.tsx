import { Document, Page, Text, View, Image } from "@react-pdf/renderer";
import { pdfStyles as s } from "@/server/core/quotation/pdf/theme";

/**
 * The daily progress report (specs/04-operations-projects.md §8).
 *
 * §8 asks for one "where the customer requires them". Deferred through sessions 7 to 11 to be built
 * alongside §12's documents, which is where it now is.
 *
 * The section it has to get right is standby. §8 attributes every standby cause to whoever caused
 * it, and a variation claim rests on the customer's delays — so this document prints **both
 * columns**: their delays and ours, side by side, with weather attributed to neither. A report that
 * showed only the customer's delays would be the one that loses the argument about the rest, because
 * the first thing their engineer does is look for the days AIES lost and find them missing.
 */

export interface DailyProgressRow {
  logDate: string;
  percentComplete: number;
  manpowerOnSite: number;
  hoursWorked: string;
  standbyHours: string;
  standbyCauseLabel: string | null;
  /** "customer" | "aies" | "neither" — §8's attribution, printed. */
  standbyAttribution: string | null;
  weather: string | null;
  notes: string | null;
  issuesRaised: string | null;
}

export interface DailyProgressPdfProps {
  company: { name: string; addressLines: string[]; tin: string; contactNumber: string };
  customer: { name: string; site: string | null };
  ticketNumber: string;
  ticketTitle: string;
  projectCode: string | null;
  periodFrom: string;
  periodTo: string;
  rows: DailyProgressRow[];
  latestPercent: number;
  totals: {
    days: number;
    hoursWorked: string;
    standbyHours: string;
    customerStandbyHours: string;
    aiesStandbyHours: string;
    neitherStandbyHours: string;
  };
  logoSrc: string;
}

const COLS = { date: 60, pct: 38, men: 34, hrs: 42, standby: 46, cause: 130, notes: 165 };

export function DailyProgressDocument(props: DailyProgressPdfProps) {
  return (
    <Document
      title={`Daily progress — ${props.ticketNumber}`}
      author={props.company.name}
      subject={`Daily progress for ${props.customer.name}`}
    >
      <Page size="A4" orientation="landscape" style={s.page}>
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

        <Text style={s.docTitle}>Daily Progress Report</Text>
        <Text style={s.docNumber}>{props.ticketNumber}</Text>

        <View style={s.twoCol}>
          <View style={s.col}>
            <Text style={s.label}>Customer</Text>
            <Text style={s.value}>{props.customer.name}</Text>
            {props.customer.site && <Text style={s.value}>{props.customer.site}</Text>}
          </View>
          <View style={s.col}>
            <Text style={s.label}>Work</Text>
            <Text style={s.value}>{props.ticketTitle}</Text>
            {props.projectCode && <Text style={s.value}>Project {props.projectCode}</Text>}
          </View>
        </View>

        <View style={s.twoCol}>
          <View style={s.col}>
            <Text style={s.label}>Period</Text>
            <Text style={s.value}>
              {props.periodFrom} to {props.periodTo} · {props.totals.days} day(s) logged
            </Text>
          </View>
          <View style={s.col}>
            <Text style={s.label}>Progress</Text>
            <Text style={s.value}>{props.latestPercent}% complete</Text>
          </View>
        </View>

        <Text style={s.sectionHeading}>Daily record</Text>
        <View style={s.tableHeader} fixed>
          <Text style={[s.th, { width: COLS.date }]}>Date</Text>
          <Text style={[s.th, { width: COLS.pct }, s.right]}>%</Text>
          <Text style={[s.th, { width: COLS.men }, s.right]}>Men</Text>
          <Text style={[s.th, { width: COLS.hrs }, s.right]}>Hours</Text>
          <Text style={[s.th, { width: COLS.standby }, s.right]}>Standby</Text>
          <Text style={[s.th, { width: COLS.cause }]}>Standby cause</Text>
          <Text style={[s.th, { width: COLS.notes }]}>Notes</Text>
        </View>

        {props.rows.map((row) => (
          <View key={row.logDate} style={s.tr} wrap={false}>
            <Text style={{ width: COLS.date, fontSize: 8 }}>{row.logDate}</Text>
            <Text style={[{ width: COLS.pct, fontSize: 8 }, s.right]}>{row.percentComplete}</Text>
            <Text style={[{ width: COLS.men, fontSize: 8 }, s.right]}>{row.manpowerOnSite}</Text>
            <Text style={[{ width: COLS.hrs, fontSize: 8 }, s.right]}>{row.hoursWorked}</Text>
            <Text style={[{ width: COLS.standby, fontSize: 8 }, s.right]}>{row.standbyHours}</Text>
            <Text style={{ width: COLS.cause, fontSize: 8 }}>
              {row.standbyCauseLabel ?? ""}
              {row.standbyAttribution ? ` (${row.standbyAttribution})` : ""}
            </Text>
            <Text style={{ width: COLS.notes, fontSize: 7.5 }}>
              {[row.notes, row.issuesRaised].filter(Boolean).join(" · ")}
            </Text>
          </View>
        ))}

        {props.rows.length === 0 && <Text style={s.muted}>No days logged in this period.</Text>}

        <Text style={s.sectionHeading}>Standby summary</Text>
        {/*
          Both columns, deliberately. §8: a variation claim rests on the customer's delays, and one
          that quietly folds in AIES's own equipment failures is one the customer takes apart.
        */}
        <View style={s.totalsBlock}>
          <View style={s.totalsRow}>
            <Text>Hours worked</Text>
            <Text>{props.totals.hoursWorked}</Text>
          </View>
          <View style={s.totalsRow}>
            <Text>Standby — customer caused</Text>
            <Text>{props.totals.customerStandbyHours}</Text>
          </View>
          <View style={s.totalsRow}>
            <Text>Standby — AIES caused</Text>
            <Text>{props.totals.aiesStandbyHours}</Text>
          </View>
          <View style={s.totalsRow}>
            <Text>Standby — neither (weather)</Text>
            <Text>{props.totals.neitherStandbyHours}</Text>
          </View>
          <View style={s.totalsGrand}>
            <Text style={s.bold}>Total standby</Text>
            <Text style={s.bold}>{props.totals.standbyHours}</Text>
          </View>
        </View>

        <Text style={s.optionalNote}>
          Standby is attributed to whoever caused it. Weather is attributed to neither party. This
          report states AIES&rsquo;s own delays alongside the customer&rsquo;s.
        </Text>

        <View style={s.signatureRow} wrap={false}>
          <View style={s.signatureBox}>
            <View style={s.signatureLine} />
            <Text style={s.small}>For {props.company.name}</Text>
          </View>
          <View style={s.signatureBox}>
            <View style={s.signatureLine} />
            <Text style={s.small}>For {props.customer.name}</Text>
          </View>
        </View>

        <Text
          style={s.footer}
          fixed
          render={({ pageNumber, totalPages }) =>
            `${props.ticketNumber} · daily progress · page ${pageNumber} of ${totalPages}`
          }
        />
      </Page>
    </Document>
  );
}
