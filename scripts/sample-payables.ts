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
 * A job built to exercise §7's match and §6's expenses, one finding at a time.
 *
 * ## Why a second seed rather than reusing FIN5
 *
 * FIN5 was built to walk module 05 end to end and has been walked — its downpayment is recorded, its
 * advance released, one bill approved against its only purchase order. Re-walking payables on it
 * would mean fighting the state of a finished deal.
 *
 * More importantly, FIN5 had **one** supplier order, which can only ever demonstrate one outcome.
 * §7's whole design is that its four findings are kept apart because each is a different
 * conversation with a supplier — and a walkthrough that only ever sees `price` never tests that.
 *
 * ## The four orders, and what each is for
 *
 * Every one is positioned so a *single* bill produces a *single* clean finding:
 *
 * | Order | Ordered | Received | Bill it at | Produces |
 * |-------|---------|----------|------------|----------|
 * | A     | 428,000 | 428,000  | 428,000    | **matched** — nothing wrong |
 * | A     | 428,000 | 428,000  | 400,000    | **price** — less than ordered, a credit or short delivery |
 * | B     | 150,000 |  75,000  | 150,000    | **quantity** — billed for more than arrived |
 * | C     |  96,000 |       0  |  96,000    | **no_receipt** — paying for a promise |
 * | none  |       — |       —  | anything   | **no_order** — clause 8.4 bypassed after the fact |
 *
 * B is the expensive one and the reason the check exists: the price is right, the paperwork looks
 * right, and half the goods never came. Only the comparison catches it.
 *
 * ## What is left undone
 *
 * Every bill, and every expense. Those are the acts being walked. A released, unliquidated cash
 * advance is included so §6's new *money out, not yet accounted for* warning has something real to
 * report — that warning exists because the company found ₱24,000 missing from a margin on 2026-08-20.
 *
 *   $env:ALLOW_DEMO_DATA = '1'; npx tsx scripts/sample-payables.ts
 *   $env:ALLOW_DEMO_DATA = '1'; npx tsx scripts/sample-payables.ts --remove
 */

const MARK = "PAY6";
const DAY = 24 * 60 * 60 * 1000;
const SEEDED_RATE_FROM = new Date("2020-01-03T00:00:00.000Z");

async function actorAndMate() {
  const users = await db.user.findMany({
    where: { isActive: true, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
    take: 2,
  });
  if (users.length < 2) throw new Error("Need two active users. Run the seed first.");
  return { actor: { actorId: users[0]!.id, actorLabel: users[0]!.name }, mate: users[1]! };
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

  const tickets = await db.ticket.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true },
  });
  const ticketIds = tickets.map((t) => t.id);
  const orders = await db.salesOrder.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
  const projects = await db.project.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true },
  });
  const projectIds = projects.map((p) => p.id);
  const suppliers = await db.supplier.findMany({
    where: { name: { startsWith: MARK } },
    select: { id: true },
  });
  const supplierIds = suppliers.map((s) => s.id);
  const supplierPos = await db.supplierPO.findMany({
    where: { OR: [{ salesOrderId: { in: orderIds } }, { supplierId: { in: supplierIds } }] },
    select: { id: true },
  });
  const supplierPoIds = supplierPos.map((p) => p.id);
  const advances = await db.cashAdvance.findMany({
    where: { OR: [{ ticketId: { in: ticketIds } }, { projectId: { in: projectIds } }] },
    select: { id: true },
  });
  const inquiries = await db.inquiry.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true },
  });
  const inquiryIds = inquiries.map((i) => i.id);

  // Everything the job grew, children first — DECISIONS #126 and #132.
  await db.supplierInvoice.deleteMany({ where: { supplierPOId: { in: supplierPoIds } } });
  await db.supplierInvoice.deleteMany({ where: { supplierId: { in: supplierIds } } });
  await db.goodsReceiptLine.deleteMany({
    where: { goodsReceipt: { supplierPOId: { in: supplierPoIds } } },
  });
  await db.goodsReceipt.deleteMany({ where: { supplierPOId: { in: supplierPoIds } } });
  await db.supplierPOLine.deleteMany({ where: { supplierPOId: { in: supplierPoIds } } });
  await db.supplierPO.deleteMany({ where: { id: { in: supplierPoIds } } });

  await db.expense.deleteMany({
    where: { OR: [{ projectId: { in: projectIds } }, { salesOrderId: { in: orderIds } }] },
  });
  await db.timesheet.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.stockMovement.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.cashAdvanceLiquidation.deleteMany({
    where: { cashAdvanceId: { in: advances.map((a) => a.id) } },
  });
  await db.cashAdvance.deleteMany({ where: { id: { in: advances.map((a) => a.id) } } });

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
  await db.supplier.deleteMany({ where: { id: { in: supplierIds } } });
  await db.costRate.deleteMany({ where: { effectiveFrom: SEEDED_RATE_FROM } });

  console.log(`Removed ${accountIds.length} ${MARK} account(s) and everything the job grew.`);
}

