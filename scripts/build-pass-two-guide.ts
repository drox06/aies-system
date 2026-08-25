import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The second pass: a guide the four of them work through, and a questionnaire in the same document.
 *
 * ## Why the questions sit inside the steps
 *
 * The first pass produced fifteen findings, nine of which asked for something to be *added*. Asked
 * afterwards, people describe what they wish existed; asked at the moment a screen refused them or
 * took four fields it did not need, they describe what is actually in the way. So each step carries
 * its own questions, to be answered while the screen is still in front of them.
 *
 * ## Why it starts before the inquiry
 *
 * The first guide began at "log an inquiry" and assumed a customer already existed. PD spent an
 * evening enrolling Maynilad, its six plants and two principals before anybody could log anything —
 * work the guide never mentioned. This one starts where the work starts.
 */

interface Step {
  n: number;
  who: string;
  what: string;
  where: string;
  doThis: string[];
  expect: string[];
  ask: string[];
  note?: string;
}

interface Part {
  title: string;
  intro: string;
  steps: Step[];
}

const PARTS: Part[] = [
  {
    title: "Part 1 — Enrolling a customer",
    intro:
      "PD has already done this once, with Maynilad. Do it again with a different customer and " +
      "watch where the form slows you down — the first time through, everything is unfamiliar; the " +
      "second time, only the awkward parts are.",
    steps: [
      {
        n: 1,
        who: "PD",
        what: "Create the customer account",
        where: "Customers → Accounts → “New account”",
        doThis: [
          "Enter the company's registered name, TIN and billing address.",
          "Set the payment terms you expect to give them.",
          "Save.",
        ],
        expect: [
          "An account code of the form AIESACC-0003.",
          "A warning if the name looks like one already on file — that is duplicate detection, not an error.",
        ],
        ask: [
          "Which fields did you leave blank? Would you miss any of them if they were removed?",
          "Is there anything you needed to record about this customer that the form had nowhere for?",
        ],
      },
      {
        n: 2,
        who: "PD",
        what: "Add the people you deal with",
        where: "The account → Contacts → “Add contact”",
        doThis: [
          "Add the primary contact — the person you actually call.",
          "Add any others: procurement, accounts payable, the plant engineer.",
        ],
        expect: ["The primary contact appears in the account header."],
        ask: [
          "How many contacts does a real customer need before this is useful? One, or five?",
          "Did you want to record what each person is *for*, and could you?",
        ],
      },
      {
        n: 3,
        who: "PD",
        what: "Add their plants or sites",
        where: "The account → Sites → “Add plant”",
        doThis: [
          "Add each plant you work at, with its address and access notes.",
          "Note anything a crew arriving at six in the morning would need to know.",
        ],
        expect: ["Each plant becomes selectable when an inquiry or ticket is raised."],
        ask: [
          "You added five plants and then edited all five a minute later. What was missing the first time?",
          "Would you rather add plants one at a time, or paste a list?",
        ],
        note:
          "This is the step where the log shows the most doubling back — five records created, then " +
          "five updated in ten seconds. Whatever caused that is worth a sentence.",
      },
      {
        n: 4,
        who: "PD",
        what: "Start their accreditation",
        where: "Customers → Accreditations → the account → “Start accreditation”",
        doThis: [
          "Record which documents they have asked AIES for.",
          "Upload what has been submitted, and set the expiry date they gave you.",
        ],
        expect: [
          "A renewal reminder is scheduled before the expiry.",
          "The account shows its accreditation status on the list.",
        ],
        ask: [
          "Is accreditation something you track per customer, or only for the big ones?",
          "Does this need to be its own screen, or should it live on the customer's own page?",
        ],
      },
    ],
  },
  {
    title: "Part 2 — Enrolling a supplier and a principal",
    intro:
      "The other half of enrolment, and the half the last guide skipped entirely. A supplier is " +
      "somebody AIES buys from. A principal is a manufacturer AIES represents.",
    steps: [
      {
        n: 5,
        who: "PD",
        what: "Add a supplier",
        where: "Orders → Suppliers → “New supplier”",
        doThis: [
          "Enter the company, its contact, and what they supply.",
          "Record their payment terms and lead time if you know them.",
        ],
        expect: ["A supplier code, and the supplier becomes selectable on an RFQ."],
        ask: [
          "What do you need to know about a supplier before you would ask them for a price?",
          "Is anything on this form something you would never fill in?",
        ],
      },
      {
        n: 6,
        who: "PD",
        what: "Add a principal, and appoint them",
        where: "Orders → Principals → “Add prospect”, then move it along",
        doThis: [
          "Add the manufacturer as a prospect — you have already done VAG and Hebei Bestop.",
          "Move it through the stages to appointed, and see what happens.",
        ],
        expect: [
          "An appointed principal becomes a supplier automatically.",
          "The prospect keeps its history rather than disappearing.",
        ],
        ask: [
          "Do the prospect stages match how a principal appointment really goes?",
          "Would you rather just add a supplier and tick “we represent them”?",
        ],
      },
    ],
  },
  {
    title: "Part 3 — The inquiry",
    intro:
      "EM has logged two. This time take one all the way to the point where it becomes a quotation, " +
      "and note every moment you were unsure what to press.",
    steps: [
      {
        n: 7,
        who: "EM",
        what: "Log the inquiry",
        where: "Sales → Inquiries → “Log inquiry”",
        doThis: [
          "Choose the customer and the plant.",
          "Write the subject in the customer's own words.",
          "Add the items or the scope of work, as far as you know it.",
        ],
        expect: ["A number, AIESINQ-26xxxx, and status new."],
        ask: [
          "Could you record service work here, or only items? What did you want to type that would not go in?",
          "How much of this did you know at the moment the enquiry arrived, and how much did you have to go and ask for?",
        ],
      },
      {
        n: 8,
        who: "EM",
        what: "Acknowledge it",
        where: "The inquiry → “Acknowledge”",
        doThis: ["Press it once you have actually replied to the customer."],
        expect: ["Status: acknowledged. The one-working-day clock stops."],
        ask: [
          "On the last pass this was pressed seven seconds after logging. Is acknowledging a real step in your day, or a button in the way?",
        ],
      },
      {
        n: 9,
        who: "DJ",
        what: "Put the scope on it",
        where: "The inquiry → line items",
        doThis: [
          "Add or correct the items — you added ten to AIESINQ-260001.",
          "Save, and check the record shows what you meant.",
        ],
        expect: ["The items appear on the inquiry and carry through to the quotation later."],
        ask: [
          "You saved this three times in eighty seconds. What did the screen not show you the first time?",
          "Is there a field on the line item you always leave blank?",
        ],
      },
      {
        n: 10,
        who: "EM or DJ",
        what: "Work the requirements checklist",
        where: "The inquiry → requirements",
        doThis: [
          "Tick what the customer has supplied, and upload the documents.",
          "Leave what is missing unticked — that is the point of it.",
        ],
        expect: [
          "The inquiry will not move to quoting until the mandatory items are in, and it names them.",
        ],
        ask: [
          "Are these the right requirements for your work, or a list somebody guessed at?",
          "Which of them do you genuinely chase a customer for?",
        ],
      },
      {
        n: 11,
        who: "KJ or DJ",
        what: "Request a site inspection",
        where: "The inquiry → “Request inspection”",
        doThis: ["Name the technician and the date.", "Say what needs looking at."],
        expect: [
          "The technician is notified and it appears on the calendar.",
          "The inquiry moves to inspection required.",
        ],
        ask: [
          "The status on AIESINQ-260001 moved between evaluating and inspection-required three times, by three different people. What were you each trying to do?",
          "Should requesting an inspection change the status at all, or should the inspection just be a thing attached to the enquiry?",
        ],
      },
      {
        n: 12,
        who: "DJ",
        what: "Conduct the inspection and record it",
        where: "Operations → Site inspections → the scheduled one",
        doThis: [
          "Record what you found, who was there, and the measurements.",
          "Attach the photographs.",
          "If the scope has changed, say so here.",
        ],
        expect: ["A numbered site inspection record with the photographs on it."],
        ask: [
          "**You asked to be able to generate an inspection report from this.** What must that report contain, and who receives it — the customer, or the file?",
          "What did you have to write down on paper because this screen had nowhere for it?",
        ],
      },
      {
        n: 13,
        who: "EM",
        what: "Move it to quoting",
        where: "The inquiry → “Start quoting”",
        doThis: ["Press it once the requirements are complete."],
        expect: [
          "A draft quotation is created and linked to the inquiry.",
          "Find it under Sales → Quotations.",
        ],
        ask: [
          "Did anything refuse you here? Write down exactly what it said — refusals leave no trace in the system, so if you do not write it down we cannot see it.",
        ],
      },
    ],
  },
  {
    title: "Part 4 — Prices from suppliers",
    intro: "Runs alongside the quotation. This is PD's part of the job.",
    steps: [
      {
        n: 14,
        who: "PD",
        what: "Ask suppliers for prices",
        where: "Orders → Procurement → “New RFQ”",
        doThis: [
          "Pick several suppliers at once.",
          "List what you need priced.",
          "Send it, then record each reply as it comes back.",
        ],
        expect: [
          "An RFQ number, and a side-by-side comparison as replies arrive.",
          "Applying an offer copies its prices rather than making you retype them.",
        ],
        ask: [
          "The draft wording was flagged last time. What should the request to a supplier actually say?",
          "Do you send one RFQ to five suppliers, or five separate emails? Does this match?",
        ],
      },
    ],
  },
  {
    title: "Part 5 — The quotation",
    intro:
      "Nobody reached this on the first pass. Two gates live here: a quotation cannot be sent " +
      "without a cost behind it, and KJ must approve it.",
    steps: [
      {
        n: 15,
        who: "EM",
        what: "Build the quotation",
        where: "Sales → Quotations → the draft",
        doThis: [
          "Add a line per item or scope of work.",
          "Enter the supplier cost against each line and the margin you intend.",
          "Choose the payment terms — these decide the billing schedule later.",
          "Set the validity date.",
        ],
        expect: ["The total, VAT and margin update as you type."],
        ask: [
          "You asked for a header percentage on the costing and a discount on the quote. Where exactly should each of those appear, and who is allowed to see them?",
          "How many lines does a real quotation have — three, or thirty?",
        ],
      },
      {
        n: 16,
        who: "EM",
        what: "Arrange the terms and conditions",
        where: "The quotation → terms",
        doThis: ["Set the terms you want on this quotation and try to reorder them."],
        expect: ["They print on the PDF in the order shown."],
        ask: [
          "Which terms are on every quotation, and which change per job? If most never change, should they be a template you rarely touch?",
        ],
      },
      {
        n: 17,
        who: "EM",
        what: "Send it for approval",
        where: "The quotation → “Submit for approval”",
        doThis: ["Press it, then check what KJ receives."],
        expect: [
          "It appears in KJ's queue at Sales → Quotations for Approval, and KJ is notified.",
          "A quotation with an uncosted line is refused, and names the line.",
        ],
        ask: [
          "Did the cost gate stop you? If it did, was it right to?",
          "Did KJ actually get told? Say how you found out — bell, or somebody said so.",
        ],
      },
      {
        n: 18,
        who: "KJ",
        what: "Approve or reject it",
        where: "Sales → Quotations for Approval",
        doThis: [
          "Open it, check the margin and the terms.",
          "Approve it, or reject it with a reason.",
        ],
        expect: [
          "Approved: it can now be sent. Rejected: it goes back to EM with the reason kept on the record.",
        ],
        ask: [
          "Is this the right thing for the VP to be approving, and is the screen showing you what you need to decide?",
          "What would you want to see that is not on it?",
        ],
      },
      {
        n: 19,
        who: "EM",
        what: "Send it to the customer",
        where: "The quotation → “Send”",
        doThis: [
          "Download the PDF, look at it as the customer will, then send it from your own email.",
          "Press Send so the platform records that it went.",
        ],
        expect: [
          "Status: sent. A follow-up reminder is scheduled. The validity date starts counting.",
        ],
        ask: [
          "Is the PDF something you would put in front of a customer as it stands? What is wrong with it?",
        ],
      },
    ],
  },
  {
    title: "Part 6 — The order and the money in advance",
    intro: "The customer's PO is the moment the job becomes real.",
    steps: [
      {
        n: 20,
        who: "EM",
        what: "Record the customer's PO",
        where: "Sales → Pipeline → Received PO, or the quotation → “Record PO”",
        doThis: [
          "Enter their PO number and date, and upload the document.",
          "Confirm the amount against the quotation.",
        ],
        expect: [
          "A sales order, AIESSO-26xxxx. The quotation is marked won and the inquiry closes.",
          "Tasks appear for sales, operations, procurement and finance.",
        ],
        ask: [
          "Last time somebody removed a PO, entered a new one, and it still said a PO existed. Try that deliberately and write down what you see.",
          "**Check My Work straight after this.** Did anything appear for you? This is the moment the task system is supposed to wake up.",
        ],
      },
      {
        n: 21,
        who: "Finance",
        what: "Raise and issue the downpayment",
        where: "Finance → Ready to bill → the milestone → “Raise a statement”, then Issue",
        doThis: ["Check the amount and due date, raise it, then issue it."],
        expect: [
          "A billing statement. Issued, it starts ageing in Receivables.",
          "The amount should match the percentage on the payment terms — check it.",
        ],
        ask: [
          "Is the downpayment amount right? Say the number you expected and the number you saw.",
        ],
      },
      {
        n: 22,
        who: "Finance",
        what: "Record the payment when it arrives",
        where: "Finance → Statements → the statement → “Record payment”",
        doThis: [
          "Choose the method. For a cheque, enter its number and date.",
          "Enter what actually arrived — if tax was withheld, that is less than the statement.",
        ],
        expect: [
          "A payment and a service invoice, with a printable reference copy.",
          "A cheque stays pending until you clear it.",
        ],
        ask: [
          "Does the service invoice reference copy carry everything your external BIR form needs?",
          "How often is tax withheld, in reality?",
        ],
      },
    ],
  },
  {
    title: "Part 7 — Doing the work",
    intro:
      "DJ has asked that this part be reduced to the inspection report, the service report and " +
      "testing and commissioning. Walk it as it stands so we can see exactly which forms earn their " +
      "place and which do not.",
    steps: [
      {
        n: 23,
        who: "DJ",
        what: "Generate the tickets",
        where: "Orders → Sales orders → the order → “Generate tickets”",
        doThis: ["Press it and look at what you get."],
        expect: ["One ticket per piece of work, a project record, and a channel for the job."],
        ask: [
          "Is one ticket per line the right split, or would you rather one ticket for the whole job?",
        ],
      },
      {
        n: 24,
        who: "DJ",
        what: "Everything between mobilising and finishing",
        where: "Operations → the ticket, working down the panels",
        doThis: [
          "Walk the method statement, materials, mobilisation, daily progress and QA panels in order.",
          "Do not fill them in properly — just look at each one and decide whether you would ever use it.",
        ],
        expect: ["Several will refuse until something earlier is done, and will say what."],
        ask: [
          "**For each panel: would you use this on a real job, or is it in the way?** Name them one by one.",
          "Which of these do you already do on paper, and would keep doing on paper?",
          "Where a gate refused you — was it protecting something real, or just being difficult?",
        ],
        note:
          "This is the most important step in the guide for the simplification. Take your time on it " +
          "and be blunt.",
      },
      {
        n: 25,
        who: "DJ",
        what: "Testing and commissioning",
        where: "Operations → the ticket → T&C",
        doThis: ["Record the results and any punch items."],
        expect: ["A certificate, and accepted commissioning is what opens final billing."],
        ask: ["Is the T&C form close to the one you use now? What is missing from it?"],
      },
      {
        n: 26,
        who: "DJ",
        what: "The service report",
        where: "Operations → the ticket → service report",
        doThis: ["Write it, and try to produce a copy for the client."],
        expect: ["A numbered service report on the record."],
        ask: [
          "**It cannot currently be downloaded.** What should the finished document look like, and does the client sign it on site or afterwards?",
        ],
      },
      {
        n: 27,
        who: "DJ",
        what: "Close the project",
        where: "Operations → Projects → the project → close-out",
        doThis: ["Work down the checklist and close it."],
        expect: [
          "It refuses while anything is outstanding and names what.",
          "Closing raises the final invoice task for finance.",
        ],
        ask: [
          "Is the close-out checklist yours, or somebody's idea of yours? Which items would you delete?",
        ],
      },
    ],
  },
  {
    title: "Part 8 — Getting paid",
    intro: "The end of the arc, and the reason the gates before it exist.",
    steps: [
      {
        n: 28,
        who: "Finance",
        what: "Read the final billing gate",
        where: "Orders → Sales orders → the order → billing panel",
        doThis: ["Read what it says before raising anything."],
        expect: ["Seven conditions, each naming its owner and whether it is met."],
        ask: [
          "Are all seven conditions things that should genuinely stop an invoice? Which would you drop?",
        ],
      },
      {
        n: 29,
        who: "Finance",
        what: "Raise and issue the final statement",
        where: "Finance → Ready to bill → the milestone",
        doThis: ["Check the amount against the order and any variations, issue it, send it."],
        expect: ["A statement, ageing from its due date."],
        ask: ["Did the amount match what you would have invoiced by hand?"],
      },
      {
        n: 30,
        who: "Finance",
        what: "Record the final payment",
        where: "Finance → Statements → “Record payment”",
        doThis: [
          "Record a bank transfer, or a cheque and then clear it.",
          "If tax was withheld, record the 2307 when the form arrives.",
        ],
        expect: [
          "The statement closes to paid once the cash and any withholding credit are both in.",
          "Until the 2307 arrives it keeps ageing — that is deliberate.",
        ],
        ask: [
          "Is the withholding behaviour right for how your customers actually pay?",
          "How long, in practice, between the payment and the 2307 arriving?",
        ],
      },
      {
        n: 31,
        who: "Anyone",
        what: "Look back at the job",
        where: "Operations → Projects → the project → P&L",
        doThis: ["Compare the quoted margin with what it actually made."],
        expect: ["Contract value, cost, margin, and any caveats named."],
        ask: [
          "Is this the number you would want to see at the end of a job? What else belongs on it?",
          "Who should be allowed to see it?",
        ],
      },
    ],
  },
  {
    title: "Last — three questions about the whole thing",
    intro: "Answer these after you have finished, not during.",
    steps: [
      {
        n: 32,
        who: "Everyone",
        what: "The whole platform",
        where: "Wherever you have been",
        doThis: ["Think back over the whole pass."],
        expect: ["—"],
        ask: [
          "Which three screens would you keep if you could only keep three?",
          "Which screen did you open once and never again?",
          "What did you end up doing outside the app — on paper, in a chat, in a spreadsheet — because it was faster?",
        ],
      },
      {
        n: 33,
        who: "Everyone",
        what: "The things that stopped you",
        where: "—",
        doThis: ["Collect every refusal and error you wrote down."],
        expect: ["—"],
        ask: [
          "List every message that stopped you, word for word if you have it.",
          "For each one: was it right to stop you?",
          "Anything that was slow — how slow, and where?",
        ],
        note:
          "The system records what succeeded. Refusals and errors leave no trace at all, so this " +
          "list only exists if you write it. It is the most useful thing you can give us.",
      },
    ],
  },
];

