import { db } from "../src/lib/db";
import {
  createInquiryService,
  transitionInquiryService,
  updateInquiryService,
} from "../src/server/core/crm/inquiry-service";
import { answerKey } from "../src/server/core/crm/requirements";
import { createDraftForInquiry } from "../src/server/core/quotation/quotation-service";
import { saveQuotationLinesService } from "../src/server/core/quotation/quotation-line-service";
import { recordCustomerPoService } from "../src/server/core/order/customer-po-service";
import {
  createSalesOrderFromPoService,
  verifyCustomerPoService,
} from "../src/server/core/order/sales-order-service";
import { generateScheduleService } from "../src/server/core/finance/billing-service";
import {
  issueStatementService,
  raiseStatementService,
} from "../src/server/core/finance/invoice-service";

/**
 * The half of module 05 nobody has walked: §2's billing schedule, §3's documents, §5's collections.
 *
 * ## Why this half needs a different kind of seed
 *
 * Everything walked so far could be set up and then done in one sitting. Receivables cannot. An
 * ageing report with nothing in the 61–90 bucket demonstrates nothing, and there is no way to walk
 * a debt into being ninety days old — so **aged debt has to be seeded as context**, not left as an
 * act, and it is the one place these scripts write documents rather than positioning them.
 *
 * The distinction is kept sharp:
 *
 * - **Context** — three statements already issued and unpaid at 15, 45 and 80 days overdue, on a
 *   separate account. They exist so the ageing buckets and the collections worklist have something
 *   true to show. Issued through the real services, so the numbers came from the real sequence.
 * - **Acts, left undone** — the whole of the new order's billing. Its schedule is generated and its
 *   first milestone is billable; raising the statement, issuing it, recording the payment and
 *   clearing the cheque are all for a person. That path is what §3 is, and seeding it would show
 *   somebody the finished state of the thing being checked.
 *
 * ## Why "Progress billing"
 *
 * Three milestones — 20% on order, 50% on commissioning accepted, 30% on close-out — so the schedule
 * has one milestone billable *now* and two waiting on events that have not happened. A two-milestone
 * term would show a schedule but not the thing worth checking: that a milestone stays shut until the
 * work it bills for is actually done.
 *
 *   $env:ALLOW_DEMO_DATA = '1'; npx tsx scripts/sample-billing.ts
 *   $env:ALLOW_DEMO_DATA = '1'; npx tsx scripts/sample-billing.ts --remove
 */

const MARK = "BILL7";
const DAY = 24 * 60 * 60 * 1000;
/** Integer centavos — the platform's money rule everywhere §3 touches. */
const PESOS = (amount: number) => Math.round(amount * 100);

async function firstActor() {
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
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0) {
    console.log("Nothing to remove.");
    return;
  }

  const orders = await db.salesOrder.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
  const statements = await db.billingStatement.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true },
  });
  const statementIds = statements.map((s) => s.id);
  const payments = await db.payment.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true },
  });
  const paymentIds = payments.map((p) => p.id);
  const inquiries = await db.inquiry.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true },
  });
  const inquiryIds = inquiries.map((i) => i.id);
  const tickets = await db.ticket.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true },
  });
  const ticketIds = tickets.map((t) => t.id);
  const projects = await db.project.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true },
  });
  const projectIds = projects.map((p) => p.id);

  /*
    Children first — DECISIONS #126 and #132.

    §3's documents are the deep part here: a payment allocates across statements and issues a service
    invoice, so the allocation rows and the invoices have to go before the payments, and the payments
    before the statements they were allocated to.
  */
  await db.paymentAllocation.deleteMany({ where: { paymentId: { in: paymentIds } } });
  await db.serviceInvoice.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.payment.deleteMany({ where: { id: { in: paymentIds } } });
  await db.collectionActivity.deleteMany({ where: { statementId: { in: statementIds } } });
  await db.billingStatementLine.deleteMany({ where: { statementId: { in: statementIds } } });
  await db.billingStatement.deleteMany({ where: { id: { in: statementIds } } });

  await db.billingMilestone.deleteMany({ where: { salesOrderId: { in: orderIds } } });
  await db.billingSchedule.deleteMany({ where: { salesOrderId: { in: orderIds } } });

  await db.timesheet.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticketSalesOrderLine.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.project.deleteMany({ where: { id: { in: projectIds } } });
  await db.salesOrderLine.deleteMany({ where: { salesOrderId: { in: orderIds } } });
  await db.salesOrder.deleteMany({ where: { id: { in: orderIds } } });
  await db.customerPO.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.fileObject.deleteMany({
    where: { entityType: "CustomerPO", entityId: { in: inquiryIds } },
  });
  await db.quotationLine.deleteMany({ where: { quotation: { accountId: { in: accountIds } } } });
  await db.quotation.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.inquiryItem.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await db.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await db.site.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });

  console.log(`Removed ${accountIds.length} ${MARK} account(s) and everything they grew.`);
  console.log(
    "Service invoice numbers those statements consumed are not reclaimed — §3 keeps a BIR series " +
      "gapless in the sense that matters: a number issued stays issued.",
  );
}

