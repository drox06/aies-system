import { db } from "../src/lib/db";
import {
  createInquiryService,
  transitionInquiryService,
  updateInquiryService,
} from "../src/server/core/crm/inquiry-service";
import { answerKey } from "../src/server/core/crm/requirements";
import { createDraftForInquiry } from "../src/server/core/quotation/quotation-service";
import { saveQuotationLinesService } from "../src/server/core/quotation/quotation-line-service";

/**
 * A deal carried to the doorstep of the walkthrough's part seven.
 *
 * ## Why this script exists
 *
 * The company walked the inquiry-to-delivery walkthrough and stopped at part six with a list of
 * defects. Those are fixed; the deal that was carrying them is not worth rebuilding by hand, and
 * parts one to six take the better part of an hour to retype. This builds a fresh one standing
 * exactly where part seven — "Record their PO" — begins: an inquiry acknowledged, evaluated, its
 * requirements answered, its quotation raised, priced and issued.
 *
 * ## What is real and what is not
 *
 * Everything up to the quotation goes through the **real services**. The inquiry is created,
 * transitioned and completed through `crm`; the quotation draft is produced by the same
 * `createDraftForInquiry` the `inquiry.quoting` event triggers in production, which means this seed
 * also exercises the line-item carry-over added on 2026-08-19 — the lines below are typed once, on
 * the inquiry, and appear on the quotation because the platform put them there.
 *
 * **One thing is written directly: the move to `sent`.** §6 is explicit — "Approval is required
 * before a quotation can move to `sent`. No exceptions in v1" — so reaching `sent` honestly would
 * mean submitting for approval and then approving as the VP. A seed that performs an approval leaves
 * the audit log asserting that somebody decided something they never saw. The status is therefore
 * set with an audit row saying plainly that a seed set it. Numbers, not judgements: same rule as
 * sample-walkthrough.ts.
 *
 * That means one thing for the reader: **do not treat this quotation's approval history as a
 * demonstration that approvals work.** Part five of the walkthrough is where that gets checked, on a
 * deal built by hand.
 *
 * ## Guarded, prefixed, removable
 *
 * `ALLOW_DEMO_DATA=1`, everything prefixed `PART7`, and `--remove` takes it out again. It writes to
 * whatever database it is pointed at, which is currently the live one.
 *
 *   ALLOW_DEMO_DATA=1 npx tsx scripts/sample-part-seven.ts
 *   ALLOW_DEMO_DATA=1 npx tsx scripts/sample-part-seven.ts --remove
 */

const MARK = "PART7";

async function requireActor() {
  const user = await db.user.findFirst({
    where: { isActive: true, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  if (!user) throw new Error("No active user to act as. Run the seed first.");
  return { actorId: user.id, actorLabel: user.name };
}

async function remove() {
  const accounts = await db.customerAccount.findMany({
    where: { name: { startsWith: MARK } },
    select: { id: true },
  });
  const accountIds = accounts.map((account) => account.id);
  if (accountIds.length === 0) {
    console.log("Nothing to remove.");
    return;
  }

  // Order matters: children before parents, because these are real foreign keys rather than a
  // cascade that happens to exist.
  const quotations = await db.quotation.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true },
  });
  const quotationIds = quotations.map((row) => row.id);

  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });

  const inquiries = await db.inquiry.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true },
  });
  const inquiryIds = inquiries.map((row) => row.id);
  await db.inquiryItem.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await db.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });

  await db.site.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });

  console.log(`Removed ${accountIds.length} ${MARK} account(s) and everything under them.`);
}