const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `**bold**` in the source, because a few phrases genuinely need the emphasis. */
const strong = (value: string) => escape(value).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const totalSteps = PARTS.reduce((sum, part) => sum + part.steps.length, 0);
const totalQuestions = PARTS.reduce(
  (sum, part) => sum + part.steps.reduce((n, step) => n + step.ask.length, 0),
  0,
);

const html = `<title>Second Pass</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root {
    --ink: #0f1b2a;
    --muted: #5a6b7d;
    --heading: #012076;
    --link: #003999;
    --rule: #ee010c;
    --ground: #f6f8fb;
    --surface: #ffffff;
    --surface-2: #eef2f7;
    --border: #dce3eb;
    --chip: #012076;
    --chip-ink: #ffffff;
    --ask-edge: #003999;
    --ask-tint: #f0f4fb;
  }

  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ink: #e6ecf5;
      --muted: #93a3b8;
      --heading: #a8bcff;
      --link: #8fa8ff;
      --rule: #ff5a62;
      --ground: #0b1220;
      --surface: #121c2e;
      --surface-2: #18253b;
      --border: #24334a;
      --chip: #2a3d63;
      --chip-ink: #e6ecf5;
      --ask-edge: #8fa8ff;
      --ask-tint: #16233a;
    }
  }

  :root[data-theme="dark"] {
    --ink: #e6ecf5;
    --muted: #93a3b8;
    --heading: #a8bcff;
    --link: #8fa8ff;
    --rule: #ff5a62;
    --ground: #0b1220;
    --surface: #121c2e;
    --surface-2: #18253b;
    --border: #24334a;
    --chip: #2a3d63;
    --chip-ink: #e6ecf5;
    --ask-edge: #8fa8ff;
    --ask-tint: #16233a;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 15px;
    line-height: 1.55;
    -webkit-text-size-adjust: 100%;
  }

  .wrap { max-width: 40rem; margin: 0 auto; padding: 0 1rem 4rem; }

  header.top {
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--ground);
    border-bottom: 1px solid var(--border);
    padding: 0.75rem 0 0.5rem;
  }
  header.top h1 { margin: 0; font-size: 1.05rem; color: var(--heading); text-wrap: balance; }
  header.top p { margin: 0.15rem 0 0.5rem; font-size: 0.8rem; color: var(--muted); }

  nav.parts { display: flex; gap: 0.4rem; overflow-x: auto; padding-bottom: 0.15rem; }
  nav.parts::-webkit-scrollbar { display: none; }
  nav.parts a {
    flex: 0 0 auto; font-size: 0.75rem; text-decoration: none; color: var(--link);
    border: 1px solid var(--border); background: var(--surface); border-radius: 999px;
    padding: 0.2rem 0.6rem; white-space: nowrap;
  }

  section.intro { margin-top: 1rem; }
  section.intro h2 { font-size: 0.95rem; color: var(--heading); margin: 1.1rem 0 0.25rem; }
  section.intro p { margin: 0.3rem 0; font-size: 0.9rem; }
  section.intro ul { margin: 0.3rem 0; padding-left: 1.1rem; font-size: 0.9rem; }

  h2.part {
    margin: 2rem 0 0; font-size: 1rem; color: var(--heading);
    scroll-margin-top: 5.5rem; text-wrap: balance;
  }
  .part-rule { height: 2px; background: var(--rule); margin: 0.4rem 0 0.5rem; }
  p.part-intro { margin: 0 0 1rem; font-size: 0.85rem; color: var(--muted); }

  article.step {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 0.6rem; padding: 0.85rem 0.9rem; margin-bottom: 0.75rem;
  }
  .step-head { display: flex; gap: 0.6rem; align-items: baseline; }
  .n {
    flex: 0 0 auto; background: var(--chip); color: var(--chip-ink); border-radius: 0.35rem;
    font-size: 0.72rem; font-variant-numeric: tabular-nums; padding: 0.1rem 0.4rem; font-weight: 600;
  }
  .what { font-weight: 600; font-size: 0.95rem; }
  .who { margin: 0.3rem 0 0; font-size: 0.78rem; color: var(--muted); }

  .where {
    margin: 0.6rem 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.78rem; background: var(--surface-2); border-left: 2px solid var(--link);
    border-radius: 0 0.3rem 0.3rem 0; padding: 0.35rem 0.5rem; overflow-wrap: anywhere;
  }

  h3 {
    margin: 0.75rem 0 0.2rem; font-size: 0.7rem; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--muted);
  }
  ul { margin: 0; padding-left: 1.1rem; }
  li { margin: 0.15rem 0; font-size: 0.88rem; }

  .expect { background: var(--surface-2); border-radius: 0.4rem; padding: 0.5rem 0.6rem; margin-top: 0.3rem; }
  .expect h3 { margin-top: 0; }

  /* The questions are the point of this document, so they are the one thing that looks like a form. */
  .ask {
    margin-top: 0.7rem; background: var(--ask-tint);
    border: 1px dashed var(--ask-edge); border-radius: 0.4rem; padding: 0.55rem 0.65rem;
  }
  .ask h3 { margin-top: 0; color: var(--ask-edge); }
  .ask li { margin: 0.3rem 0; }

  .note {
    margin-top: 0.7rem; font-size: 0.82rem; border-left: 2px solid var(--rule);
    padding: 0.3rem 0 0.3rem 0.6rem; color: var(--muted);
  }

  footer { margin-top: 2.5rem; font-size: 0.78rem; color: var(--muted); }
</style>

<div class="wrap">
  <header class="top">
    <h1>Second pass — enrolment to payment</h1>
    <p>${totalSteps} steps · ${totalQuestions} questions · AIES Operations Platform</p>
    <nav class="parts">
      ${PARTS.map(
        (part, index) =>
          `<a href="#${slug(part.title)}">${escape(part.title.replace(/^(Part \d+|Last) — /, `${index + 1}. `))}</a>`,
      ).join("\n      ")}
    </nav>
  </header>

  <section class="intro">
    <h2>Thank you — and what we saw</h2>
    <p>
      Between Monday evening and this afternoon the four of you did thirty-nine recorded things, and
      they were real work rather than clicking about:
    </p>
    <ul>
      <li><strong>PD</strong> enrolled Maynilad Water Services, its contact, six plants, its accreditation, and two principals — VAG-Valves and Hebei Bestop.</li>
      <li><strong>EM</strong> logged two enquiries and moved them along.</li>
      <li><strong>DJ</strong> put ten line items on the first one.</li>
      <li><strong>KJ</strong> requested the site inspection now scheduled for the 27th.</li>
    </ul>
    <p>
      Nothing was broken underneath: no failed jobs, no errors in the queue, no lost notifications.
    </p>

    <h2>What this second pass is for</h2>
    <p>
      The platform is more complicated than it needs to be, and we are going to cut it back. What we
      cannot do is guess which parts to cut — so this guide walks the whole arc, from enrolling a
      customer through to the money arriving, and <strong>asks you questions at each step</strong>.
    </p>
    <p>
      Answer them as you go, with the screen still in front of you. Asked afterwards, people describe
      what they wish existed; asked in the moment, they describe what is actually in the way. The
      second is worth far more.
    </p>

    <h2>The one thing to write down without fail</h2>
    <p>
      <strong>Every refusal and every error, word for word.</strong> The system records what
      succeeded — a screen that stopped you leaves no trace at all. If you do not write it down, we
      cannot see it, and those moments are the most valuable thing in the week.
    </p>

    <h2>How to read a step</h2>
    <p>
      Each one says who does it, where to go, what to do, what should happen — and what we would
      like to know. Where what happens is not what the step says, that is a finding: note the step
      number and what you saw, and carry on.
    </p>
  </section>

  ${PARTS.map(
    (part) => `
  <h2 class="part" id="${slug(part.title)}">${escape(part.title)}</h2>
  <div class="part-rule"></div>
  <p class="part-intro">${escape(part.intro)}</p>
  ${part.steps
    .map(
      (step) => `
  <article class="step">
    <div class="step-head">
      <span class="n">${step.n}</span>
      <span class="what">${escape(step.what)}</span>
    </div>
    <p class="who">${escape(step.who)}</p>
    <p class="where">${escape(step.where)}</p>
    <h3>What to do</h3>
    <ul>${step.doThis.map((line) => `<li>${strong(line)}</li>`).join("")}</ul>
    <div class="expect">
      <h3>What should happen</h3>
      <ul>${step.expect.map((line) => `<li>${strong(line)}</li>`).join("")}</ul>
    </div>
    <div class="ask">
      <h3>Tell us</h3>
      <ul>${step.ask.map((line) => `<li>${strong(line)}</li>`).join("")}</ul>
    </div>
    ${step.note ? `<p class="note">${strong(step.note)}</p>` : ""}
  </article>`,
    )
    .join("")}`,
  ).join("\n")}

  <footer>
    Generated ${new Date().toISOString().slice(0, 10)} from the platform&rsquo;s own navigation.
    Send your answers back however is easiest — one message per part is fine.
  </footer>
</div>
`;

const out = "docs/pass-two-guide.html";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html, "utf8");
console.log(
  `Wrote ${out} — ${PARTS.length} parts, ${totalSteps} steps, ${totalQuestions} questions.`,
);
