import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  acceptGoodsReceiptService,
  createGoodsReceiptService,
  getGoodsReceiptService,
  inspectGoodsReceiptService,
  outstandingForSupplierPoService,
} from "@/server/core/order/goods-receipt-service";
import { GOODS_RECEIPT_ENTITY_TYPE } from "@/server/core/order/goods-receipt-rules";
import {
  createSalesOrderFromPoService,
  verifyCustomerPoService,
} from "@/server/core/order/sales-order-service";
import {
  decideSupplierPoApprovalService,
  submitSupplierPoForApprovalService,
} from "@/server/core/order/supplier-po-approval";
import {
  createSupplierPosFromSalesOrderService,
  sendSupplierPoService,
} from "@/server/core/order/supplier-po-service";
import { SUPPLIER_PO_ENTITY_TYPE } from "@/server/core/order/supplier-po-rules";
import { createQuotationService } from "@/server/core/quotation/quotation-service";
import { saveQuotationLinesService } from "@/server/core/quotation/quotation-line-service";

/**
 * specs/03-order-procurement.md §6, against the real database.
 *
 * §11's case runs through this file end to end: "**Partial receipt** then partial delivery keeps
 * `qtyOrdered/Received/Delivered` consistent; **over-receipt** and over-delivery are rejected."
 * Delivery is module 04's ticket-gated lane and is not built, so what is asserted here is the
 * receipt half — including that the counters stay consistent across two partial deliveries.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `grn-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "Receiving Test" };

const accountIds: string[] = [];
const quotationIds: string[] = [];
const customerPoIds: string[] = [];
const salesOrderIds: string[] = [];
const supplierIds: string[] = [];
const supplierPoIds: string[] = [];
const receiptIds: string[] = [];
const fileIds: string[] = [];

const officer = {
  id: `${OWNER}-officer`,
  email: "vp@aies.local",
  name: "Officer",
  roleKeys: ["vice_president"],
  permissions: new Set([
    "supplier_po.create",
    "supplier_po.approve",
    "goods_receipt.create",
    "goods_receipt.inspect",
  ]) as ReadonlySet<string>,
};

/** A sent supplier PO for 5 meters and 2 valves — the state goods can arrive against. */
async function makeSentPo() {
  const account = await db.customerAccount.create({
    data: { code: `GRN-${randomUUID().slice(0, 12)}`, name: `GRN Co ${suffix}`, ownerId: OWNER },
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
        quantity: "5",
        unitCost: "1000",
        markupPct: "20",
      },
      {
        itemType: "product",
        description: "Control valve",
        quantity: "2",
        unitCost: "500",
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
  const salesOrder = await createSalesOrderFromPoService(actor, { customerPOId: customerPo.id });
  salesOrderIds.push(salesOrder.id);

  const supplier = await db.supplier.create({
    data: {
      code: `GRN-${randomUUID().slice(0, 10)}`,
      name: `Supplier ${randomUUID().slice(0, 6)}`,
      isApproved: true,
      approvedAt: new Date(),
    },
  });
  supplierIds.push(supplier.id);

  const [created] = await createSupplierPosFromSalesOrderService(actor, {
    salesOrderId: salesOrder.id,
    lines: salesOrder.lines.map((line) => ({ salesOrderLineId: line.id, supplierId: supplier.id })),
  });
  supplierPoIds.push(created!.id);

  await submitSupplierPoForApprovalService(actor, { supplierPOId: created!.id });
  await decideSupplierPoApprovalService(actor, officer, {
    supplierPOId: created!.id,
    decision: "approved",
  });
  await sendSupplierPoService(actor, officer, { supplierPOId: created!.id });

  const poLines = await db.supplierPOLine.findMany({
    where: { supplierPOId: created!.id },
    orderBy: { lineNo: "asc" },
  });

  return { salesOrder, supplierPO: created!, poLines, supplier };
}

/** A photograph, which §6 requires before an inspection can pass. */
async function attachPhoto(goodsReceiptId: string) {
  const file = await db.fileObject.create({
    data: {
      entityType: GOODS_RECEIPT_ENTITY_TYPE,
      entityId: goodsReceiptId,
      storageKey: `GoodsReceipt/${randomUUID()}-crate.jpg`,
      filename: "crate.jpg",
      mimeType: "image/jpeg",
      size: 1024,
      sha256: randomUUID().replace(/-/g, ""),
      uploaderId: OWNER,
    },
  });
  fileIds.push(file.id);
  return file;
}

/** Books everything in, inspects it cleanly, and accepts it. */
async function receiveEverything(po: { id: string }, poLines: { id: string; quantity: unknown }[]) {
  const receipt = await createGoodsReceiptService(actor, {
    supplierPOId: po.id,
    lines: poLines.map((line) => ({
      supplierPOLineId: line.id,
      qtyReceived: String(line.quantity),
    })),
  });
  receiptIds.push(receipt.id);
  await attachPhoto(receipt.id);
  await inspectGoodsReceiptService(actor, {
    goodsReceiptId: receipt.id,
    version: receipt.version,
    quantityChecked: true,
    damageChecked: true,
    documentationChecked: true,
  });
  return acceptGoodsReceiptService(actor, { goodsReceiptId: receipt.id });
}

afterAll(async () => {
  await db.goodsReceiptLine.deleteMany({ where: { goodsReceiptId: { in: receiptIds } } });
  await db.goodsReceipt.deleteMany({ where: { id: { in: receiptIds } } });
  await db.approvalAction.deleteMany({
    where: { request: { entityType: SUPPLIER_PO_ENTITY_TYPE, entityId: { in: supplierPoIds } } },
  });
  await db.approvalRequest.deleteMany({
    where: { entityType: SUPPLIER_PO_ENTITY_TYPE, entityId: { in: supplierPoIds } },
  });
  await db.notification.deleteMany({ where: { entityId: { in: supplierPoIds } } });
  await db.supplierPOLine.deleteMany({ where: { supplierPOId: { in: supplierPoIds } } });
  await db.supplierPO.deleteMany({ where: { id: { in: supplierPoIds } } });
  await db.salesOrderLine.deleteMany({ where: { salesOrderId: { in: salesOrderIds } } });
  await db.salesOrder.deleteMany({ where: { id: { in: salesOrderIds } } });
  await db.auditLog.deleteMany({
    where: {
      entityId: {
        in: [
          ...receiptIds,
          ...supplierPoIds,
          ...salesOrderIds,
          ...quotationIds,
          ...accountIds,
          ...customerPoIds,
        ],
      },
    },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: { in: [OWNER, officer.id] } } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: quotationIds } } });
  await db.customerPO.deleteMany({ where: { id: { in: customerPoIds } } });
  await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.supplier.deleteMany({ where: { id: { in: supplierIds } } });
});

