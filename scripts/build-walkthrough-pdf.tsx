/*
  React in scope explicitly — see src/server/core/finance/pdf/render.tsx for why. This file is run
  directly by tsx, outside Next's compiler, and would otherwise fail with "React is not defined" at
  render time rather than at compile time.
*/
import React from "react";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Document, Page, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { PDF_COLORS, pdfStyles } from "../src/server/core/quotation/pdf/theme";
import { getCompanyDetails } from "../src/server/core/company";

/**
 * The end-to-end walkthrough, as a printable document.
 *
 * ## Why this is generated rather than written by hand
 *
 * Every route and screen name in it comes from the same manifests the sidebar is built from, so a
 * screen that gets renamed or moved makes this document wrong in a way somebody will notice the next
 * time they run it — rather than a Word file that quietly rots in a shared folder.
 *
 * ## Who it is for
 *
 * Somebody sitting in front of the platform with a job to walk through, one screen at a time. Each
 * step says **who** does it, **where** to go, **what to do**, and **what should happen** — because a
 * step that says only "approve the quotation" is the kind of instruction that reads fine and cannot
 * be followed.
 */

interface Step {
  n: number;
  who: string;
  what: string;
  where: string;
  doThis: string[];
  expect: string[];
  note?: string;
}

interface Part {
  title: string;
  intro: string;
  steps: Step[];
}

const COMPANY = getCompanyDetails();