async function main() {
  if (process.argv.includes("--remove")) return remove();

  if (process.env.ALLOW_DEMO_DATA !== "1") {
    throw new Error(
      "Refusing to write sample data. Set ALLOW_DEMO_DATA=1 if this is what you want.",
    );
  }

  const { actor, mate } = await actorAndMate();
  if (await db.customerAccount.findFirst({ where: { name: { startsWith: MARK } } })) {
    console.log(`${MARK} already exists. Run with --remove first to rebuild it.`);
    return;
  }

  const account = await db.customerAccount.create({
    data: {
      code: `P6-${Date.now().toString().slice(-8)}`,
      name: `${MARK} Iligan Steel Mill`,
      ownerId: actor.actorId,
      accountType: "customer",
      withholdsEWT: true,
      ewtRate: "2",
      creditLimit: "3000000.00",
    },
  });

  const site = await db.site.create({
    data: {
      accountId: account.id,
      name: "Rolling mill, hydraulic house",
      address: {
        line1: "Suarez Industrial Estate",
        barangay: "Barangay Suarez",
        city: "Iligan",
        province: "Lanao del Norte",
        postalCode: "9200",
      },
      accessNotes: "Hot work permit and mill induction before entry.",
    },
  });

  // ---- the deal, through the real services -------------------------------------------------------
  const inquiry = await createInquiryService(actor, {
    subject: `${MARK} — hydraulic power unit overhaul, rolling mill`,
    description:
      "Pump cavitating and the accumulator bladder has failed. Overhaul during the December shut.",
    accountId: account.id,
    siteId: site.id,
    ownerId: actor.actorId,
    source: "email",
    currency: "PHP",
    estimatedValue: "900000.00",
    items: [
      {
        description: "Axial piston pump, 250 cc/rev, with drive coupling",
        quantity: "1",
        unit: "pc",
        manufacturer: "Bosch Rexroth",
        modelNumber: "A4VSO250",
        serviceType: "supply",
      },
      {
        description: "Bladder accumulators, 50 L, complete with charging kit",
        quantity: "2",
        unit: "pc",
        manufacturer: "Hydac",
        modelNumber: "SB330-50",
        serviceType: "supply",
      },
      {
        description: "Removal, installation and flushing of the power unit",
        quantity: "1",
        unit: "lot",
        serviceType: "installation",
      },
    ],
  });

  await updateInquiryService(actor, {
    inquiryId: inquiry.id,
    requirements: {
      [answerKey("supply", "equipment_category")]: "Hydraulic",
      [answerKey("supply", "process_medium")]: "ISO VG 46 hydraulic oil",
      [answerKey("supply", "process_conditions")]: "280 bar working, 60 °C reservoir.",
      [answerKey("supply", "line_size")]: "DN50 pressure, DN80 return",
      [answerKey("supply", "connection_type")]: "SAE flanged, code 62",
      [answerKey("supply", "material_of_construction")]: "Cast iron body, steel accumulators",
      [answerKey("supply", "power_supply")]: "400 V 3-phase, 132 kW drive",
      [answerKey("installation", "scope_summary")]:
        "AIES removes the pump and accumulators, fits replacements, flushes to NAS 8.",
      [answerKey("installation", "existing_equipment_tags")]: "HPU-01, ACC-01 and ACC-02",
      [answerKey("installation", "quantity_points")]: 3,
      [answerKey("installation", "site_access")]: "December shut, 07:00–19:00, hot work permit.",
      [answerKey("installation", "shutdown_window")]: "Mill shut, 8–15 December.",
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
    { unitCost: "428000", markupPct: "22" },
    { unitCost: "75000", markupPct: "28" },
    { unitCost: "96000", markupPct: "35" },
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

  // The one direct write, declared — §6 of module 02 forbids reaching `sent` without an approval,
  // and a seed performing an approval nobody gave would put a lie in the audit log.
  const issued = await db.quotation.update({
    where: { id: quotation.id },
    data: { status: "sent", sentAt: new Date(), version: { increment: 1 } },
    select: { id: true, number: true, total: true, currency: true },
  });
  await db.auditLog.create({
    data: {
      actorId: actor.actorId,
      actorLabel: "Seed script (sample-payables.ts)",
      action: "update",
      entityType: "Quotation",
      entityId: issued.id,
      summary:
        `Set ${issued.number} to sent directly, as sample data for module 05's payables walk. ` +
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
      filename: "pay6-customer-po.pdf",
      mimeType: "application/pdf",
      size: 2048,
      sha256: `pay6-${Date.now()}`,
      storageKey: `CustomerPO/sample/${Date.now()}-pay6.pdf`,
      uploaderId: actor.actorId,
    },
  });

  const customerPo = await recordCustomerPoService(actor, {
    inquiryId: inquiry.id,
    quotationId: issued.id,
    poNumber: `PO-${MARK}-5512`,
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

  // ---- the job ------------------------------------------------------------------------------------
  const project = await db.project.create({
    data: {
      code: `${MARK}-PRJ-${Date.now().toString().slice(-6)}`,
      name: `${MARK} HPU overhaul, rolling mill`,
      accountId: account.id,
      siteId: site.id,
      salesOrderId: order.id,
      status: "in_progress",
      scopeOfWork: "Overhaul the hydraulic power unit and flush the system to NAS 8.",
      projectManagerId: actor.actorId,
      teamMemberIds: [actor.actorId, mate.id],
      contractValue: order.total,
      actualStart: new Date(Date.now() - 4 * DAY),
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
      title: "Overhaul the hydraulic power unit",
      scopeOfWork: "Pump and accumulators out, replacements in, flush and commission.",
      status: "in_progress",
      priority: "normal",
      raisedById: actor.actorId,
      assignedLeadId: actor.actorId,
      assignedUserIds: [actor.actorId, mate.id],
    },
  });

  /*
    A rate for both people this time.

    FIN5 deliberately left one worker unpriced so §6's caveat would fire. That lesson is learnt and
    the screen now exists; leaving it here would put noise in the middle of a walk about payables.
  */
  for (const id of [actor.actorId, mate.id]) {
    await db.costRate.upsert({
      where: { userId_effectiveFrom: { userId: id, effectiveFrom: SEEDED_RATE_FROM } },
      update: {},
      create: {
        userId: id,
        effectiveFrom: SEEDED_RATE_FROM,
        hourlyCost: "280.00",
        overtimeMultiplier: "1.25",
        notes: `Sample rate for ${MARK}'s walkthrough.`,
      },
    });
  }

  for (const day of [1, 2, 3]) {
    for (const id of [actor.actorId, mate.id]) {
      await db.timesheet.create({
        data: {
          ticketId: ticket.id,
          projectId: project.id,
          userId: id,
          date: new Date(Date.now() - day * DAY),
          regularHours: "8",
          status: "approved",
          approvedById: actor.actorId,
          approvedAt: new Date(),
          activity: "HPU strip and rebuild",
        },
      });
    }
  }

  // Released and not liquidated, so §6's new warning has something real to say.
  const advance = await db.cashAdvance.create({
    data: {
      number: `${MARK}-CA-${Date.now().toString().slice(-6)}`,
      ticketId: ticket.id,
      projectId: project.id,
      requestedById: actor.actorId,
      requestedFor: [actor.actorId, mate.id],
      purpose: "Crew accommodation and per diem, Iligan",
      breakdown: [
        { category: "accommodation", description: "2 crew × 6 nights", amount: 21600 },
        { category: "meals", description: "Per diem, 2 crew × 7 days", amount: 14000 },
      ],
      amountRequested: "35600.00",
      amountApproved: "35600.00",
      currency: "PHP",
      neededBy: new Date(Date.now() - 2 * DAY),
      status: "released",
      approvedById: actor.actorId,
      approvedAt: new Date(Date.now() - 3 * DAY),
      releasedById: actor.actorId,
      releasedAt: new Date(Date.now() - 2 * DAY),
      liquidationDueAt: new Date(Date.now() + 5 * DAY),
    },
  });

  // ---- the four supplier orders -------------------------------------------------------------------
  const supplier = await db.supplier.create({
    data: {
      code: `SUP-${MARK}${Date.now().toString().slice(-4)}`,
      name: `${MARK} Mindanao Fluid Power`,
      isApproved: true,
      approvedAt: new Date(Date.now() - 400 * DAY),
      approvalExpiry: new Date(Date.now() + 150 * DAY),
      currency: "PHP",
      paymentTerms: "Net 30",
      contactName: "Ernesto Lim",
      email: "sales@example.invalid",
    },
  });

  async function makePo(opts: {
    label: string;
    total: string;
    unitCost: string;
    quantity: string;
    qtyReceived: string;
    description: string;
    status: string;
    receipt: boolean;
  }) {
    const po = await db.supplierPO.create({
      data: {
        number: `${MARK}-SPO-${opts.label}-${Date.now().toString().slice(-5)}`,
        supplierId: supplier.id,
        salesOrderId: order.id,
        currency: "PHP",
        subtotal: opts.total,
        total: opts.total,
        status: opts.status,
        sentAt: new Date(Date.now() - 20 * DAY),
        acknowledgedAt: new Date(Date.now() - 19 * DAY),
        supplierRef: `MFP-${opts.label}`,
        createdById: actor.actorId,
        approvedById: actor.actorId,
        approvedAt: new Date(Date.now() - 21 * DAY),
        lines: {
          create: [
            {
              lineNo: 1,
              description: opts.description,
              quantity: opts.quantity,
              unit: "pc",
              unitCost: opts.unitCost,
              lineTotal: opts.total,
              qtyReceived: opts.qtyReceived,
            },
          ],
        },
      },
    });

    if (opts.receipt) {
      const line = await db.supplierPOLine.findFirstOrThrow({ where: { supplierPOId: po.id } });
      await db.goodsReceipt.create({
        data: {
          number: `${MARK}-GRN-${opts.label}-${Date.now().toString().slice(-5)}`,
          supplierPOId: po.id,
          receivedAt: new Date(Date.now() - 6 * DAY),
          receivedById: actor.actorId,
          status: "accepted",
          packingListRef: `MFP-PL-${opts.label}`,
          quantityChecked: true,
          damageChecked: true,
          documentationChecked: true,
          photosAttached: true,
          inspectedById: actor.actorId,
          inspectedAt: new Date(Date.now() - 6 * DAY),
          lines: {
            create: [
              {
                supplierPOLineId: line.id,
                qtyReceived: opts.qtyReceived,
                qtyAccepted: opts.qtyReceived,
                qtyRejected: "0",
              },
            ],
          },
        },
      });
    }

    return po;
  }

  // A — everything agrees. The control case: bill it at 428,000 and nothing is wrong.
  const poA = await makePo({
    label: "A",
    total: "428000.00",
    unitCost: "428000.00",
    quantity: "1",
    qtyReceived: "1",
    description: "Axial piston pump, 250 cc/rev, with drive coupling",
    status: "received",
    receipt: true,
  });

  // B — the expensive fault. Two ordered, one arrived. The price is right and half the goods are
  // missing, which is the case a person reading three correct documents separately never catches.
  const poB = await makePo({
    label: "B",
    total: "150000.00",
    unitCost: "75000.00",
    quantity: "2",
    qtyReceived: "1",
    description: "Bladder accumulator, 50 L, with charging kit",
    status: "partially_received",
    receipt: true,
  });

  // C — sent, acknowledged, nothing has arrived. Paying now is paying for a promise.
  const poC = await makePo({
    label: "C",
    total: "96000.00",
    unitCost: "96000.00",
    quantity: "1",
    qtyReceived: "0",
    description: "Flushing rig hire and filtration cartridges",
    status: "sent",
    receipt: false,
  });

  console.log("");
  console.log(`Built ${MARK}, for the payables and expenses re-walk.`);
  console.log("");
  console.log(`  Account        ${account.name}`);
  console.log(`  Quotation      ${issued.number} — PHP ${issued.total.toString()}`);
  console.log(`  Sales order    ${order.number}`);
  console.log(`  Project        ${project.code}`);
  console.log(`  Ticket         ${ticket.number}`);
  console.log(`  Supplier       ${supplier.name}`);
  console.log("");
  console.log("  Supplier orders, each positioned for one finding:");
  console.log(`    ${poA.number}  428,000 ordered · 428,000 received`);
  console.log(`      bill 428,000 -> matched     |  bill 400,000 -> price`);
  console.log(`    ${poB.number}  150,000 ordered ·  75,000 received`);
  console.log(`      bill 150,000 -> quantity`);
  console.log(`    ${poC.number}   96,000 ordered ·       0 received`);
  console.log(`      bill  96,000 -> no_receipt`);
  console.log(`    (no order at all)             ->  no_order`);
  console.log("");
  console.log(`  Cash advance   ${advance.number} — PHP 35,600.00 released, NOT liquidated`);
  console.log(
    `                 so §6's "money out, not yet accounted for" has something to report`,
  );
  console.log("");
  console.log("Left undone on purpose: every bill, and every expense.");
  console.log(
    `Remove with:  $env:ALLOW_DEMO_DATA = '1'; npx tsx scripts/sample-payables.ts --remove`,
  );
  console.log("");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
