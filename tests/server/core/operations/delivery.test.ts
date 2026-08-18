import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  bookCourierService,
  completeDeliveryService,
  deliverableLinesForTicketService,
  getDeliveryFlowService,
  issueDeliveryReceiptService,
  logDeliveryAttemptService,
  mobilizeDeliveryService,
  recordCourierPodService,
  setDeliveryModeService,
  startDeliveryFlowService,
  sweepUnsignedDeliveryReceipts,
} from "@/server/core/operations/delivery-service";
import { createStandaloneTicketService } from "@/server/core/operations/ticket-service";
import {
  createSalesOrderFromPoService,
  verifyCustomerPoService,
} from "@/server/core/order/sales-order-service";
import { createQuotationService } from "@/server/core/quotation/quotation-service";
import { saveQuotationLinesService } from "@/server/core/quotation/quotation-line-service";

/**
 * specs/04-operations-projects.md §13, against the real database.
 *
 * §20 names two cases and both are about evidence rather than movement:
 *
 *  1. "Three failed attempts then a successful signed delivery produces one DR, three logged
 *     attempts with causes, and exactly one `sales_order.goods_delivered`."
 *  2. "A courier POD alone does not complete the ticket."
 *
 * The second is the one with money attached. A proof of delivery from a courier says a box arrived
 * somewhere; a signed delivery receipt says this customer accepted these goods against this order,
 * and only the second survives an argument about an invoice.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `dlv-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "DJ (operations)" };

const accountIds: string[] = [];
const quotationIds: string[] = [];
const customerPoIds: string[] = [];
const salesOrderIds: string[] = [];
const ticketIds: string[] = [];
const flowIds: string[] = [];
const receiptIds: string[] = [];
const fileIds: string[] = [];

/** A sales order with two goods lines and one service line, so §7's exclusion has something to bite on. */
async function makeSalesOrder() {
  const account = await db.customerAccount.create({
    data: { code: `DLV-${randomUUID().slice(0, 12)}`, name: `DLV Co ${suffix}`, ownerId: OWNER },
  });
  accountIds.push(account.id);

  const quotation = await createQuotationService(actor, {
    accountId: account.id,
    title: `Supply ${randomUUID().slice(0, 6)}`,
  });
  quotationIds.push(quotation.id);

  await saveQuotationLinesService(actor, {
    quotationId: quotation.id,
    version: quotation.version,
    canSeeCost: true,
    lines: [
      {
        itemType: "product",
        description: "Flow meter DN150",
        quantity: "2",
        unitCost: "1000",
        markupPct: "20",
      },
      {
        itemType: "product",
        description: "Gaskets",
        quantity: "4",
        unitCost: "50",
        markupPct: "20",
      },
      {
        itemType: "service",
        description: "Commissioning",
        quantity: "1",
        unitCost: "5000",
        markupPct: "20",
      },
    ],
  });
  const saved = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });

  const file = await db.fileObject.create({
    data: {
      entityType: "CustomerPO",
      entityId: quotation.id,
      storageKey: `CustomerPO/${randomUUID()}-po.pdf`,
      filename: "po.pdf",
      mimeType: "application/pdf",
      size: 10,
      sha256: randomUUID().replace(/-/g, ""),
      uploaderId: OWNER,
    },
  });
  fileIds.push(file.id);

  const customerPo = await db.customerPO.create({
    data: {
      accountId: account.id,
      quotationId: quotation.id,
      poNumber: `PO-${randomUUID().slice(0, 8)}`,
      poDate: new Date(),
      amount: saved.total.toString(),
      currency: saved.currency,
      fileId: file.id,
      receivedById: OWNER,
      receivedAt: new Date(),
    },
  });
  customerPoIds.push(customerPo.id);

  await verifyCustomerPoService(actor, { customerPOId: customerPo.id });
  const order = await createSalesOrderFromPoService(actor, { customerPOId: customerPo.id });
  salesOrderIds.push(order.id);
  return { order, account };
}