async function main() {
  if (process.argv.includes("--remove")) {
    await remove();
    return;
  }

  if (process.env.ALLOW_DEMO_DATA !== "1") {
    throw new Error(
      "Refusing to write sample data. Set ALLOW_DEMO_DATA=1 if this is really what you want.",
    );
  }

  const actor = await requireActor();

  const existing = await db.customerAccount.findFirst({ where: { name: { startsWith: MARK } } });
  if (existing) {
    console.log(`${MARK} account already exists. Run with --remove first to rebuild it.`);
    return;
  }

  const account = await db.customerAccount.create({
    data: {
      code: `P7-${Date.now().toString().slice(-8)}`,
      name: `${MARK} Calaca Power Station`,
      ownerId: actor.actorId,
      accountType: "customer",
      // Withholding on, because part 27's statement is where that gets checked and a customer who
      // does not withhold makes the interesting half of that screen disappear.
      withholdsEWT: true,
      ewtRate: "2",
      creditLimit: "1000000.00",
    },
  });

  const site = await db.site.create({
    data: {
      accountId: account.id,
      name: "Unit 2 boiler feed",
      address: {
        line1: "Calaca Power Complex",
        barangay: "Barangay San Rafael",
        city: "Calaca",
        province: "Batangas",
        postalCode: "4212",
      },
      accessNotes:
        "Main gate, then the plant road to Unit 2. Induction on arrival; permit-to-work from the " +
        "shift supervisor before anything is opened.",
    },
  });

  /*
    The inquiry, through the real service, with its line items.

    Three lines rather than one, deliberately. A single-line enquiry hides everything worth checking
    on the way through: whether the lines carry across to the quotation in order, whether a service
    line and a supply line get different item types, and whether the requirements checklist asks
    about the supply. Part seven onwards is more interesting with something to look at.
  */
  const inquiry = await createInquiryService(actor, {
    subject: `${MARK} — replace the boiler feed flow element and recommission`,
    description:
      "Existing orifice plate is worn and the flow reading has drifted about eight per cent low " +
      "against the tank gauge. They want it replaced and the loop recommissioned during the " +
      "October outage.",
    accountId: account.id,
    siteId: site.id,
    ownerId: actor.actorId,
    source: "email",
    currency: "PHP",
    estimatedValue: "420000.00",
    items: [
      {
        description: "DN150 electromagnetic flowmeter, PN16, flanged, with local indicator",
        quantity: "1",
        unit: "pc",
        manufacturer: "Endress+Hauser",
        modelNumber: "Promag W 400",
        serviceType: "supply",
        notes:
          "Must fit the existing spool. Confirm face-to-face against the drawing before order.",
      },
      {
        description: "Removal of the existing orifice plate and installation of the new meter",
        quantity: "1",
        unit: "lot",
        serviceType: "installation",
      },
      {
        description: "Loop check and recommissioning against the DCS, with the customer witnessing",
        quantity: "1",
        unit: "lot",
        serviceType: "commissioning",
      },
    ],
  });

  /*
    §4's requirements, answered rather than overridden.

    Overriding would be one line of code and would skip the thing part three of the walkthrough is
    for. These are the answers a real enquiry of this shape would carry, and they are keyed the way
    the form keys them — `{serviceType}.{field}` — so the checklist on screen reads as filled in
    rather than as a blob somebody injected.
  */
  await updateInquiryService(actor, {
    inquiryId: inquiry.id,
    requirements: {
      [answerKey("supply", "equipment_category")]: "Flow Instrument",
      [answerKey("supply", "process_medium")]: "Treated boiler feedwater, deaerated",
      [answerKey("supply", "process_conditions")]:
        "Operating 12 barg at 105 °C, design 16 barg at 150 °C. Flow 40–180 m³/h.",
      [answerKey("supply", "line_size")]: "DN150, schedule 40",
      [answerKey("supply", "connection_type")]: "Flanged, ASME B16.5 class 150, raised face",
      [answerKey("supply", "material_of_construction")]:
        "Carbon steel body, 316L liner and electrodes",
      [answerKey("supply", "power_supply")]: "24 VDC, 4–20 mA HART",
      [answerKey("installation", "scope_summary")]:
        "AIES removes the existing orifice plate and spool piece and fits the new meter in its " +
        "place. The customer isolates, drains and re-energises.",
      [answerKey("installation", "existing_equipment_tags")]: "FT-2041, and the spool at FE-2041",
      [answerKey("installation", "quantity_points")]: 1,
      [answerKey("installation", "site_access")]:
        "October outage, 06:00–18:00. Permit-to-work from the shift supervisor each morning.",
      [answerKey("installation", "shutdown_window")]: "Unit 2 outage, 12–19 October.",
      [answerKey("commissioning", "equipment_scope")]:
        "The new FT-2041 loop, from the transmitter through to the DCS point.",
      [answerKey("commissioning", "acceptance_criteria")]:
        "Reading within ±1% of the tank gauge over a two-hour run, witnessed and signed.",
      [answerKey("commissioning", "witnessed_by_client")]: true,
    },
  });

  // §3's path: new → acknowledged → evaluating → quoting. The last one is the gate that needs the
  // requirements above, and it is what raises the quotation.
  await transitionInquiryService(actor, { inquiryId: inquiry.id, to: "acknowledged" });
  await transitionInquiryService(actor, { inquiryId: inquiry.id, to: "evaluating" });
  await transitionInquiryService(actor, { inquiryId: inquiry.id, to: "quoting" });

  /*
    The draft, from the real handler.

    In production this is called by the `inquiry.quoting` subscriber through the outbox. Calling it
    directly rather than draining the queue keeps the script synchronous and hits exactly the same
    code — including the line carry-over, which is the point.
  */
  const draft = await createDraftForInquiry({ inquiryId: inquiry.id, actorId: actor.actorId });
  if (!draft) throw new Error("No quotation draft was produced. Has the inquiry an account?");

  const quotation = await db.quotation.findUniqueOrThrow({
    where: { id: draft.quotationId },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });

  /*
    Pricing, through the real line service.

    The carried-over lines arrive at zero — a transcription of what was asked for, not an estimate —
    so this is the estimator's pass over them. Costs and markups rather than typed prices, so the
    margin figures on screen are computed the way a real quotation's are.
  */
  const priced = [
    { unitCost: "148000", markupPct: "22" },
    { unitCost: "36000", markupPct: "35" },
    { unitCost: "22000", markupPct: "40" },
  ];

  await saveQuotationLinesService(actor, {
    quotationId: quotation.id,
    version: quotation.version,
    canSeeCost: true,
    lines: quotation.lines.map((line, index) => ({
      lineNo: line.lineNo,
      itemType: line.itemType,
      description: line.description,
      manufacturer: line.manufacturer,
      modelNumber: line.modelNumber,
      quantity: line.quantity.toString(),
      unit: line.unit,
      notes: line.notes,
      unitCost: priced[index]?.unitCost ?? "0",
      markupPct: priced[index]?.markupPct ?? "25",
      costCurrency: "PHP",
      costFxRate: "1",
    })),
  });

  /*
    And issued — the one dishonest step, made honest by saying so.

    See the note at the top of this file. The audit row is deliberately worded so that anybody
    reading this quotation's history knows no approver ever saw it.
  */
  const issued = await db.quotation.update({
    where: { id: quotation.id },
    data: { status: "sent", sentAt: new Date(), version: { increment: 1 } },
    select: { id: true, number: true, total: true },
  });

  await db.auditLog.create({
    data: {
      actorId: actor.actorId,
      actorLabel: "Seed script (sample-part-seven.ts)",
      action: "update",
      entityType: "Quotation",
      entityId: issued.id,
      summary:
        `Set ${issued.number} to sent directly, as sample data for the walkthrough's part seven. ` +
        `No approver saw this quotation — §6's approval was skipped by the seed, not granted.`,
    },
  });

  console.log("");
  console.log(`Built ${MARK}, standing at the walkthrough's part seven.`);
  console.log("");
  console.log(`  Account     ${account.name}`);
  console.log(`  Site        ${site.name}`);
  console.log(`  Inquiry     ${inquiry.number}  (quoting)`);
  console.log(`  Quotation   ${issued.number}  (sent, PHP ${issued.total.toString()})`);
  console.log("");
  console.log("Part seven starts on the quotation: record the customer's PO against it.");
  console.log(
    `Take it out again with:  ALLOW_DEMO_DATA=1 npx tsx scripts/sample-part-seven.ts --remove`,
  );
  console.log("");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