describe("booking a delivery in", () => {
  it("records what arrived and leaves it as a draft", async () => {
    const { supplierPO, poLines } = await makeSentPo();

    const receipt = await createGoodsReceiptService(actor, {
      supplierPOId: supplierPO.id,
      packingListRef: "PL-8891",
      lines: [{ supplierPOLineId: poLines[0]!.id, qtyReceived: "3" }],
    });
    receiptIds.push(receipt.id);

    expect(receipt.number).toMatch(/^AIESGRN-\d{6}$/);
    expect(receipt.status).toBe("draft");
    // Nothing has moved yet — a draft is bookkeeping about a delivery, not fulfilment.
    const poLine = await db.supplierPOLine.findUniqueOrThrow({ where: { id: poLines[0]!.id } });
    expect(poLine.qtyReceived.toString()).toBe("0");
  }, 60_000);

  it("refuses more than the order still owes", async () => {
    const { supplierPO, poLines } = await makeSentPo();

    await expect(
      createGoodsReceiptService(actor, {
        supplierPOId: supplierPO.id,
        lines: [{ supplierPOLineId: poLines[0]!.id, qtyReceived: "9" }],
      }),
    ).rejects.toThrow(/at most 5 can still be booked in/);
  }, 60_000);

  it("refuses a receipt against a PO that was never sent", async () => {
    // Goods cannot arrive against an order nobody placed. If they have, the order was placed
    // outside the system and the fix is to record that.
    const { supplierPO, poLines } = await makeSentPo();
    await db.supplierPO.update({ where: { id: supplierPO.id }, data: { status: "draft" } });

    await expect(
      createGoodsReceiptService(actor, {
        supplierPOId: supplierPO.id,
        lines: [{ supplierPOLineId: poLines[0]!.id, qtyReceived: "1" }],
      }),
    ).rejects.toThrow(/has not been sent/);
  }, 60_000);

  /**
   * `endorsed` (docs/DECISIONS.md #175) fell through this guard on first pass — it matched neither
   * `draft` nor `pending_approval`, so a PO PD had merely endorsed (not yet approved, let alone
   * sent) could receive goods against it. Pinned so it cannot silently regress.
   */
  it("refuses a receipt against a PO that has only been endorsed, not approved or sent", async () => {
    const { supplierPO, poLines } = await makeSentPo();
    await db.supplierPO.update({ where: { id: supplierPO.id }, data: { status: "endorsed" } });

    await expect(
      createGoodsReceiptService(actor, {
        supplierPOId: supplierPO.id,
        lines: [{ supplierPOLineId: poLines[0]!.id, qtyReceived: "1" }],
      }),
    ).rejects.toThrow(/has not been sent/);
  }, 60_000);

  it("demands a reason for anything rejected", async () => {
    const { supplierPO, poLines } = await makeSentPo();

    await expect(
      createGoodsReceiptService(actor, {
        supplierPOId: supplierPO.id,
        lines: [
          {
            supplierPOLineId: poLines[0]!.id,
            qtyReceived: "5",
            qtyAccepted: "4",
            qtyRejected: "1",
          },
        ],
      }),
    ).rejects.toThrow(/Say why Flow meter DN150 was rejected/);
  }, 60_000);
});