/** A delivery ticket against that order, with the lane opened. */
async function makeDeliveryFlow(mode: "own_vehicle" | "courier" = "own_vehicle") {
  const { order, account } = await makeSalesOrder();

  const ticket = await createStandaloneTicketService(actor, {
    accountId: account.id,
    type: "delivery",
    title: `Deliver ${randomUUID().slice(0, 6)}`,
    scopeOfWork: "Take it to the customer and get it signed for.",
    justification: "Standalone for the test fixture.",
  });
  ticketIds.push(ticket.id);

  // `createStandaloneTicketService` does not take a sales order — a standalone ticket by definition
  // has none. This one does, which is why the link is made here rather than through it.
  await db.ticket.update({ where: { id: ticket.id }, data: { salesOrderId: order.id } });

  const flow = await startDeliveryFlowService(actor, { ticketId: ticket.id, mode });
  flowIds.push(flow.id);
  return { ticket, order, flow };
}

async function issueFor(ticketId: string, salesOrderId: string) {
  const deliverable = await deliverableLinesForTicketService(ticketId);
  const receipt = await issueDeliveryReceiptService(actor, {
    ticketId,
    salesOrderId,
    lines: deliverable.lines.map((line) => ({
      salesOrderLineId: line.salesOrderLineId,
      description: line.description,
      quantity: line.outstanding,
      unit: line.unit,
    })),
  });
  receiptIds.push(receipt.id);
  return receipt;
}

async function signatureFile(entityId: string) {
  const file = await db.fileObject.create({
    data: {
      entityType: "DeliveryReceipt",
      entityId,
      storageKey: `DeliveryReceipt/${randomUUID()}-signed.jpg`,
      filename: "signed.jpg",
      mimeType: "image/jpeg",
      size: 10,
      sha256: randomUUID().replace(/-/g, ""),
      uploaderId: OWNER,
    },
  });
  fileIds.push(file.id);
  return file.id;
}

const goodsDeliveredCount = (salesOrderId: string) =>
  db.eventOutbox.count({
    where: {
      event: "sales_order.goods_delivered",
      payload: { path: ["salesOrderId"], equals: salesOrderId },
    },
  });

afterAll(async () => {
  await db.deliveryReceiptLine.deleteMany({ where: { deliveryReceiptId: { in: receiptIds } } });
  await db.deliveryTicketFlow.deleteMany({ where: { id: { in: flowIds } } });
  await db.deliveryReceipt.deleteMany({ where: { id: { in: receiptIds } } });
  await db.notification.deleteMany({ where: { entityId: { in: flowIds } } });
  await db.auditLog.deleteMany({
    where: {
      entityId: {
        in: [
          ...flowIds,
          ...receiptIds,
          ...ticketIds,
          ...salesOrderIds,
          ...quotationIds,
          ...accountIds,
          ...customerPoIds,
        ],
      },
    },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: OWNER } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: quotationIds } } });
  await db.ticketSalesOrderLine.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.salesOrderLine.deleteMany({ where: { salesOrderId: { in: salesOrderIds } } });
  await db.salesOrder.deleteMany({ where: { id: { in: salesOrderIds } } });
  await db.customerPO.deleteMany({ where: { id: { in: customerPoIds } } });
  await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("§13.1's gate: no DR, no movement", () => {
  it("refuses to mobilise before the receipt exists", async () => {
    const { ticket } = await makeDeliveryFlow();
    await expect(mobilizeDeliveryService(actor, { ticketId: ticket.id })).rejects.toThrow(
      /nothing for the customer to sign/,
    );
  });

  it("refuses to book a courier before the receipt exists", async () => {
    const { ticket } = await makeDeliveryFlow("courier");
    await expect(
      bookCourierService(actor, {
        ticketId: ticket.id,
        courierName: "LBC",
        waybillNumber: `WB-${randomUUID().slice(0, 6)}`,
      }),
    ).rejects.toThrow(/nothing to send with the shipment/);
  });

  /** §13: "the mode can be changed until dispatch" — and not one moment after it. */
  it("locks the mode once the crew has left", async () => {
    const { ticket, order } = await makeDeliveryFlow();
    await issueFor(ticket.id, order.id);
    await mobilizeDeliveryService(actor, { ticketId: ticket.id, driverName: "Boy" });

    await expect(
      setDeliveryModeService(actor, { ticketId: ticket.id, mode: "courier" }),
    ).rejects.toThrow(/already left/);
  });

  it("refuses a second receipt on the same flow", async () => {
    const { ticket, order } = await makeDeliveryFlow();
    await issueFor(ticket.id, order.id);
    await expect(issueFor(ticket.id, order.id)).rejects.toThrow(/already has a receipt/);
  });
});