const PARTS: Part[] = [
  {
    title: "Part 1 — The enquiry arrives",
    intro:
      "Everything starts as an inquiry, whether it came by email, on the phone, or from somebody " +
      "walking in. Nothing further in the platform can happen until one exists.",
    steps: [
      {
        n: 1,
        who: "EM (Sales and Marketing) or DJ (Operations)",
        what: "Log the inquiry",
        where: "Sidebar → Sales → Inquiries → “Log inquiry”",
        doThis: [
          "Choose the customer account, or create one if this is a new customer.",
          "Give it a subject in the customer's own words — “two 75kW motors rewound”, not “motor job”.",
          "Add the items or scope as far as they are known. Unknowns are fine at this stage.",
          "Set the required-by date if the customer gave one.",
        ],
        expect: [
          "A number of the form AIESINQ-26xxxx.",
          "Status: new. A one-working-day clock starts on acknowledging it.",
        ],
      },
      {
        n: 2,
        who: "Whoever owns the inquiry",
        what: "Acknowledge it",
        where: "Sales → Inquiries → open the inquiry → “Acknowledge”",
        doThis: ["Press Acknowledge once you have replied to the customer."],
        expect: [
          "Status moves to acknowledged and the SLA clock stops.",
          "Left unacknowledged past one working day, it escalates — that is the platform chasing, not a fault.",
        ],
      },
      {
        n: 3,
        who: "EM or DJ",
        what: "Complete the requirements",
        where: "The inquiry → the requirements checklist on the record",
        doThis: [
          "Work down the checklist for this kind of job and tick what has been received.",
          "Where a document is needed, upload it.",
        ],
        expect: [
          "The checklist shows what is still missing.",
          "You cannot move the inquiry to quoting until the mandatory items are in — that is the gate, and it is deliberate.",
        ],
        note:
          "This is where most of the back-and-forth with a customer lives. The checklist is the " +
          "record that it happened.",
      },
      {
        n: 4,
        who: "DJ",
        what: "Request a site inspection, if the job needs one",
        where: "The inquiry → “Request inspection”",
        doThis: ["Name the technician and the date.", "Say what needs looking at."],
        expect: [
          "The technician is notified and it appears on the calendar.",
          "The SLA clock pauses while an inspection is outstanding.",
        ],
      },
      {
        n: 5,
        who: "EM",
        what: "Move it to quoting",
        where: "The inquiry → “Start quoting”",
        doThis: ["Press it once the requirements are complete."],
        expect: [
          "A draft quotation is raised automatically and linked to the inquiry.",
          "The inquiry is now quoting. Find the draft under Sales → Quotations.",
        ],
      },
    ],
  },
  {
    title: "Part 2 — The quotation",
    intro:
      "A quotation is the company's price and its terms. Two gates stand between a draft and a " +
      "customer: it must have a cost behind it, and the Vice President must approve it.",
    steps: [
      {
        n: 6,
        who: "EM",
        what: "Build the quotation",
        where: "Sales → Quotations → open the draft",
        doThis: [
          "Add a line per item or scope of work.",
          "Enter the supplier cost against each line, and the margin you intend.",
          "Choose the payment terms — this decides the billing schedule later, so it matters.",
          "Set the validity date.",
        ],
        expect: [
          "The total, the VAT and the margin update as you type.",
          "Local jobs are numbered AIESLQ26xxxx; indent jobs AIESIQ26xxxx.",
        ],
      },
      {
        n: 7,
        who: "EM",
        what: "Meet the cost gate",
        where: "The quotation",
        doThis: ["Make sure every line has a cost — not an estimate typed into the description."],
        expect: [
          "With a line costed at zero the quotation refuses to be submitted, and says which line.",
          "This is what stops a job being sold at a price nobody checked.",
        ],
      },
      {
        n: 8,
        who: "EM",
        what: "Send it for approval",
        where: "The quotation → “Submit for approval”",
        doThis: ["Press it."],
        expect: [
          "It appears in KJ's queue at Sales → Quotations for Approval.",
          "KJ is notified. After 24 hours with no decision it escalates to EA.",
        ],
      },
      {
        n: 9,
        who: "KJ (Vice President)",
        what: "Approve or reject",
        where: "Sales → Quotations for Approval",
        doThis: ["Open it, check the margin and the terms.", "Approve, or reject with a reason."],
        expect: [
          "Approved: the quotation can now be sent.",
          "Rejected: it goes back to EM with the reason attached, and the reason is kept.",
        ],
      },
      {
        n: 10,
        who: "EM",
        what: "Send it to the customer",
        where: "The quotation → “Send”",
        doThis: [
          "Download the PDF and send it to the customer from your own email.",
          "Then press Send so the platform knows it has gone.",
        ],
        expect: [
          "Status: sent, with the date.",
          "A follow-up reminder is scheduled seven days out.",
          "The validity date now counts down; it expires on its own if nothing comes back.",
        ],
      },
    ],
  },
  {
    title: "Part 3 — The customer's purchase order",
    intro:
      "The customer's PO is the moment the job becomes real. It is the single act that turns a " +
      "quotation into a sales order and starts everything downstream.",
    steps: [
      {
        n: 11,
        who: "EM",
        what: "Record the customer's PO",
        where: "Sales → Pipeline → the “Received PO” column, or the quotation → “Record PO”",
        doThis: [
          "Enter the customer's own PO number and its date.",
          "Upload the PO document itself — this is the paper the job is done against.",
          "Confirm the amount matches the quotation. Where it does not, say so; the difference is recorded rather than hidden.",
        ],
        expect: [
          "A sales order is raised: AIESSO-26xxxx.",
          "The quotation is marked won, and the inquiry closes with it.",
          "Tasks appear for sales, operations, procurement and finance — automatically.",
        ],
        note:
          "Check My Work straight after this step. Four tasks should be waiting, and that is the " +
          "platform replacing the meeting where those jobs used to be handed out.",
      },
      {
        n: 12,
        who: "DJ",
        what: "Look at the sales order",
        where: "Orders → Sales orders → the new order",
        doThis: [
          "Read the lines: which are supply-only, which need work on site.",
          "Check the billing schedule panel below the header.",
        ],
        expect: [
          "A billing schedule generated from the payment terms on the quotation.",
          "A downpayment milestone, if the terms have one, sitting at ready to bill.",
        ],
      },
    ],
  },
  {
    title: "Part 4 — Money before the work starts",
    intro:
      "Where the terms call for a downpayment, the platform will not let the job mobilise until it " +
      "is in. This is the first of the two places money is collected.",
    steps: [
      {
        n: 13,
        who: "Finance",
        what: "Raise the downpayment statement",
        where: "Finance → Ready to bill",
        doThis: [
          "Find the milestone for this order and press “Raise a statement”.",
          "Check the amount and the due date.",
        ],
        expect: [
          "A draft billing statement: AIESBS-26xxxx.",
          "Nothing has gone to the customer yet — a draft is not a demand.",
        ],
      },
      {
        n: 14,
        who: "Finance",
        what: "Issue it",
        where: "Finance → Statements → the draft → “Issue”",
        doThis: ["Issue it, then send the statement to the customer."],
        expect: ["Status: issued. It now appears in Receivables and starts ageing."],
      },
      {
        n: 15,
        who: "Finance",
        what: "Record the payment when it arrives",
        where: "Finance → Statements → the statement → “Record payment”",
        doThis: [
          "Choose the method. For a cheque, enter the cheque number and its date.",
          "Enter the amount received. If the customer withheld tax, enter what actually arrived.",
        ],
        expect: [
          "A payment: AIESPMT-26xxxx, and a service invoice: AIESSI-26xxxx.",
          "A cheque sits as pending until you clear it — the money is not counted before the bank has it.",
          "Where tax was withheld, the statement stays part-paid until the 2307 form arrives. That is intentional.",
        ],
      },
      {
        n: 16,
        who: "Finance",
        what: "Print the service invoice",
        where: "The statement → the service invoice → “PDF”",
        doThis: ["Open the PDF."],
        expect: [
          "A reference copy, marked as such. AIES issues the official invoice on its registered external form; this is what you copy from.",
        ],
      },
    ],
  },
  {
    title: "Part 5 — Buying what the job needs",
    intro: "Runs in parallel with the work. Procurement is PD's.",
    steps: [
      {
        n: 17,
        who: "PD (Admin Manager)",
        what: "Ask suppliers for prices",
        where: "Orders → Procurement → “New RFQ”",
        doThis: [
          "Pick the suppliers — several at once is normal.",
          "List what is needed.",
          "Send, then record each supplier's reply as it comes back.",
        ],
        expect: [
          "AIESRFQ-26xxxx, and a comparison across the replies.",
          "Applying an offer copies its prices onto the order rather than making you retype them.",
        ],
      },
      {
        n: 18,
        who: "PD",
        what: "Raise the supplier PO",
        where: "Orders → Procurement → “Raise supplier PO”",
        doThis: ["Choose the supplier and confirm the lines and prices."],
        expect: [
          "AIESPO-26xxxx, requiring approval before it is sent.",
          "Above the threshold it needs a second approval — the clause 8.4 control.",
        ],
      },
      {
        n: 19,
        who: "PD",
        what: "Receive the goods",
        where: "Orders → Procurement → the PO → “Record receipt”",
        doThis: [
          "Enter what actually arrived, line by line. Short deliveries are recorded as short.",
          "Note any damage.",
        ],
        expect: [
          "AIESGRN-26xxxx.",
          "A three-way check between the PO, the receipt and the supplier's invoice. Differences are shown with their numbers, not just flagged.",
        ],
      },
    ],
  },
  {
    title: "Part 6 — Doing the work",
    intro:
      "Every job runs through the same gates, and each one exists because skipping it has cost the " +
      "company money before. A gate refuses with a reason; read the reason.",
    steps: [
      {
        n: 20,
        who: "DJ",
        what: "Generate the tickets",
        where: "Orders → Sales orders → the order → “Generate tickets”",
        doThis: ["Press it."],
        expect: [
          "One ticket per piece of work: AIESTKT-26xxxx.",
          "A project record for the job as a whole, and a channel for it under Collaboration → Channels.",
        ],
      },
      {
        n: 21,
        who: "DJ",
        what: "Site inspection",
        where: "Operations → Site inspections",
        doThis: [
          "Record what was found, who attended, and photographs.",
          "If the scope has changed, say so here — it raises a revision task for sales.",
        ],
        expect: [
          "AIESSI-26xxxx, with the photographs attached to the record rather than in somebody's phone.",
        ],
      },
      {
        n: 22,
        who: "DJ",
        what: "Method statement, and the client's approval of it",
        where: "Operations → Method statements",
        doThis: [
          "Prepare the statement, or upload the client's own form where they insist on theirs.",
          "Submit it to the client, then record their approval when it comes.",
        ],
        expect: ["AIESMTH-26xxxx.", "Work cannot mobilise until the client has approved. Always."],
      },
      {
        n: 23,
        who: "DJ, then PD",
        what: "Materials",
        where: "Operations → the ticket → “Raise material request”, then Operations → Store",
        doThis: [
          "Raise the request against the ticket.",
          "PD approves it and issues from the store, recording who took what.",
        ],
        expect: [
          "AIESMR-26xxxx.",
          "What the store cannot supply becomes a purchase task for PD.",
          "Tools issued are on a custody list until they come back.",
        ],
      },
      {
        n: 24,
        who: "The crew lead, then Finance",
        what: "Cash advance",
        where: "Finance → Cash advances → “Request”, then Finance → Cash to release",
        doThis: [
          "Request the advance, saying what it is for and when it is needed.",
          "It is approved, then released. Record the release when the money actually goes.",
        ],
        expect: [
          "AIESCA-26xxxx.",
          "A liquidation deadline is set the moment it is released, and it appears on the calendar.",
          "Somebody with an overdue liquidation cannot request another advance.",
        ],
      },
      {
        n: 25,
        who: "DJ",
        what: "Mobilise",
        where: "Operations → the ticket → the mobilisation panel",
        doThis: ["Check the readiness list and mobilise."],
        expect: [
          "It refuses while anything is outstanding — downpayment, method statement, materials, crew — and names what.",
        ],
      },
      {
        n: 26,
        who: "The crew",
        what: "Record progress each day",
        where: "Operations → Delivery mode (on a phone), or the ticket",
        doThis: [
          "Record what was done, hours worked, and photographs.",
          "Record standby time and why, if the crew was held up.",
        ],
        expect: [
          "Hours reach the job's cost once approved at Operations → Hours and expenses.",
          "Standby with a reason is what makes a claim against the client possible later.",
        ],
      },
      {
        n: 27,
        who: "DJ",
        what: "The client's QA",
        where: "Operations → the ticket → the QA panel",
        doThis: [
          "Record the client's verdict and upload their evidence.",
          "Where it failed, record each defect.",
        ],
        expect: [
          "AIESQA-26xxxx.",
          "A failure raises rectification work and a re-inspection automatically.",
        ],
      },
      {
        n: 28,
        who: "DJ",
        what: "Testing and commissioning",
        where: "Operations → the ticket → the T&C panel",
        doThis: ["Record the results and any punch items."],
        expect: [
          "AIESTC-26xxxx and a certificate.",
          "Accepted commissioning is what opens final billing.",
        ],
      },
      {
        n: 29,
        who: "The crew lead",
        what: "Demobilise and liquidate",
        where: "Operations → the ticket → demobilisation, then Finance → Cash advances",
        doThis: [
          "Record the demobilisation and reconcile the tools.",
          "Liquidate the advance: receipts in, unspent cash returned.",
        ],
        expect: [
          "Anything not returned is listed by name.",
          "Only approved liquidation lines count as job cost.",
        ],
      },
      {
        n: 30,
        who: "DJ",
        what: "Service report and close-out",
        where: "Operations → the ticket → service report, then Operations → Projects",
        doThis: [
          "Write the service report and have the client sign it.",
          "Work down the close-out checklist on the project.",
        ],
        expect: [
          "AIESSR-26xxxx.",
          "The project closes only when the checklist is clear, and it says what is blocking it.",
          "Closing raises the final invoice task for finance.",
        ],
      },
    ],
  },
  {
    title: "Part 7 — Delivery, where the job is supply-only",
    intro: "Supply lines take the delivery lane instead of the site gates above.",
    steps: [
      {
        n: 31,
        who: "PD",
        what: "Issue the delivery receipt",
        where: "Operations → the delivery ticket → “Request DR”",
        doThis: ["Request the DR, and confirm the site contact before the vehicle leaves."],
        expect: ["AIESDR-26xxxx."],
      },
      {
        n: 32,
        who: "The driver",
        what: "Record what happened at the door",
        where: "Operations → Delivery mode, on a phone",
        doThis: ["Capture the recipient's signature, or record the attempt as failed and why."],
        expect: [
          "A failed attempt raises a task to contact the customer and reschedule.",
          "A signed DR is what makes the delivery billable.",
        ],
      },
    ],
  },
  {
    title: "Part 8 — Final billing and the money in",
    intro:
      "The last stretch. Everything here is finance's, and the gate before it is the reason the " +
      "rest of the platform exists.",
    steps: [
      {
        n: 33,
        who: "Finance",
        what: "Check the final billing gate",
        where: "Orders → Sales orders → the order → the billing panel",
        doThis: ["Read the gate."],
        expect: [
          "It lists the seven conditions and names the owner of anything outstanding.",
          "It will not let a final statement be raised while work is unfinished — which is what stops AIES billing for a job it has not delivered.",
        ],
      },
      {
        n: 34,
        who: "Finance",
        what: "Raise and issue the final statement",
        where: "Finance → Ready to bill → the milestone → “Raise a statement”, then Issue",
        doThis: [
          "Check the amount against the order and the variations.",
          "Issue it and send it to the customer.",
        ],
        expect: ["AIESBS-26xxxx, ageing from its due date."],
      },
      {
        n: 35,
        who: "Finance",
        what: "Record the payment",
        where: "Finance → Statements → the statement → “Record payment”",
        doThis: [
          "Bank transfer: enter the reference and the amount.",
          "Cheque: enter the number and date, then clear it when the bank confirms.",
        ],
        expect: [
          "AIESPMT-26xxxx and the service invoice.",
          "A bounced cheque reverses cleanly and the statement goes back to outstanding.",
        ],
      },
      {
        n: 36,
        who: "Finance",
        what: "Record the 2307 when it arrives",
        where: "Finance → Statements → the statement → “Record 2307”",
        doThis: ["Enter the withheld amount and the form's date."],
        expect: [
          "The statement closes to paid.",
          "Until the form is in hand the withheld amount keeps ageing, because AIES has neither the cash nor the credit.",
        ],
      },
      {
        n: 37,
        who: "Finance",
        what: "Check the job actually made money",
        where: "Operations → Projects → the project → the P&L panel",
        doThis: ["Compare the quoted margin with the actual."],
        expect: [
          "Contract value, cost, and margin — with caveats named: hours with no cost rate, advances not yet liquidated.",
          "Where an advance is still out, it shows what the margin becomes once it is liquidated.",
        ],
      },
      {
        n: 38,
        who: "Finance",
        what: "Chase what is still owed",
        where: "Finance → Receivables and Finance → Collections",
        doThis: ["Work the ageing list.", "Log each call or email against the customer."],
        expect: [
          "Ageing buckets, and the credit exposure per customer.",
          "A logged conversation is what the next person picks up from.",
        ],
      },
    ],
  },
];

