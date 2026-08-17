import { db } from "../src/lib/db";
import { createInspectionRequestService } from "../src/server/core/crm/inspection-service";
import {
  createInquiryService,
  transitionInquiryService,
} from "../src/server/core/crm/inquiry-service";
import {
  completeInspectionService,
  saveInspectionService,
  scheduleFromInspectionRequest,
} from "../src/server/core/operations/site-inspection-service";
import {
  createMethodologyService,
  saveMethodologyService,
} from "../src/server/core/operations/methodology-service";
import { createStandaloneTicketService } from "../src/server/core/operations/ticket-service";

/**
 * One sample record on each screen that has none, so the company can look at a populated page.
 *
 * Written 2026-08-17, after the purge left the operations screens empty. **Guarded** like the other
 * data-writing scripts — `ALLOW_DEMO_DATA=1`, docs/DECISIONS.md #76 — because it writes to whatever
 * database it is pointed at.
 *
 * ## Why it goes through the services rather than `db.create`
 *
 * A row inserted directly looks right and behaves wrong: no number allocated from the sequence, no
 * audit row, no events, and none of the completeness rules exercised. A sample built that way is a
 * sample of a screen rendering, not of the system working — and the first thing it hides is whichever
 * rule the real path would have failed.
 *
 * Everything it creates hangs off the existing account and its real inquiry, so it is removable by
 * the numbers this prints.
 */

if (process.env.ALLOW_DEMO_DATA !== "1") {
  console.error("Refusing: set ALLOW_DEMO_DATA=1. This writes records to the target database.");
  process.exit(1);
}