describe("what the receipt is allowed to say", () => {
  /**
   * §7 excludes execution lines from `goods_delivered`, and the DR has to agree — a receipt listing
   * "Commissioning" invites a signature against work that has not happened yet.
   */
  it("offers only the deliverable lines, not the labour", async () => {
    const { ticket } = await makeDeliveryFlow();
    const deliverable = await deliverableLinesForTicketService(ticket.id);

    const descriptions = deliverable.lines.map((line) => line.description);
    expect(descriptions).toContain("Flow meter DN150");
    expect(descriptions).toContain("Gaskets");
    expect(descriptions).not.toContain("Commissioning");
  });

  it("prefills the quantity outstanding rather than asking somebody to retype it", async () => {
    const { ticket } = await makeDeliveryFlow();
    const deliverable = await deliverableLinesForTicketService(ticket.id);
    const meter = deliverable.lines.find((line) => line.description === "Flow meter DN150")!;

    expect(meter.quantity).toBe("2");
    expect(meter.outstanding).toBe("2");
  });
});

describe("§20's first case: three failures, then a signature", () => {
  /**
   * The whole point is that the history survives. A field holding only the latest visit would pass
   * every assertion about the final state and answer none of §13.3's questions.
   */
  it("keeps one DR, three causes, and exactly one goods_delivered", async () => {
    const { ticket, order } = await makeDeliveryFlow();
    const receipt = await issueFor(ticket.id, order.id);
    await mobilizeDeliveryService(actor, { ticketId: ticket.id, driverName: "Boy" });

    const causes = ["contact_unavailable", "site_closed", "wrong_address"] as const;
    for (const cause of causes) {
      await logDeliveryAttemptService(actor, {
        ticketId: ticket.id,
        contactReached: false,
        itemDelivered: false,
        drSigned: false,
        failureReason: cause,
      });
    }

    const midway = await getDeliveryFlowService(ticket.id);
    expect(midway!.status).toBe("attempting");
    expect(midway!.attempts).toHaveLength(3);
    expect(midway!.attempts.map((entry) => entry.failureReason)).toEqual([...causes]);

    await logDeliveryAttemptService(actor, {
      ticketId: ticket.id,
      contactReached: true,
      itemDelivered: true,
      drSigned: true,
      recipientName: "Ms Reyes",
      recipientPosition: "Warehouse supervisor",
    });

    const result = await completeDeliveryService(actor, {
      ticketId: ticket.id,
      recipientName: "Ms Reyes",
      recipientPosition: "Warehouse supervisor",
      signatureFileId: await signatureFile(receipt.id),
    });

    expect(result.goodsDelivered).toBe(true);

    const after = await getDeliveryFlowService(ticket.id);
    expect(after!.status).toBe("completed");
    expect(after!.attempts).toHaveLength(4);

    // One receipt for the whole run, not one per visit.
    const receipts = await db.deliveryReceipt.count({ where: { ticketId: ticket.id } });
    expect(receipts).toBe(1);

    // The assertion that would have passed against a per-attempt emit, and is the reason §20 wrote
    // "exactly one" rather than "an event".
    expect(await goodsDeliveredCount(order.id)).toBe(1);
  });

  it("moves the order's delivered quantities, and only for goods lines", async () => {
    const { ticket, order } = await makeDeliveryFlow();
    const receipt = await issueFor(ticket.id, order.id);
    await mobilizeDeliveryService(actor, { ticketId: ticket.id, driverName: "Boy" });
    await logDeliveryAttemptService(actor, {
      ticketId: ticket.id,
      contactReached: true,
      itemDelivered: true,
      drSigned: true,
    });
    await completeDeliveryService(actor, {
      ticketId: ticket.id,
      recipientName: "Ms Reyes",
      signatureFileId: await signatureFile(receipt.id),
    });

    const lines = await db.salesOrderLine.findMany({ where: { salesOrderId: order.id } });
    const meter = lines.find((line) => line.description === "Flow meter DN150")!;
    const commissioning = lines.find((line) => line.description === "Commissioning")!;

    expect(meter.qtyDelivered.toString()).toBe("2");
    expect(commissioning.qtyDelivered.toString()).toBe("0");
  });
});

