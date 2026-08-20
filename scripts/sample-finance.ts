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

/**
 * A job carried to the doorstep of every screen module 05 added.
 *
 * ## What it deliberately leaves undone
 *
 * Every act the walkthrough exists to test is left for a person: the downpayment is unrecorded, the
 * cash advance is approved and unreleased, the supplier's bill is unrecorded, and nothing has been
 * exported. Seeding those would leave each screen showing the finished state of the thing being
 * checked — which is exactly how §11's warranty gate sat "built" and unwalked for weeks.
 *
 * What it *does* seed is everything those acts need in order to be possible, plus the project costs
 * that give §6's P&L something to be right or wrong about.
 *
 * ## The caveat it plants on purpose
 *
 * §6's P&L reports what it does not know. One of those gaps is seeded rather than avoided: KJ's
 * timesheet is approved but KJ has no `CostRate`, so a day of real labour lands in the *days with no
 * rate* caveat instead of in the margin. Only EA gets a rate.
 *
 * A screen whose warnings are always empty is a screen nobody learns to read. Walking one that fires
 * is the only way to find out whether the wording says something a person can act on.
 *
 * ## The one dishonest step, declared
 *
 * The quotation is set to `sent` with a direct write. §6 of module 02 forbids reaching `sent`
 * without an approval, so doing it honestly would mean a seed performing an approval nobody gave.
 * The audit row says plainly that a script did it. Numbers, not judgements — the same rule as
 * sample-part-seven.ts.
 *
 * ## Guarded, prefixed, removable
 *
 *   $env:ALLOW_DEMO_DATA = '1'; npx tsx scripts/sample-finance.ts
 *   $env:ALLOW_DEMO_DATA = '1'; npx tsx scripts/sample-finance.ts --remove
 */

const MARK = "FIN5";
const DAY = 24 * 60 * 60 * 1000;

/** A fixed date so `--remove` can find the rate this script created and leave any real one alone. */
const SEEDED_RATE_FROM = new Date("2020-01-02T00:00:00.000Z");