function StepBlock({ step }: { step: Step }) {
  return (
    <View
      wrap={false}
      style={{
        marginBottom: 12,
        paddingLeft: 10,
        borderLeftWidth: 2,
        borderLeftColor: PDF_COLORS.surface2,
      }}
    >
      <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 10, color: PDF_COLORS.navy800 }}>
        {step.n}. {step.what}
      </Text>
      <Text style={{ fontSize: 8, color: PDF_COLORS.textMuted, marginTop: 2 }}>{step.who}</Text>
      <Text style={{ fontSize: 8.5, marginTop: 4 }}>
        <Text style={{ fontFamily: "Helvetica-Bold" }}>Where: </Text>
        {step.where}
      </Text>

      <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 8.5, marginTop: 5 }}>What to do</Text>
      {step.doThis.map((line, index) => (
        <Text key={index} style={{ fontSize: 8.5, marginLeft: 8 }}>
          • {line}
        </Text>
      ))}

      <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 8.5, marginTop: 5 }}>
        What should happen
      </Text>
      {step.expect.map((line, index) => (
        <Text key={index} style={{ fontSize: 8.5, marginLeft: 8 }}>
          • {line}
        </Text>
      ))}

      {step.note && (
        <Text
          style={{
            fontSize: 8,
            marginTop: 5,
            padding: 5,
            backgroundColor: PDF_COLORS.surface2,
            color: PDF_COLORS.text,
          }}
        >
          {step.note}
        </Text>
      )}
    </View>
  );
}