async function main() {
  if (process.argv.includes("--remove")) return remove();

  if (process.env.ALLOW_DEMO_DATA !== "1") {
    throw new Error(
      "Refusing to write sample data. Set ALLOW_DEMO_DATA=1 if this is what you want.",
    );
  }

  const actor = await firstActor();
  if (await db.customerAccount.findFirst({ where: { name: { startsWith: MARK } } })) {
    console.log(`${MARK} already exists. Run with --remove first to rebuild it.`);
    return;
  }

  const term = await db.paymentTerm.findFirst({ where: { name: "Progress billing" } });
  if (!term) throw new Error("The 'Progress billing' term is missing. Run `npx prisma db seed`.");

  // ---- Part A: the order to be billed -------------------------------------------------------------
  const account = await db.customerAccount.create({
    data: {
      code: `B7-${Date.now().toString().slice(-8)}`,
      name: `${MARK} Davao Agri Processing`,
      ownerId: actor.actorId,
      accountType: "customer",
      // Withholding on: §3's service invoice shows an EWT line, and a customer who does not withhold
      // leaves that column a zero nobody can tell from a broken calculation.
      withholdsEWT: true,
      ewtRate: "2",
      creditLimit: "2500000.00",
    },
  });

  const site = await db.site.create({
    data: {
      accountId: account.id,
      name: "Copra mill, boiler house",
      address: {
        line1: "Bunawan Agro-Industrial Estate",
        barangay: "Barangay Bunawan",
        city: "Davao",
        province: "Davao del Sur",
        postalCode: "8000",
      },
    },
  });

  const inquiry = await createInquiryService(actor, {
    subject: `${MARK} — boiler feedwater treatment skid, supply and commission`,
    description: "New dosing and softening skid for the copra mill boiler, commissioned on site.",
    accountId: account.id,
    siteId: site.id,
    ownerId: actor.actorId,
    source: "email",
    currency: "PHP",
    estimatedValue: "1200000.00",
    items: [
      {
        description: "Water treatment skid, softener and dosing, 12 m³/h",
        quantity: "1",
        unit: "lot",
        manufacturer: "Grundfos",
        modelNumber: "DDA-AR",
        serviceType: "supply",
      },
      {
        description: "Installation, piping tie-in and commissioning",
        quantity: "1",
        unit: "lot",
        serviceType: "installation",
      },
    ],
  });

  await updateInquiryService(actor, {
    inquiryId: inquiry.id,
    requirements: {
      [answerKey("supply", "equipment_category")]: "Water Treatment",
      [answerKey("supply", "process_medium")]: "Raw well water to boiler feed",
      [answerKey("supply", "process_conditions")]: "12 m³/h at 4 barg, ambient.",
      [answerKey("supply", "line_size")]: "DN50 inlet, DN50 outlet",
      [answerKey("supply", "connection_type")]: "Flanged, ASME class 150",
      [answerKey("supply", "material_of_construction")]: "FRP vessels, PVC-U pipework",
      [answerKey("supply", "power_supply")]: "230 V single phase",
      [answerKey("installation", "scope_summary")]:
        "AIES sets the skid, ties into the existing header and commissions it.",
      [answerKey("installation", "existing_equipment_tags")]: "BFW-01",
      [answerKey("installation", "quantity_points")]: 1,
      [answerKey("installation", "site_access")]: "Day shift, mill running.",
    },
  });

  await transitionInquiryService(actor, { inquiryId: inquiry.id, to: "acknowledged" });
  await transitionInquiryService(actor, { inquiryId: inquiry.id, to: "evaluating" });
  await transitionInquiryService(actor, { inquiryId: inquiry.id, to: "quoting" });

  const draft = await createDraftForInquiry({ inquiryId: inquiry.id, actorId: actor.actorId });
  if (!draft) throw new Error("No quotation draft was produced.");

  const quotation = await db.quotation.findUniqueOrThrow({
    where: { id: draft.quotationId },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });

  const priced = [
    { unitCost: "620000", markupPct: "26" },
    { unitCost: "180000", markupPct: "35" },
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

  const issued = await db.quotation.update({
    where: { id: quotation.id },
    data: {
      status: "sent",
      sentAt: new Date(),
      paymentTermsId: term.id,
      paymentTermsText: term.name,
      version: { increment: 1 },
    },
    select: { id: true, number: true, total: true, currency: true },
  });
  await db.auditLog.create({
    data: {
      actorId: actor.actorId,
      actorLabel: "Seed script (sample-billing.ts)",
      action: "update",
      entityType: "Quotation",
      entityId: issued.id,
      summary:
        `Set ${issued.number} to sent directly, as sample data for module 05's billing walk. ` +
        `No approver saw it — §6's approval was skipped by the seed, not granted.`,
    },
  });
  await transitionInquiryService(
    { actorId: actor.actorId, actorLabel: "System (quotation sent)" },
    { inquiryId: inquiry.id, to: "quoted", bySystem: true },
  );

  const poFile = await db.fileObject.create({
    data: {
      entityType: "CustomerPO",
      entityId: inquiry.id,
      filename: "bill7-customer-po.pdf",
      mimeType: "application/pdf",
      size: 2048,
      sha256: `bill7-${Date.now()}`,
      storageKey: `CustomerPO/sample/${Date.now()}-bill7.pdf`,
      uploaderId: actor.actorId,
    },
  });

  const customerPo = await recordCustomerPoService(actor, {
    inquiryId: inquiry.id,
    quotationId: issued.id,
    poNumber: `PO-${MARK}-7731`,
    poDate: new Date(),
    amount: issued.total.toString(),
    currency: issued.currency,
    fileId: poFile.id,
  });
  await verifyCustomerPoService(actor, { customerPOId: customerPo.customerPoId });
  const created = await createSalesOrderFromPoService(actor, {
    customerPOId: customerPo.customerPoId,
  });
  const order = await db.salesOrder.findUniqueOrThrow({ where: { id: created.id } });

  /*
    The schedule, through the real service.

    §2's `on_order` milestone has no subscriber to fire it — the schedule did not exist when the
    order was created — so `generateScheduleService` marks it billable at generation. That is the
    one milestone the walk can bill immediately; the other two wait on events that have not happened,
    which is the point worth checking.
  */
  const schedule = await generateScheduleService(actor, { salesOrderId: order.id });

  // ---- Part B: aged debt, as context ---------------------------------------------------------------
  /*
    A second account, deliberately.

    Keeping the aged debt away from the order being walked means the collections screen is not
    showing the same customer twice in two different states, and it means removing one does not
    quietly change the other. It also matches reality: the customer you are billing today is rarely
    the one who owes you from March.
  */
  const debtor = await db.customerAccount.create({
    data: {
      code: `B7D-${Date.now().toString().slice(-7)}`,
      name: `${MARK} Zamboanga Canning`,
      ownerId: actor.actorId,
      accountType: "customer",
      withholdsEWT: false,
      creditLimit: "800000.00",
    },
  });

  const aged: { number: string; days: number; amount: number }[] = [];
  for (const spec of [
    { days: 15, amount: 84_500, what: "Pump overhaul, February call-out" },
    { days: 45, amount: 162_000, what: "Control valve supply, March delivery" },
    { days: 80, amount: 240_750, what: "Instrument calibration, quarterly contract" },
  ]) {
    const statement = await raiseStatementService(actor, {
      accountId: debtor.id,
      dueDate: new Date(Date.now() - spec.days * DAY),
      lines: [
        {
          description: spec.what,
          quantity: 1,
          unitPrice: PESOS(spec.amount),
          vatable: true,
        },
      ],
      poReference: `ZC-${1000 + spec.days}`,
      notes: "Seeded as aged context — a receivable cannot be walked into being eighty days old.",
    });
    // Issued, because an unissued draft is not a receivable and would not age.
    await issueStatementService(actor, { statementId: statement.id });
    aged.push({ number: statement.number, days: spec.days, amount: spec.amount });
  }

  const scheduleRow = await db.billingSchedule.findFirst({
    where: { salesOrderId: order.id },
    select: { id: true },
  });
  const milestones = await db.billingMilestone.findMany({
    where: { salesOrderId: order.id },
    orderBy: { sequence: "asc" },
    select: { label: true, amount: true, status: true, trigger: true },
  });

  console.log("");
  console.log(`Built ${MARK}, for the billing, invoicing and collections walk.`);
  console.log("");
  console.log("  PART A — the order to bill (§2 and §3), nothing billed yet");
  console.log(`    Account      ${account.name}`);
  console.log(`    Quotation    ${issued.number} — PHP ${issued.total.toString()}`);
  console.log(`    Sales order  ${order.number} — terms: ${term.name}`);
  console.log(
    `    Schedule     ${scheduleRow?.id ? "generated" : "MISSING"} · ${schedule.milestones} milestones`,
  );
  for (const m of milestones) {
    console.log(
      // Divided by 100. `BillingMilestone.amount` is integer centavos, like every money field §3
      // touches — printing it raw made a 229,420.80 milestone read as 22,942,080 and had me
      // reporting a hundredfold bug in code that was correct.
      `      ${m.label.padEnd(28)} PHP ${(m.amount / 100).toFixed(2).padStart(12)}  ` +
        `${m.status.padEnd(12)} (${m.trigger})`,
    );
  }
  console.log("");
  console.log("  PART B — aged debt (§5), issued and unpaid, as context");
  console.log(`    Account      ${debtor.name}`);
  for (const a of aged) {
    console.log(
      `      ${a.number.padEnd(16)} PHP ${a.amount.toFixed(2).padStart(12)}  ` +
        `${a.days} days overdue`,
    );
  }
  console.log("");
  console.log("Left undone on purpose: raising the statement, issuing it, recording the payment,");
  console.log("clearing or bouncing the cheque, and logging any collection activity.");
  console.log(
    `Remove with:  $env:ALLOW_DEMO_DATA = '1'; npx tsx scripts/sample-billing.ts --remove`,
  );
  console.log("");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