describe("§6's incoming inspection is a gate, not a note", () => {
  it("will not accept a receipt that has not been inspected", async () => {
    const { supplierPO, poLines } = await makeSentPo();
    const receipt = await createGoodsReceiptService(actor, {
      supplierPOId: supplierPO.id,
      lines: [{ supplierPOLineId: poLines[0]!.id, qtyReceived: "5" }],
    });
    receiptIds.push(receipt.id);

    await expect(acceptGoodsReceiptService(actor, { goodsReceiptId: receipt.id })).rejects.toThrow(
      /clause\s+8\.4\.2/,
    );
  }, 60_000);

  it("counts photographs rather than believing a tick box", async () => {
    // A form asking "did you take photos?" is a form that always says yes.
    const { supplierPO, poLines } = await makeSentPo();
    const receipt = await createGoodsReceiptService(actor, {
      supplierPOId: supplierPO.id,
      lines: [{ supplierPOLineId: poLines[0]!.id, qtyReceived: "5" }],
    });
    receiptIds.push(receipt.id);

    const withoutPhotos = await inspectGoodsReceiptService(actor, {
      goodsReceiptId: receipt.id,
      version: receipt.version,
      quantityChecked: true,
      damageChecked: true,
      documentationChecked: true,
    });
    expect(withoutPhotos.gate.complete).toBe(false);
    expect(withoutPhotos.gate.missing).toEqual(["photographs"]);
    expect(withoutPhotos.status).toBe("draft");

    await attachPhoto(receipt.id);
    const withPhotos = await inspectGoodsReceiptService(actor, {
      goodsReceiptId: receipt.id,
      version: withoutPhotos.version,
      quantityChecked: true,
      damageChecked: true,
      documentationChecked: true,
    });
    expect(withPhotos.gate.complete).toBe(true);
    expect(withPhotos.status).toBe("inspected");
  }, 60_000);

  it("refuses a stale version", async () => {
    const { supplierPO, poLines } = await makeSentPo();
    const receipt = await createGoodsReceiptService(actor, {
      supplierPOId: supplierPO.id,
      lines: [{ supplierPOLineId: poLines[0]!.id, qtyReceived: "5" }],
    });
    receiptIds.push(receipt.id);
    await inspectGoodsReceiptService(actor, {
      goodsReceiptId: receipt.id,
      version: receipt.version,
      quantityChecked: true,
      damageChecked: false,
      documentationChecked: false,
    });

    await expect(
      inspectGoodsReceiptService(actor, {
        goodsReceiptId: receipt.id,
        version: receipt.version,
        quantityChecked: true,
        damageChecked: true,
        documentationChecked: true,
      }),
    ).rejects.toThrow(/changed by somebody else/);
  }, 60_000);
});

