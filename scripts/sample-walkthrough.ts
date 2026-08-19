import { db } from "../src/lib/db";
import { createStandaloneTicketService } from "../src/server/core/operations/ticket-service";
import {
  issueDeliveryReceiptService,
  startDeliveryFlowService,
} from "../src/server/core/operations/delivery-service";

/**
 * A deal carried to the point where Delivery mode has something on it.
 *
 * ## Why this script exists
 *
 * `/field` — "Delivery mode" in the navigation — has come up empty three times. Twice it was a
 * seeding fault of mine, and the third time it was correct: a delivery only becomes a *drop* once
 * its receipt is issued, and nothing had issued one. The company cannot check a screen that has
 * nothing on it, so this builds the chain far enough that it does.
 *
 * ## What it builds, and the one thing it fakes
 *
 * A customer, a site, a quotation, a customer PO, a sales order with one goods line, a delivery
 * ticket, a delivery flow, and **an issued delivery receipt**. Every one through the real services
 * except the quotation and the PO, which are written directly.
 *
 * That exception is deliberate and it is the interesting part. Going through the real services for
 * those two would mean submitting a quotation for approval, approving it as the VP, marking it
 * sent, and uploading a PO file — four acts by two different people, each writing an approval
 * record. A seed script performing approvals leaves the audit log saying decisions were made that
 * nobody made. **Numbers, not judgements**: the documents get real numbers from the real sequences,
 * and no approval is invented.
 *
 * ## Guarded, prefixed, removable
 *
 * `ALLOW_DEMO_DATA=1`, everything prefixed `WALKTHROUGH`, and `--remove` takes it all out. It writes
 * to whatever database it is pointed at, which is currently the live one.
 */

const MARK = "WALKTHROUGH";

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

  // Children before parents, or the foreign keys refuse and leave a half-removed mess — which is
  // exactly what happened the first time a sample script had a `--remove`.
  await db.deliveryReceiptLine.deleteMany({
    where: { receipt: { salesOrderId: { in: orderIds } } },
  });
  await db.deliveryTicketFlow.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.deliveryReceipt.deleteMany({ where: { salesOrderId: { in: orderIds } } });
  await db.billingMilestone.deleteMany({ where: { salesOrderId: { in: orderIds } } });
  await db.billingSchedule.deleteMany({ where: { salesOrderId: { in: orderIds } } });
  await db.ticketSalesOrderLine.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.salesOrderLine.deleteMany({ where: { salesOrderId: { in: orderIds } } });
  await db.salesOrder.deleteMany({ where: { id: { in: orderIds } } });
  await db.customerPO.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.quotationLine.deleteMany({ where: { quotation: { accountId: { in: accountIds } } } });
  await db.quotation.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.site.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });

  console.log(`Removed ${accountIds.length} ${MARK} account(s) and everything hanging off them.`);
}

/**
 * Stock, so §7's material request has something to issue.
 *
 * The company reported no movement in the store, correctly: there was nothing in it. These are
 * consumables a real job draws — gaskets, bolts, tape, cable — rather than saleable equipment, which
 * is what §7 means by stock.
 */