async function twoUsers() {
  const users = await db.user.findMany({
    where: { isActive: true, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
    take: 2,
  });
  if (users.length < 2) throw new Error("Need two active users. Run the seed first.");
  return {
    actor: { actorId: users[0]!.id, actorLabel: users[0]!.name },
    mate: users[1]!,
  };
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

  /*
    Everything the job *grew*, not everything the script *wrote* — DECISIONS #126.

    By the time this is wanted, somebody will have walked the whole of module 05: a downpayment
    recorded, an advance released, a supplier bill matched or disputed. Deleting only the rows below
    in the order they were created dies on a foreign key and leaves the account half-dismantled,
    which is what the first two versions of this pattern did.
  */
  const tickets = await db.ticket.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true },
  });
  const ticketIds = tickets.map((ticket) => ticket.id);

  const orders = await db.salesOrder.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true },
  });
  const orderIds = orders.map((order) => order.id);

  const projects = await db.project.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true },
  });
  const projectIds = projects.map((project) => project.id);

  const supplierPos = await db.supplierPO.findMany({
    where: { salesOrderId: { in: orderIds } },
    select: { id: true },
  });
  const supplierPoIds = supplierPos.map((po) => po.id);

  const cashAdvances = await db.cashAdvance.findMany({
    where: { OR: [{ ticketId: { in: ticketIds } }, { projectId: { in: projectIds } }] },
    select: { id: true },
  });
  const cashAdvanceIds = cashAdvances.map((advance) => advance.id);

  const inquiries = await db.inquiry.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true },
  });
  const inquiryIds = inquiries.map((inquiry) => inquiry.id);

  // ---- §7's bills, and the procurement they hang off -------------------------------------------
  await db.supplierInvoice.deleteMany({ where: { supplierPOId: { in: supplierPoIds } } });
  await db.goodsReceiptLine.deleteMany({
    where: { goodsReceipt: { supplierPOId: { in: supplierPoIds } } },
  });
  await db.goodsReceipt.deleteMany({ where: { supplierPOId: { in: supplierPoIds } } });
  await db.supplierPOLine.deleteMany({ where: { supplierPOId: { in: supplierPoIds } } });
  await db.supplierPO.deleteMany({ where: { id: { in: supplierPoIds } } });

  // ---- the costs on the job ---------------------------------------------------------------------
  await db.expense.deleteMany({
    where: { OR: [{ projectId: { in: projectIds } }, { salesOrderId: { in: orderIds } }] },
  });
  await db.timesheet.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.stockMovement.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.fieldExpense.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.cashAdvanceLiquidation.deleteMany({ where: { cashAdvanceId: { in: cashAdvanceIds } } });
  await db.cashAdvance.deleteMany({ where: { id: { in: cashAdvanceIds } } });

  // ---- module 04's records, in case the walk went further than module 05 -------------------------
  await db.qAApproval.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.testingCommissioning.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.serviceReport.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.methodology.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.siteInspection.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.dailyProgress.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.mobilization.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.deliveryReceiptLine.deleteMany({
    where: { receipt: { salesOrderId: { in: orderIds } } },
  });
  await db.deliveryTicketFlow.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.deliveryReceipt.deleteMany({ where: { salesOrderId: { in: orderIds } } });

  // ---- §3's billing, which a walked order grows -------------------------------------------------
  await db.billingMilestone.deleteMany({ where: { salesOrderId: { in: orderIds } } });
  await db.billingSchedule.deleteMany({ where: { salesOrderId: { in: orderIds } } });

  await db.ticketSalesOrderLine.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.projectCloseOut.deleteMany({ where: { projectId: { in: projectIds } } });
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

  await db.stockItem.deleteMany({ where: { sku: { startsWith: MARK } } });
  await db.supplier.deleteMany({ where: { name: { startsWith: MARK } } });
  // Matched on the marker date, so a real rate somebody entered since is not swept up with it.
  await db.costRate.deleteMany({ where: { effectiveFrom: SEEDED_RATE_FROM } });

  console.log(`Removed ${accountIds.length} ${MARK} account(s) and everything the job grew.`);
  console.log(
    "Any accounting export run during the walk is left in place — it is a record of something " +
      "that actually happened, and §8's whole point is that those do not quietly disappear.",
  );
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

  const { actor, mate } = await twoUsers();

  if (await db.customerAccount.findFirst({ where: { name: { startsWith: MARK } } })) {
    console.log(`${MARK} already exists. Run with --remove first to rebuild it.`);
    return;
  }

  /*
    A term with money up front, which is what makes §4's downpayment gate reachable at all.

    Seeded by prisma/seed-payment-terms.ts. Looked up rather than created, because the gate reads
    `PaymentTerm.downpaymentPct` and a term invented here would prove only that the seed can write
    the number it then reads back.
  */
  const term = await db.paymentTerm.findFirst({ where: { name: "30/70" } });
  if (!term) throw new Error("The 30/70 payment term is missing. Run `npx prisma db seed`.");

  const account = await db.customerAccount.create({
    data: {
      code: `F5-${Date.now().toString().slice(-8)}`,
      name: `${MARK} Bataan Fertilizer`,
      ownerId: actor.actorId,
      accountType: "customer",
      // Withholding on: §8's invoice export has a withholding column, and a customer who does not
      // withhold leaves it a column of zeroes nobody can tell from a broken mapping.
      withholdsEWT: true,
      ewtRate: "2",
      creditLimit: "2000000.00",
    },
  });

  const site = await db.site.create({
    data: {
      accountId: account.id,
      name: "Ammonia plant, Unit 1",
      address: {
        line1: "Bataan Industrial Park",
        barangay: "Barangay Alas-asin",
        city: "Mariveles",
        province: "Bataan",
        postalCode: "2105",
      },
      accessNotes: "Permit-to-work from the shift supervisor each morning. Ammonia area, full PPE.",
    },
  });

  // ---- the deal, through the real services -------------------------------------------------------
  const inquiry = await createInquiryService(actor, {
    subject: `${MARK} — replace two control valves on the ammonia line`,
    description:
      "Both valves passing. They want them replaced during the November turnaround and the loop " +
      "recommissioned before start-up.",
    accountId: account.id,
    siteId: site.id,
    ownerId: actor.actorId,
    source: "email",
    currency: "PHP",
    estimatedValue: "600000.00",
    items: [
      {
        description: "DN80 control valve, PN40, with positioner",
        quantity: "2",
        unit: "pc",
        manufacturer: "Samson",
        modelNumber: "3241",
        serviceType: "supply",
      },
      {
        description: "Removal of the existing valves and installation of the replacements",
        quantity: "1",
        unit: "lot",
        serviceType: "installation",
      },
    ],
  });

  await updateInquiryService(actor, {
    inquiryId: inquiry.id,
    requirements: {
      [answerKey("supply", "equipment_category")]: "Valve",
      [answerKey("supply", "process_medium")]: "Anhydrous ammonia",
      [answerKey("supply", "process_conditions")]: "Operating 18 barg at 40 °C, design 25 barg.",
      [answerKey("supply", "line_size")]: "DN80, schedule 80",
      [answerKey("supply", "connection_type")]: "Flanged, ASME B16.5 class 300, raised face",
      [answerKey("supply", "material_of_construction")]: "Carbon steel body, 316 trim",
      [answerKey("supply", "power_supply")]: "Instrument air 6 barg, 4–20 mA positioner",
      [answerKey("installation", "scope_summary")]:
        "AIES removes both valves and fits the replacements. The customer isolates and purges.",
      [answerKey("installation", "existing_equipment_tags")]: "CV-1101 and CV-1102",
      [answerKey("installation", "quantity_points")]: 2,
      [answerKey("installation", "site_access")]:
        "November turnaround, 06:00–18:00. Permit each morning from the shift supervisor.",
      [answerKey("installation", "shutdown_window")]: "Unit 1 turnaround, 9–16 November.",
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
    { unitCost: "210000", markupPct: "25" },
    { unitCost: "80000", markupPct: "35" },
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

  // The one direct write, and the payment term that arms §4's gate. See the note at the top.
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
      actorLabel: "Seed script (sample-finance.ts)",
      action: "update",
      entityType: "Quotation",
      entityId: issued.id,
      summary:
        `Set ${issued.number} to sent directly, as sample data for module 05's walkthrough. ` +
        `No approver saw this quotation — §6's approval was skipped by the seed, not granted.`,
    },
  });

  // The inquiry follows the quotation, because in production the subscriber would have moved it.
  await transitionInquiryService(
    { actorId: actor.actorId, actorLabel: "System (quotation sent)" },
    { inquiryId: inquiry.id, to: "quoted", bySystem: true },
  );

  // ---- their PO, verified, and the order it raises -----------------------------------------------
  const poFile = await db.fileObject.create({
    data: {
      entityType: "CustomerPO",
      // Against the inquiry, exactly as CustomerPoDialog does — the PO row does not exist yet.
      entityId: inquiry.id,
      filename: "fin5-customer-po.pdf",
      mimeType: "application/pdf",
      size: 2048,
      sha256: `fin5-${Date.now()}`,
      storageKey: `CustomerPO/sample/${Date.now()}-fin5-customer-po.pdf`,
      uploaderId: actor.actorId,
    },
  });

  const customerPo = await recordCustomerPoService(actor, {
    inquiryId: inquiry.id,
    quotationId: issued.id,
    poNumber: `PO-${MARK}-8841`,
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

  // ---- the job, and the costs that land on it ----------------------------------------------------
  const project = await db.project.create({
    data: {
      code: `${MARK}-PRJ-${Date.now().toString().slice(-6)}`,
      name: `${MARK} valve replacement, Unit 1`,
      accountId: account.id,
      siteId: site.id,
      salesOrderId: order.id,
      status: "in_progress",
      scopeOfWork: "Replace CV-1101 and CV-1102 and recommission the loop before start-up.",
      projectManagerId: actor.actorId,
      teamMemberIds: [actor.actorId, mate.id],
      contractValue: order.total,
      actualStart: new Date(Date.now() - 6 * DAY),
    },
  });

  const ticket = await db.ticket.create({
    data: {
      number: `${MARK}-TKT-${Date.now().toString().slice(-6)}`,
      accountId: account.id,
      siteId: site.id,
      projectId: project.id,
      salesOrderId: order.id,
      type: "installation",
      title: "Replace both control valves",
      scopeOfWork: "Remove CV-1101 and CV-1102, fit the replacements, recommission.",
      status: "in_progress",
      priority: "normal",
      raisedById: actor.actorId,
      assignedLeadId: actor.actorId,
      assignedUserIds: [actor.actorId, mate.id],
    },
  });

  /*
    A rate for one of the two people on the job, and deliberately not the other.

    §6's P&L counts a day it cannot price as **uncosted** rather than as free, and says how many in
    its caveats. That warning has never been seen fire. This makes it fire on one real day of
    labour, so the walk can check the wording says something a person can act on.
  */
  await db.costRate.create({
    data: {
      userId: actor.actorId,
      effectiveFrom: SEEDED_RATE_FROM,
      hourlyCost: "260.00",
      overtimeMultiplier: "1.25",
      notes: `Sample rate for ${MARK}'s walkthrough.`,
    },
  });

  for (const day of [1, 2, 3, 4]) {
    await db.timesheet.create({
      data: {
        ticketId: ticket.id,
        projectId: project.id,
        userId: actor.actorId,
        date: new Date(Date.now() - day * DAY),
        regularHours: "8",
        overtimeHours: day === 2 ? "3" : "0",
        travelHours: day === 1 ? "4" : "0",
        status: "approved",
        approvedById: actor.actorId,
        approvedAt: new Date(),
        activity: "Valve removal and refit",
      },
    });
  }

  await db.timesheet.create({
    data: {
      ticketId: ticket.id,
      projectId: project.id,
      userId: mate.id,
      date: new Date(Date.now() - 2 * DAY),
      regularHours: "8",
      status: "approved",
      approvedById: actor.actorId,
      approvedAt: new Date(),
      activity: "Second pair of hands on the lift",
    },
  });

  const stockItem = await db.stockItem.create({
    data: {
      sku: `${MARK}-GASKET-80`,
      name: "DN80 spiral wound gasket, 316/graphite",
      category: "consumable",
      unit: "pc",
      qtyOnHand: "32",
      lastPurchaseCost: "850.00",
    },
  });

  await db.stockMovement.create({
    data: {
      stockItemId: stockItem.id,
      type: "issue",
      quantity: "8",
      ticketId: ticket.id,
      byId: actor.actorId,
      reference: "Valve replacement, both flanges",
    },
  });

  await db.expense.create({
    data: {
      number: `AIESEXP-SAMPLE-${Date.now().toString().slice(-6)}`,
      category: "subcontract",
      vendorName: "Mariveles Rigging Services",
      expenseDate: new Date(Date.now() - 3 * DAY),
      amount: "46000.00",
      description: "Crane and two riggers for the valve lift",
      projectId: project.id,
      salesOrderId: order.id,
      status: "approved",
      submittedById: actor.actorId,
      approvedById: actor.actorId,
      approvedAt: new Date(),
    },
  });

  // ---- an advance approved, and the money not yet handed over ------------------------------------
  const advance = await db.cashAdvance.create({
    data: {
      number: `${MARK}-CA-${Date.now().toString().slice(-6)}`,
      ticketId: ticket.id,
      projectId: project.id,
      requestedById: actor.actorId,
      requestedFor: [actor.actorId, mate.id],
      purpose: "Crew per diem and fuel for the turnaround week",
      breakdown: [
        { category: "meals", description: "Per diem, 3 crew × 5 days", amount: 15000 },
        {
          category: "fuel",
          description: "Two vehicles, Manila to Mariveles and back",
          amount: 9000,
        },
      ],
      amountRequested: "24000.00",
      amountApproved: "24000.00",
      currency: "PHP",
      // Tomorrow, which §5b calls `urgent` — the case the queue exists for.
      neededBy: new Date(Date.now() + 1 * DAY),
      status: "approved",
      approvedById: actor.actorId,
      approvedAt: new Date(Date.now() - 1 * DAY),
      liquidationDueAt: new Date(Date.now() + 14 * DAY),
    },
  });

  // ---- a supplier order, received, with no bill against it yet ------------------------------------
  const supplier = await db.supplier.create({
    data: {
      code: `SUP-${MARK}${Date.now().toString().slice(-4)}`,
      name: `${MARK} Luzon Valve Supply`,
      isApproved: true,
      approvedAt: new Date(Date.now() - 300 * DAY),
      approvalExpiry: new Date(Date.now() + 200 * DAY),
      currency: "PHP",
      paymentTerms: "Net 30",
      contactName: "Rosa Villanueva",
      email: "sales@example.invalid",
    },
  });

  /*
    Ordered at 428,000 and received in full.

    The figure matters: §7's three-way match compares the bill against **both** the order total and
    the value actually received, and those two agree here. That lets the walk produce a clean match
    by billing 428,000, or a priced discrepancy by billing anything else, without needing a second
    seeded order to see either outcome.
  */
  const supplierPo = await db.supplierPO.create({
    data: {
      number: `${MARK}-SPO-${Date.now().toString().slice(-6)}`,
      supplierId: supplier.id,
      salesOrderId: order.id,
      currency: "PHP",
      subtotal: "420000.00",
      freight: "8000.00",
      total: "428000.00",
      status: "received",
      sentAt: new Date(Date.now() - 25 * DAY),
      acknowledgedAt: new Date(Date.now() - 24 * DAY),
      expectedArrivalDate: new Date(Date.now() - 8 * DAY),
      supplierRef: "LVS-2026-4417",
      createdById: actor.actorId,
      approvedById: actor.actorId,
      approvedAt: new Date(Date.now() - 26 * DAY),
      lines: {
        create: [
          {
            lineNo: 1,
            description: "DN80 control valve, PN40, with positioner",
            manufacturer: "Samson",
            modelNumber: "3241",
            quantity: "2",
            unit: "pc",
            unitCost: "210000.00",
            lineTotal: "420000.00",
            qtyReceived: "2",
          },
        ],
      },
    },
  });

  const line = await db.supplierPOLine.findFirstOrThrow({
    where: { supplierPOId: supplierPo.id },
  });

  await db.goodsReceipt.create({
    data: {
      number: `${MARK}-GRN-${Date.now().toString().slice(-6)}`,
      supplierPOId: supplierPo.id,
      receivedAt: new Date(Date.now() - 8 * DAY),
      receivedById: actor.actorId,
      status: "accepted",
      packingListRef: "LVS-PL-4417",
      quantityChecked: true,
      damageChecked: true,
      documentationChecked: true,
      photosAttached: true,
      inspectedById: actor.actorId,
      inspectedAt: new Date(Date.now() - 8 * DAY),
      lines: {
        create: [
          {
            supplierPOLineId: line.id,
            qtyReceived: "2",
            qtyAccepted: "2",
            qtyRejected: "0",
            serialNumbers: ["SM3241-88401", "SM3241-88402"],
          },
        ],
      },
    },
  });

  console.log("");
  console.log(`Built ${MARK}, standing before each of module 05's screens.`);
  console.log("");
  console.log(`  Account        ${account.name}`);
  console.log(`  Quotation      ${issued.number} — PHP ${issued.total.toString()}, 30/70 terms`);
  console.log(`  Sales order    ${order.number} — finance status: ${order.financeStatus}`);
  console.log(
    `                 downpayment owed: PHP ${Number(order.downpaymentAmount).toFixed(2)} ` +
      `(${Number(order.downpaymentPct).toFixed(0)}%)`,
  );
  console.log(`  Project        ${project.code}`);
  console.log(`  Ticket         ${ticket.number}`);
  console.log(`  Cash advance   ${advance.number} — approved, needed tomorrow, NOT released`);
  console.log(`  Supplier PO    ${supplierPo.number} — received in full, PHP 428,000.00, no bill`);
  console.log("");
  console.log(
    "Left undone on purpose: the downpayment, the release, the supplier bill, the export.",
  );
  console.log(`One day of ${mate.name}'s labour is unpriced, so §6's caveat has something to say.`);
  console.log("");
  console.log(
    `Remove with:  $env:ALLOW_DEMO_DATA = '1'; npx tsx scripts/sample-finance.ts --remove`,
  );
  console.log("");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