describe("acceptance is what moves the quantities", () => {
  it("advances the supplier PO and the customer's order together", async () => {
    const { salesOrder, supplierPO, poLines } = await makeSentPo();
    await receiveEverything(supplierPO, poLines);

    const poLine = await db.supplierPOLine.findUniqueOrThrow({ where: { id: poLines[0]!.id } });
    expect(poLine.qtyReceived.toString()).toBe("5");

    const soLine = await db.salesOrderLine.findFirstOrThrow({
      where: { salesOrderId: salesOrder.id, lineNo: 1 },
    });
    expect(soLine.qtyReceived.toString()).toBe("5");
    // qtyOrdered is untouched — what was promised does not change because goods arrived.
    expect(soLine.qtyOrdered.toString()).toBe("5");
    expect(soLine.qtyDelivered.toString()).toBe("0");

    const po = await db.supplierPO.findUniqueOrThrow({ where: { id: supplierPO.id } });
    expect(po.status).toBe("received");

    const order = await db.salesOrder.findUniqueOrThrow({ where: { id: salesOrder.id } });
    expect(order.procurementStatus).toBe("received");
    // §1's other workstreams are untouched.
    expect(order.financeStatus).toBe("not_required");
    expect(order.executionStatus).toBe("not_required");
  }, 60_000);

  it("keeps the counters consistent across two partial deliveries — §11's case", async () => {
    const { salesOrder, supplierPO, poLines } = await makeSentPo();

    const first = await createGoodsReceiptService(actor, {
      supplierPOId: supplierPO.id,
      lines: [{ supplierPOLineId: poLines[0]!.id, qtyReceived: "3" }],
    });
    receiptIds.push(first.id);
    await attachPhoto(first.id);
    await inspectGoodsReceiptService(actor, {
      goodsReceiptId: first.id,
      version: first.version,
      quantityChecked: true,
      damageChecked: true,
      documentationChecked: true,
    });
    await acceptGoodsReceiptService(actor, { goodsReceiptId: first.id });

    let po = await db.supplierPO.findUniqueOrThrow({ where: { id: supplierPO.id } });
    expect(po.status).toBe("partially_received");
    let order = await db.salesOrder.findUniqueOrThrow({ where: { id: salesOrder.id } });
    expect(order.procurementStatus).toBe("partially_received");

    // What is still owed, which is what the receiving screen shows.
    const outstanding = await outstandingForSupplierPoService(supplierPO.id);
    expect(outstanding[0]!.qtyOutstanding).toBe("2.000");

    const second = await createGoodsReceiptService(actor, {
      supplierPOId: supplierPO.id,
      lines: [
        { supplierPOLineId: poLines[0]!.id, qtyReceived: "2" },
        { supplierPOLineId: poLines[1]!.id, qtyReceived: "2" },
      ],
    });
    receiptIds.push(second.id);
    await attachPhoto(second.id);
    await inspectGoodsReceiptService(actor, {
      goodsReceiptId: second.id,
      version: second.version,
      quantityChecked: true,
      damageChecked: true,
      documentationChecked: true,
    });
    await acceptGoodsReceiptService(actor, { goodsReceiptId: second.id });

    const soLine = await db.salesOrderLine.findFirstOrThrow({
      where: { salesOrderId: salesOrder.id, lineNo: 1 },
    });
    // 3 + 2, not 2 and not 5 twice.
    expect(soLine.qtyReceived.toString()).toBe("5");

    po = await db.supplierPO.findUniqueOrThrow({ where: { id: supplierPO.id } });
    expect(po.status).toBe("received");
    order = await db.salesOrder.findUniqueOrThrow({ where: { id: salesOrder.id } });
    expect(order.procurementStatus).toBe("received");
  }, 90_000);

  it("counts only accepted goods towards fulfilment", async () => {
    // Rejected goods are going back. Counting them would make a customer's order look fulfilled by
    // a box on its way to the supplier.
    const { salesOrder, supplierPO, poLines } = await makeSentPo();
    const receipt = await createGoodsReceiptService(actor, {
      supplierPOId: supplierPO.id,
      lines: [
        {
          supplierPOLineId: poLines[0]!.id,
          qtyReceived: "5",
          qtyAccepted: "4",
          qtyRejected: "1",
          rejectionReason: "One unit arrived with a cracked housing.",
        },
      ],
    });
    receiptIds.push(receipt.id);
    await attachPhoto(receipt.id);
    await inspectGoodsReceiptService(actor, {
      goodsReceiptId: receipt.id,
      version: receipt.version,
      quantityChecked: true,
      damageChecked: true,
      documentationChecked: true,
    });
    const accepted = await acceptGoodsReceiptService(actor, { goodsReceiptId: receipt.id });

    expect(accepted.status).toBe("partially_rejected");
    const soLine = await db.salesOrderLine.findFirstOrThrow({
      where: { salesOrderId: salesOrder.id, lineNo: 1 },
    });
    expect(soLine.qtyReceived.toString()).toBe("4");
    // The PO is still owed one, so it is not closed.
    const po = await db.supplierPO.findUniqueOrThrow({ where: { id: supplierPO.id } });
    expect(po.status).toBe("partially_received");
  }, 60_000);

  it("emits goods.received with the serial numbers module 04 needs", async () => {
    const { supplierPO, poLines } = await makeSentPo();
    const receipt = await createGoodsReceiptService(actor, {
      supplierPOId: supplierPO.id,
      lines: [
        {
          supplierPOLineId: poLines[0]!.id,
          qtyReceived: "5",
          serialNumbers: ["SN-1", "SN-2", "SN-3", "SN-4", "SN-5"],
        },
      ],
    });
    receiptIds.push(receipt.id);
    await attachPhoto(receipt.id);
    await inspectGoodsReceiptService(actor, {
      goodsReceiptId: receipt.id,
      version: receipt.version,
      quantityChecked: true,
      damageChecked: true,
      documentationChecked: true,
    });
    await acceptGoodsReceiptService(actor, { goodsReceiptId: receipt.id });

    const event = await db.eventOutbox.findFirstOrThrow({
      where: { event: "goods.received", actorId: OWNER },
      orderBy: { createdAt: "desc" },
    });
    const payload = event.payload as { lines: { serialNumbers: string[] }[] };
    // §6: these "become the installed-equipment register in module 04", so the event carries which
    // units — not how many.
    expect(payload.lines[0]!.serialNumbers).toHaveLength(5);
  }, 60_000);

  it("emits goods.rejected only when something was rejected", async () => {
    const { supplierPO, poLines } = await makeSentPo();
    const accepted = await receiveEverything(supplierPO, poLines);

    // Matched on **this** receipt, not on a time window: another test in this file rejects a unit
    // legitimately, and a window-based assertion picked that up and read as a bug in the service.
    const clean = await db.eventOutbox.findFirst({
      where: {
        event: "goods.rejected",
        payload: { path: ["goodsReceiptId"], equals: accepted.id },
      },
    });
    // An NCR queue with an entry for every clean delivery is a queue nobody reads.
    expect(clean).toBeNull();

    // And the clean receipt did announce itself, so the absence above is selectivity, not silence.
    const received = await db.eventOutbox.findFirst({
      where: {
        event: "goods.received",
        payload: { path: ["goodsReceiptId"], equals: accepted.id },
      },
    });
    expect(received).not.toBeNull();
  }, 60_000);

  it("refuses to accept the same receipt twice", async () => {
    const { supplierPO, poLines } = await makeSentPo();
    const accepted = await receiveEverything(supplierPO, poLines);

    await expect(acceptGoodsReceiptService(actor, { goodsReceiptId: accepted.id })).rejects.toThrow(
      /cannot be accepted again/,
    );
  }, 60_000);

  it("refuses to re-inspect an accepted receipt", async () => {
    const { supplierPO, poLines } = await makeSentPo();
    const accepted = await receiveEverything(supplierPO, poLines);

    await expect(
      inspectGoodsReceiptService(actor, {
        goodsReceiptId: accepted.id,
        version: accepted.version,
        quantityChecked: true,
        damageChecked: true,
        documentationChecked: true,
      }),
    ).rejects.toThrow(/Book a correction in as its own receipt/);
  }, 60_000);
});

describe("reading a receipt back", () => {
  it("carries the ordered quantity alongside what arrived", async () => {
    const { supplierPO, poLines } = await makeSentPo();
    const receipt = await createGoodsReceiptService(actor, {
      supplierPOId: supplierPO.id,
      lines: [{ supplierPOLineId: poLines[0]!.id, qtyReceived: "3" }],
    });
    receiptIds.push(receipt.id);

    const detail = await getGoodsReceiptService(receipt.id);
    expect(detail.lines[0]!.description).toBe("Flow meter DN150");
    expect(detail.lines[0]!.qtyOrdered).toBe("5");
    expect(detail.lines[0]!.qtyReceived).toBe("3");
    expect(detail.gate.complete).toBe(false);
  }, 60_000);
});