async function seedStock() {
  const items = [
    { sku: "GSK-DN100", name: "Gasket, DN100 spiral wound", unit: "pc", qty: "40", reorder: "10" },
    { sku: "BLT-M16", name: "Stud bolt M16 with nuts", unit: "set", qty: "120", reorder: "40" },
    { sku: "PTF-19", name: "PTFE thread tape, 19mm", unit: "roll", qty: "60", reorder: "15" },
    {
      sku: "CBL-2C-1.5",
      name: "Instrument cable, 2 core 1.5sqmm",
      unit: "m",
      qty: "500",
      reorder: "100",
    },
    { sku: "GLD-M20", name: "Cable gland M20, brass", unit: "pc", qty: "80", reorder: "20" },
    { sku: "CAL-FLUID", name: "Calibration fluid, 1L", unit: "btl", qty: "12", reorder: "4" },
  ];

  let created = 0;
  for (const item of items) {
    const existing = await db.stockItem.findUnique({ where: { sku: item.sku } });
    if (existing) continue;
    await db.stockItem.create({
      data: {
        sku: item.sku,
        name: item.name,
        category: "consumable",
        unit: item.unit,
        qtyOnHand: item.qty,
        reorderLevel: item.reorder,
        location: "Main store",
      },
    });
    created += 1;
  }
  console.log(`Stock: ${created} item(s) created, ${items.length - created} already there.`);
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
  await seedStock();

  const existing = await db.customerAccount.findFirst({ where: { name: { startsWith: MARK } } });
  if (existing) {
    console.log(`${MARK} account already exists. Run with --remove first to rebuild it.`);
    return;
  }

  const account = await db.customerAccount.create({
    data: {
      code: `WT-${Date.now().toString().slice(-8)}`,
      name: `${MARK} Batangas Refinery`,
      ownerId: actor.actorId,
      accountType: "customer",
      withholdsEWT: true,
      ewtRate: "2",
      creditLimit: "500000.00",
    },
  });

  const site = await db.site.create({
    data: {
      accountId: account.id,
      name: "Tank farm, Bay 3",
      address: {
        line1: "Refinery Road",
        barangay: "Barangay San Isidro",
        city: "Batangas City",
        province: "Batangas",
        postalCode: "4200",
      },
      accessNotes: "Gate 2. Safety induction at the guardhouse; hard hat and boots from the gate.",
    },
  });

  /**
   * The quotation and the PO are written directly. See the note at the top: a seed that submits and
   * approves would leave approval records for decisions nobody made.
   */
  const quotation = await db.quotation.create({
    data: {
      number: `${MARK}-LQ-${Date.now().toString().slice(-6)}`,
      accountId: account.id,
      siteId: site.id,
      title: `${MARK} — supply and install one flowmeter`,
      scopeOfWork: "Supply one DN100 electromagnetic flowmeter and install it in Bay 3.",
      validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      preparedById: actor.actorId,
      status: "sent",
      currency: "PHP",
      subtotal: "180000.00",
      total: "201600.00",
    },
  });

  const poFile = await db.fileObject.create({
    data: {
      entityType: "CustomerPO",
      entityId: account.id,
      filename: "walkthrough-po.pdf",
      mimeType: "application/pdf",
      size: 1024,
      sha256: `walkthrough-${Date.now()}`,
      storageKey: `walkthrough/${Date.now()}.pdf`,
      uploaderId: actor.actorId,
    },
  });

  const po = await db.customerPO.create({
    data: {
      accountId: account.id,
      quotationId: quotation.id,
      poNumber: `PO-${MARK}-001`,
      poDate: new Date(),
      amount: "201600.00",
      fileId: poFile.id,
      receivedById: actor.actorId,
      status: "verified",
    },
  });

  const order = await db.salesOrder.create({
    data: {
      number: `${MARK}-SO-${Date.now().toString().slice(-6)}`,
      accountId: account.id,
      siteId: site.id,
      quotationId: quotation.id,
      customerPOId: po.id,
      ownerId: actor.actorId,
      status: "open",
      currency: "PHP",
      subtotal: "180000.00",
      total: "201600.00",
      lines: {
        create: [
          {
            lineNo: 1,
            description: "DN100 electromagnetic flowmeter",
            quantity: "1",
            unit: "pc",
            unitPrice: "150000.00",
            lineTotal: "150000.00",
            requiresExecution: false,
            itemType: "product",
          },
          {
            lineNo: 2,
            description: "Installation and commissioning",
            quantity: "1",
            unit: "lot",
            unitPrice: "30000.00",
            lineTotal: "30000.00",
            requiresExecution: true,
            itemType: "service",
          },
        ],
      },
    },
    include: { lines: true },
  });

  // The two tickets a real proposal would produce, through the real service so each gets a number,
  // an audit row and its events.
  const delivery = await createStandaloneTicketService(actor, {
    accountId: account.id,
    siteId: site.id,
    type: "delivery",
    title: `${MARK} — deliver one flowmeter`,
    scopeOfWork: "Deliver the meter to Bay 3 and get the receipt signed.",
    justification: "Goods line on the walkthrough order.",
  });

  const installation = await createStandaloneTicketService(actor, {
    accountId: account.id,
    siteId: site.id,
    type: "installation",
    title: `${MARK} — install and commission the flowmeter`,
    scopeOfWork: "Fit the meter, wire it back to the DCS, calibrate and commission.",
    justification: "Service line on the walkthrough order.",
  });

  /**
   * Link both tickets to the order.
   *
   * `createStandaloneTicketService` deliberately does not take a sales order — a standalone ticket is
   * one raised *without* an order behind it, which is the whole point of the word. The real path is
   * §4's proposal, and that needs a person to confirm it, so the seed makes the link directly and
   * says so rather than pretending a review happened.
   *
   * The link is not cosmetic: §4's final billing gate finds a project's work by walking tickets from
   * the order, so an unlinked ticket means a gate that sees nothing and passes an order whose work
   * has not been done.
   */
  await db.ticket.updateMany({
    where: { id: { in: [delivery.id, installation.id] } },
    data: { salesOrderId: order.id },
  });

  await startDeliveryFlowService(actor, { ticketId: delivery.id, mode: "own_vehicle" });

  /**
   * The step that actually puts something on Delivery mode.
   *
   * §13 holds a flow at `dr_requested` until the receipt exists, and the screen lists drops from
   * `dr_issued` onward — which is correct, and is why the screen was empty before.
   */
  const goodsLine = order.lines.find((line) => !line.requiresExecution)!;
  const receipt = await issueDeliveryReceiptService(actor, {
    ticketId: delivery.id,
    salesOrderId: order.id,
    siteId: site.id,
    lines: [
      {
        salesOrderLineId: goodsLine.id,
        description: goodsLine.description,
        quantity: "1",
        unit: "pc",
      },
    ],
  });

  console.log("");
  console.log(`${MARK} deal built:`);
  console.log(`  Account       ${account.name}`);
  console.log(`  Quotation     ${quotation.number}`);
  console.log(`  Sales order   ${order.number}`);
  console.log(`  Delivery      ${delivery.number} — receipt issued`);
  console.log(`  Installation  ${installation.number}`);
  console.log("");
  console.log("Delivery mode should now list the delivery. The installation ticket is where");
  console.log("part six of the walkthrough starts — cash advance, method statement, mobilisation.");
  void receipt;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