describe("§20's second case: a courier POD is not a signature", () => {
  it("leaves the ticket unsigned and unbillable on the POD alone", async () => {
    const { ticket, order } = await makeDeliveryFlow("courier");
    await issueFor(ticket.id, order.id);
    await bookCourierService(actor, {
      ticketId: ticket.id,
      courierName: "LBC",
      waybillNumber: `WB-${randomUUID().slice(0, 6)}`,
      freightCost: 250000,
    });

    const pod = await signatureFile(ticket.id);
    await recordCourierPodService(actor, {
      ticketId: ticket.id,
      courierPodFileId: pod,
      courierRecipientName: "Guard on duty",
    });

    const after = await getDeliveryFlowService(ticket.id);
    expect(after!.status).toBe("delivered_unsigned");
    expect(after!.completedAt).toBeNull();
    expect(after!.deliveredAt).not.toBeNull();

    // The claim that would let somebody invoice: it must not have been made.
    expect(await goodsDeliveredCount(order.id)).toBe(0);
  });

  it("completes once the signed receipt comes back", async () => {
    const { ticket, order } = await makeDeliveryFlow("courier");
    const receipt = await issueFor(ticket.id, order.id);
    await bookCourierService(actor, {
      ticketId: ticket.id,
      courierName: "LBC",
      waybillNumber: `WB-${randomUUID().slice(0, 6)}`,
    });
    await recordCourierPodService(actor, {
      ticketId: ticket.id,
      courierPodFileId: await signatureFile(ticket.id),
    });

    await completeDeliveryService(actor, {
      ticketId: ticket.id,
      recipientName: "Ms Reyes",
      signatureFileId: await signatureFile(receipt.id),
    });

    const after = await getDeliveryFlowService(ticket.id);
    expect(after!.status).toBe("completed");
    expect(await goodsDeliveredCount(order.id)).toBe(1);
  });
});

describe("the escalation that costs money to ignore", () => {
  /**
   * Backdated rather than waited for. The clock counts working days, so the fixture is put far
   * enough back that no weekend or holiday can make the assertion depend on the day it runs.
   */
  it("escalates an unsigned delivery once, and not again", async () => {
    const { ticket, order } = await makeDeliveryFlow();
    await issueFor(ticket.id, order.id);
    await mobilizeDeliveryService(actor, { ticketId: ticket.id, driverName: "Boy" });
    await logDeliveryAttemptService(actor, {
      ticketId: ticket.id,
      contactReached: true,
      itemDelivered: true,
      drSigned: false,
    });

    const flow = await getDeliveryFlowService(ticket.id);
    expect(flow!.status).toBe("delivered_unsigned");

    await db.deliveryTicketFlow.update({
      where: { id: flow!.id },
      data: { deliveredAt: new Date(Date.now() - 21 * 24 * 60 * 60 * 1000) },
    });

    const first = await sweepUnsignedDeliveryReceipts();
    expect(first.escalated).toBeGreaterThan(0);

    const escalated = await db.deliveryTicketFlow.findUniqueOrThrow({ where: { id: flow!.id } });
    expect(escalated.unsignedEscalatedAt).not.toBeNull();

    // A nightly job that renotified every night would be filtered into a rule within a week.
    //
    // Asserted on *this* flow rather than on the sweep's totals: the sweep is global, and another
    // test file leaving an unsigned delivery behind would make an absolute count fail in the full
    // suite while passing alone. docs/DECISIONS.md #64.
    await sweepUnsignedDeliveryReceipts();
    const twice = await db.deliveryTicketFlow.findUniqueOrThrow({ where: { id: flow!.id } });
    expect(twice.unsignedEscalatedAt?.getTime()).toBe(escalated.unsignedEscalatedAt?.getTime());
  });
});