async function main() {
  const account = await db.customerAccount.findFirstOrThrow({
    where: { deletedAt: null },
    select: { id: true, name: true, code: true },
  });
  const ea = await db.user.findFirstOrThrow({
    where: { email: "ea@aieselectromech.com" },
    select: { id: true, name: true },
  });
  const dj = await db.user.findFirst({
    where: { email: "dj@aieselectromech.com" },
    select: { id: true, name: true },
  });
  const actor = { actorId: ea.id, actorLabel: ea.name ?? "EA" };
  const created: string[] = [];

  // Clear what a previous run left. Written after three failed attempts left three stray tickets:
  // a sample script that is not re-runnable becomes its own source of clutter, which is exactly
  // the mess the purge existed to clean up.
  const priorTickets = await db.ticket.findMany({
    where: { title: { startsWith: "Sample — " } },
    select: { id: true },
  });
  const priorInquiries = await db.inquiry.findMany({
    where: { subject: { startsWith: "Sample — " } },
    select: { id: true },
  });
  const priorTicketIds = priorTickets.map((t) => t.id);
  const priorInquiryIds = priorInquiries.map((i) => i.id);

  if (priorTicketIds.length || priorInquiryIds.length) {
    await db.methodology.deleteMany({ where: { ticketId: { in: priorTicketIds } } });
    // Every row in these two tables came from this script: the purge left both empty, and the
    // dev server's drain turns each request into a survey, so a partial clean leaves orphans that
    // look real. Clear them wholesale.
    await db.siteInspection.deleteMany({});
    await db.inspectionRequest.deleteMany({});
    await db.ticketSalesOrderLine.deleteMany({ where: { ticketId: { in: priorTicketIds } } });
    await db.ticket.deleteMany({ where: { id: { in: priorTicketIds } } });
    await db.activity.deleteMany({
      where: { entityType: "Inquiry", entityId: { in: priorInquiryIds } },
    });
    await db.inquiryItem.deleteMany({ where: { inquiryId: { in: priorInquiryIds } } });
    await db.inquiry.deleteMany({ where: { id: { in: priorInquiryIds } } });
    console.log(
      `Cleared ${priorTicketIds.length} prior sample ticket(s) and ${priorInquiryIds.length} inquiry(ies).`,
    );
  }

  console.log(`Building samples on ${account.code} ${account.name}, as ${ea.name}.\n`);

  // ---- a ticket, because a method statement and a survey both need something to belong to -------
  const ticket = await createStandaloneTicketService(actor, {
    accountId: account.id,
    type: "installation",
    title: "Sample — install and commission the replacement flowmeter",
    scopeOfWork:
      "Remove the existing DN100 ultrasonic flowmeter, install the replacement, terminate to the " +
      "existing panel, loop-check and commission with the plant engineer present.",
    justification: "Sample record created for the company to review the operations screens.",
  });
  created.push(`ticket ${ticket.number}`);
  console.log(`  ticket             ${ticket.number}`);

  // ---- a fresh inquiry, early in its life ---------------------------------------------------------
  //
  // A new one rather than reusing an existing inquiry, and the first run taught me why: both surviving
  // inquiries are at `po_received`, and `createInspectionRequestService` transitions the inquiry to
  // `inspection_required` — which §3's lifecycle refuses from that state, correctly. You do not raise
  // a pre-quote site survey on a deal whose purchase order has already arrived. The lifecycle was
  // right and the script was asking for something that makes no sense.
  //
  // An early-stage inquiry is the more useful sample anyway: it is the one that shows the
  // requirements gate, the acknowledgement clock and the inspection-request flow still live.
  const inquiry = await createInquiryService(actor, {
    subject: "Sample — supply and install 2 sets pressure transmitters, boiler feedwater line",
    description:
      "Customer asked for a like-for-like replacement of two failing transmitters, plus commissioning.",
    accountId: account.id,
    source: "email",
    receivedAt: new Date(),
    ownerId: ea.id,
    items: [
      {
        description: "Pressure transmitter, 0-16 bar, 4-20mA, with manifold",
        quantity: "2",
        unit: "set",
        serviceType: "supply",
      },
    ],
  });

  // §3's acknowledgement, which the lifecycle requires before a survey can be asked for. The
  // second thing the first run taught me: `new` may only move to `acknowledged`, so a script that
  // jumps straight to raising an inspection request is skipping the step the SLA exists to measure.
  await transitionInquiryService(actor, {
    inquiryId: inquiry.id,
    to: "acknowledged",
  });

  // …and on to evaluating, which is the state a survey can actually be requested from.
  await transitionInquiryService(actor, {
    inquiryId: inquiry.id,
    to: "evaluating",
  });

  created.push(`inquiry ${inquiry.number}`);
  console.log(`  inquiry            ${inquiry.number}`);

  // ---- a site inspection, raised the way module 01 raises one -------------------------------------
  //
  // Through the inspection *request* on that inquiry rather than standalone, so the inquiry's panel
  // also shows the survey's own photograph bucket — the mirroring asked for on 2026-08-17.
  const request = await createInspectionRequestService(actor, {
    inquiryId: inquiry.id,
    purpose: "Confirm the existing transmitter ranges, manifold type and access before quoting.",
    questions: "Are the existing manifolds reusable? Is the platform permit-controlled?",
    requiredOutputs: ["photos", "measurements", "tag_list"],
    assignedToId: dj?.id ?? ea.id,
  });

  // Scheduled **from the request**, which is how module 01 does it: `inspection.requested` is
  // emitted and module 04 subscribes. Calling `scheduleInspectionService` separately — as the
  // first version did — produces two surveys for one visit, because the drain still creates the
  // subscriber's one. The mirror in the inquiry panel keys on the request, so the duplicate was
  // also the one it displayed: empty.
  await scheduleFromInspectionRequest({
    inspectionRequestId: request.id,
    inquiryId: inquiry.id,
    assignedToId: dj?.id ?? ea.id,
  });

  // The subscriber returns nothing, so read back what it made.
  const inspection = await db.siteInspection.findUniqueOrThrow({
    where: { inspectionRequestId: request.id },
    select: { id: true, number: true },
  });

  await saveInspectionService(actor, {
    inspectionId: inspection.id,
    inspectedAt: new Date(),
    // The shape the company asked for: departments for AIES, names for anybody else.
    attendees: [
      { party: "sales" },
      { party: "technical", name: dj?.name ?? "DJ" },
      { party: "other", name: "Plant engineer, customer side" },
    ],
    findings:
      "Both transmitters are 0-16 bar as expected. Manifolds are seized and should be replaced " +
      "rather than reused. Access is over a permit-controlled platform. Panel has spare inputs.",
    tagNumbers: ["PIT-3301", "PIT-3302"],
    accessConstraints: "Permit-controlled platform, escort required.",
    hazards: ["Working at height", "Live steam line"],
    permitsRequired: ["Work at height", "Line break"],
    scopeChangeIdentified: true,
    scopeChangeNotes:
      "Manifolds are seized and were not in the enquiry — two replacements need adding before quoting.",
  });
  await completeInspectionService(actor, inspection.id);

  created.push(`site inspection ${inspection.number}`);
  console.log(
    `  site inspection    ${inspection.number}  (on ${inquiry.number}, from request ${request.id.slice(0, 8)})`,
  );

  // ---- a method statement, with the new tools card populated -------------------------------------
  const methodology = await createMethodologyService(actor, {
    ticketId: ticket.id,
    title: "Sample — flowmeter replacement method statement",
  });

  await saveMethodologyService(actor, {
    methodologyId: methodology.id,
    // Structured, not prose — §8's daily progress logs against these steps, so a narrative
    // blob would leave the crew with nothing to tick.
    sequenceOfWork: [
      {
        step: 1,
        description: "Permit to work and line break approval",
        durationHours: 2,
        crew: "Supervisor",
      },
      {
        step: 2,
        description: "Isolate and drain the line; confirm zero energy",
        durationHours: 3,
        crew: "2 technicians",
      },
      {
        step: 3,
        description: "Remove the existing meter, retain the spool piece",
        durationHours: 4,
        crew: "2 technicians, rigger",
      },
      {
        step: 4,
        description: "Fit the replacement, torque to specification",
        durationHours: 4,
        crew: "2 technicians",
      },
      {
        step: 5,
        description: "Terminate to the panel's spare 4-20mA input",
        durationHours: 2,
        crew: "1 technician",
      },
      {
        step: 6,
        description: "Loop-check and commission with the plant engineer witnessing",
        durationHours: 3,
        crew: "Supervisor, 1 technician",
      },
    ],
    manpowerPlan: [
      { role: "Supervisor", count: 1 },
      { role: "Technician", count: 2 },
      { role: "Rigger", count: 1, notes: "For the meter lift only" },
    ],
    // Ticked basics plus one specialised entry, so the card renders both halves.
    toolsRequired: [
      "Open wrench set",
      "Closed wrench set",
      "Torque wrench",
      "Multimeter",
      "Measuring tape",
      "Hydraulic torque tool, 1/2in drive",
    ],
    permitsRequired: ["Work at height", "Line break"],
    safetyPlan:
      "Line break permit before any joint is opened. Harness on the platform. Lock-off applied " +
      "and verified by the supervisor before removal.",
    durationDays: 2,
  });

  created.push(`method statement ${methodology.number}`);
  console.log(`  method statement   ${methodology.number}`);

  console.log(`\nAlready populated, nothing added: inquiries, quotations, procurement.`);
  console.log(`Remove these later with their numbers: ${created.join(", ")}.`);
  await db.$disconnect();
}

void main().catch(async (error) => {
  console.error(error);
  await db.$disconnect();
  process.exit(1);
});