function WalkthroughDocument() {
  return (
    <Document title="AIES Operations Platform — end-to-end walkthrough">
      <Page size="A4" style={pdfStyles.page}>
        <View style={pdfStyles.headerRow}>
          <View>
            <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 18, color: PDF_COLORS.navy800 }}>
              End-to-end walkthrough
            </Text>
            <Text style={{ fontSize: 10, color: PDF_COLORS.textMuted, marginTop: 2 }}>
              From an enquiry arriving to the money in the bank
            </Text>
          </View>
          <View style={pdfStyles.companyBlock}>
            <Text style={pdfStyles.companyName}>{COMPANY.name}</Text>
            {COMPANY.addressLines.map((line) => (
              <Text key={line}>{line}</Text>
            ))}
          </View>
        </View>
        <View style={pdfStyles.headerRule} />

        <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 11, color: PDF_COLORS.navy800 }}>
          Before you start
        </Text>
        <Text style={{ fontSize: 9, marginTop: 4 }}>
          The platform is at aies-system.vercel.app. Sign in with your own account — the walkthrough
          moves between four people on purpose, because the gates are the point and a gate you can
          walk through yourself is not a gate.
        </Text>
        <Text style={{ fontSize: 9, marginTop: 6 }}>
          First sign-in for an account that has not been used: you will be asked to change the
          password, and then to set up an authenticator app. Both are required and neither can be
          skipped. Keep the recovery codes you are shown — there is no administrator who can reset
          an authenticator for you, and that is deliberate.
        </Text>

        <Text
          style={{
            fontFamily: "Helvetica-Bold",
            fontSize: 11,
            color: PDF_COLORS.navy800,
            marginTop: 12,
          }}
        >
          How to read a step
        </Text>
        <Text style={{ fontSize: 9, marginTop: 4 }}>
          Each step names who does it, where to go, what to do there, and what should happen. If
          what happens is not what the step says, stop and write down which step and what you saw.
          That is the finding — not a fault to work around.
        </Text>

        <Text
          style={{
            fontFamily: "Helvetica-Bold",
            fontSize: 11,
            color: PDF_COLORS.navy800,
            marginTop: 12,
          }}
        >
          A note on refusals
        </Text>
        <Text style={{ fontSize: 9, marginTop: 4 }}>
          Several steps below will refuse to do what you ask. A quotation with no cost will not be
          submitted; a job with no client approval will not mobilise; a final statement will not be
          raised for work that is unfinished. Every refusal names what is missing and whose it is.
          Those are the controls the platform was built for — the walkthrough is as much about
          checking they hold as it is about the happy path.
        </Text>

        <Text style={{ fontSize: 8, color: PDF_COLORS.textMuted, marginTop: 16 }}>
          Generated {new Date().toISOString().slice(0, 10)} from the platform&rsquo;s own navigation
          and document numbering.
        </Text>
      </Page>

      {PARTS.map((part) => (
        <Page key={part.title} size="A4" style={pdfStyles.page}>
          <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 13, color: PDF_COLORS.navy800 }}>
            {part.title}
          </Text>
          <View
            style={{ height: 2, backgroundColor: PDF_COLORS.red500, marginTop: 6, marginBottom: 8 }}
          />
          <Text style={{ fontSize: 9, marginBottom: 10, color: PDF_COLORS.textMuted }}>
            {part.intro}
          </Text>

          {part.steps.map((step) => (
            <StepBlock key={step.n} step={step} />
          ))}

          <Text
            fixed
            style={{
              position: "absolute",
              bottom: 24,
              left: 40,
              right: 40,
              fontSize: 7.5,
              color: PDF_COLORS.textMuted,
              textAlign: "center",
            }}
            render={({ pageNumber, totalPages }) =>
              `AIES Operations Platform — end-to-end walkthrough · page ${pageNumber} of ${totalPages}`
            }
          />
        </Page>
      ))}
    </Document>
  );
}

async function main() {
  const out = "docs/WALKTHROUGH-END-TO-END.pdf";
  const buffer = await renderToBuffer(<WalkthroughDocument />);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buffer);
  const steps = PARTS.reduce((total, part) => total + part.steps.length, 0);
  console.log(`Wrote ${out} — ${PARTS.length} parts, ${steps} steps, ${buffer.length} bytes.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
