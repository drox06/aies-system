import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createSalesOrderFromPoService,
  verifyCustomerPoService,
} from "@/server/core/order/sales-order-service";
import {
  decideSupplierPoApprovalService,
  submitSupplierPoForApprovalService,
} from "@/server/core/order/supplier-po-approval";
import {
  acknowledgeSupplierPoService,
  cancelSupplierPoService,
  createSupplierPosFromSalesOrderService,
  getSupplierPoService,
  listSupplierPosService,
  sendSupplierPoService,
  supplierPoGatesService,
  updateSupplierPoService,
} from "@/server/core/order/supplier-po-service";
import { SUPPLIER_PO_ENTITY_TYPE } from "@/server/core/order/supplier-po-rules";
import { createQuotationService } from "@/server/core/quotation/quotation-service";
import { saveQuotationLinesService } from "@/server/core/quotation/quotation-line-service";

/**
 * specs/03-order-procurement.md §4 and §5, against the real database.
 *
 * §11 names the case this file exists for: "**Downpayment gate blocks supplier PO send; override is
 * permitted only with the permission and writes a reason to the audit log.**" Every clause of that
 * sentence is a separate assertion below, because each of them can be true while another is false —
 * a gate that blocks but accepts a blank reason, or one that writes a reason nobody can find.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `spo-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "PD Test" };

const accountIds: string[] = [];
const quotationIds: string[] = [];
const poIds: string[] = [];
const salesOrderIds: string[] = [];
const supplierIds: string[] = [];
const supplierPoIds: string[] = [];
const fileIds: string[] = [];

/** Somebody who may buy but may not override anything. */
const buyer = {
  id: OWNER,
  email: "pd@aies.local",
  name: "PD Test",
  roleKeys: ["admin_manager"],
  permissions: new Set(["supplier_po.create"]) as ReadonlySet<string>,
};

/** An officer: both overrides, per §10 and §4. */
const officer = {
  id: `${OWNER}-officer`,
  email: "vp@aies.local",
  name: "Officer Test",
  roleKeys: ["vice_president"],
  permissions: new Set([
    "supplier_po.create",
    "supplier_po.approve",
    "procurement.override_downpayment_gate",
    "supplier.approve",
  ]) as ReadonlySet<string>,
};

async function makeSupplier(options: { approved?: boolean; expiry?: Date | null } = {}) {
  const supplier = await db.supplier.create({
    data: {
      code: `SPO-${randomUUID().slice(0, 10)}`,
      name: `Supplier ${randomUUID().slice(0, 6)}`,
      isApproved: options.approved ?? true,
      approvedAt: options.approved === false ? null : new Date(),
      approvalExpiry: options.expiry ?? null,
      currency: "PHP",
    },
  });
  supplierIds.push(supplier.id);
  return supplier;
}

/** A verified customer PO turned into a sales order — the state §5 starts from. */
async function makeSalesOrder() {
  const account = await db.customerAccount.create({
    data: { code: `SPO-${randomUUID().slice(0, 12)}`, name: `SPO Co ${suffix}`, ownerId: OWNER },
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
        unitCost: "10000",
        markupPct: "20",
      },
      {
        itemType: "product",
        description: "Control valve",
        quantity: "3",
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
  poIds.push(customerPo.id);

  await verifyCustomerPoService(actor, { customerPOId: customerPo.id });
  const order = await createSalesOrderFromPoService(actor, { customerPOId: customerPo.id });
  salesOrderIds.push(order.id);
  return order;
}

/** A draft PO for every line of a fresh sales order. */
async function makeDraftPo(options: { approved?: boolean; expiry?: Date | null } = {}) {
  const order = await makeSalesOrder();
  const supplier = await makeSupplier(options);
  const [created] = await createSupplierPosFromSalesOrderService(actor, {
    salesOrderId: order.id,
    lines: order.lines.map((line) => ({ salesOrderLineId: line.id, supplierId: supplier.id })),
  });
  supplierPoIds.push(created!.id);
  return { order, supplier, po: created! };
}

/** Walks a draft through the VP's approval, which is the only route to `approved`. */
async function approve(supplierPOId: string) {
  await submitSupplierPoForApprovalService(actor, { supplierPOId });
  await decideSupplierPoApprovalService(actor, officer, { supplierPOId, decision: "approved" });
}

afterAll(async () => {
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
        in: [...supplierPoIds, ...salesOrderIds, ...quotationIds, ...accountIds, ...poIds],
      },
    },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: { in: [OWNER, officer.id] } } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: quotationIds } } });
  await db.customerPO.deleteMany({ where: { id: { in: poIds } } });
  await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.supplier.deleteMany({ where: { id: { in: supplierIds } } });
});

describe("§5: select lines, group by supplier, generate drafts", () => {
  it("raises one PO per supplier from a single selection", async () => {
    // The point of the grouping: one order sources the meter from Germany and the valves locally,
    // and repeating the exercise per vendor is how lines get forgotten.
    const order = await makeSalesOrder();
    const german = await makeSupplier();
    const local = await makeSupplier();

    const created = await createSupplierPosFromSalesOrderService(actor, {
      salesOrderId: order.id,
      lines: [
        { salesOrderLineId: order.lines[0]!.id, supplierId: german.id },
        { salesOrderLineId: order.lines[1]!.id, supplierId: local.id },
      ],
    });
    created.forEach((po) => supplierPoIds.push(po.id));

    expect(created).toHaveLength(2);
    const first = await getSupplierPoService(created[0]!.id);
    const second = await getSupplierPoService(created[1]!.id);
    expect(first.lines).toHaveLength(1);
    expect(second.lines).toHaveLength(1);
    expect(new Set([first.supplierId, second.supplierId])).toEqual(new Set([german.id, local.id]));
  }, 60_000);

  it("defaults the cost from the sales order line and totals it", async () => {
    const { po } = await makeDraftPo();
    const detail = await getSupplierPoService(po.id);

    // 2 × 10,000 + 3 × 5,000 = 35,000.
    expect(detail.subtotal).toBe("35000");
    expect(detail.total).toBe("35000");
    expect(detail.status).toBe("draft");
  }, 60_000);

  it("moves the sales order's procurement workstream, and only that one", async () => {
    // §1's whole instruction: the four status columns move independently.
    const { order } = await makeDraftPo();
    const after = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id } });

    expect(after.procurementStatus).toBe("pending");
    expect(after.status).toBe("open");
    expect(after.executionStatus).toBe(order.executionStatus);
    expect(after.financeStatus).toBe(order.financeStatus);
  }, 60_000);

  it("refuses a line that belongs to another sales order", async () => {
    const mine = await makeSalesOrder();
    const theirs = await makeSalesOrder();
    const supplier = await makeSupplier();

    await expect(
      createSupplierPosFromSalesOrderService(actor, {
        salesOrderId: mine.id,
        lines: [{ salesOrderLineId: theirs.lines[0]!.id, supplierId: supplier.id }],
      }),
    ).rejects.toThrow(/does not belong to/);
  }, 60_000);

  it("emits supplier_po.created", async () => {
    const { po } = await makeDraftPo();
    const event = await db.eventOutbox.findFirstOrThrow({
      where: { event: "supplier_po.created", actorId: OWNER },
      orderBy: { createdAt: "desc" },
    });
    const payload = event.payload as { supplierPOId: string };
    expect(payload.supplierPOId).toBe(po.id);
  }, 60_000);
});

describe("editing a draft", () => {
  it("recomputes the total when charges are added, and allocates them", async () => {
    const { po } = await makeDraftPo();
    const before = await getSupplierPoService(po.id);

    await updateSupplierPoService(actor, {
      supplierPOId: po.id,
      version: before.version,
      freight: "1000",
      duties: "500",
    });

    const after = await getSupplierPoService(po.id);
    expect(after.total).toBe("36500");
    // §5's landed cost, on the lines, summing back to the charges exactly.
    const allocated = after.lines.reduce((sum, line) => sum + Number(line.allocatedCharges), 0);
    expect(Math.round(allocated * 100)).toBe(150_000);
  }, 60_000);

  it("refuses a stale version", async () => {
    const { po } = await makeDraftPo();
    const detail = await getSupplierPoService(po.id);
    await updateSupplierPoService(actor, {
      supplierPOId: po.id,
      version: detail.version,
      freight: "10",
    });

    await expect(
      updateSupplierPoService(actor, {
        supplierPOId: po.id,
        version: detail.version,
        freight: "20",
      }),
    ).rejects.toThrow(/changed by somebody else/);
  }, 60_000);

  it("refuses to edit once approved, because that changes what was approved", async () => {
    const { po } = await makeDraftPo();
    await approve(po.id);
    const detail = await getSupplierPoService(po.id);

    await expect(
      updateSupplierPoService(actor, {
        supplierPOId: po.id,
        version: detail.version,
        freight: "9999",
      }),
    ).rejects.toThrow(/lines and charges are fixed/);
  }, 60_000);
});

describe("§5's approval", () => {
  it("routes to the VP through the generic engine and reaches approved", async () => {
    const { po } = await makeDraftPo();

    const submitted = await submitSupplierPoForApprovalService(actor, { supplierPOId: po.id });
    expect(submitted.status).toBe("pending_approval");

    const decided = await decideSupplierPoApprovalService(actor, officer, {
      supplierPOId: po.id,
      decision: "approved",
    });
    expect(decided.supplierPoStatus).toBe("approved");

    const stored = await db.supplierPO.findUniqueOrThrow({ where: { id: po.id } });
    expect(stored.status).toBe("approved");
    expect(stored.approvedById).toBe(officer.id);
  }, 60_000);

  it("sends a rejection back to draft with the comment as the instruction", async () => {
    const { po } = await makeDraftPo();
    await submitSupplierPoForApprovalService(actor, { supplierPOId: po.id });

    await expect(
      decideSupplierPoApprovalService(actor, officer, {
        supplierPOId: po.id,
        decision: "rejected",
      }),
    ).rejects.toThrow(/Say what needs to change/);

    const decided = await decideSupplierPoApprovalService(actor, officer, {
      supplierPOId: po.id,
      decision: "rejected",
      comment: "Get a second quote — this is 20% over the last one.",
    });
    expect(decided.supplierPoStatus).toBe("draft");
  }, 60_000);

  it("refuses a decision from somebody not eligible", async () => {
    const { po } = await makeDraftPo();
    await submitSupplierPoForApprovalService(actor, { supplierPOId: po.id });

    await expect(
      decideSupplierPoApprovalService(actor, buyer, { supplierPOId: po.id, decision: "approved" }),
    ).rejects.toThrow(/not eligible/);
  }, 60_000);
});

describe("§4's downpayment gate", () => {
  /** Puts a sales order in the state module 05 will create: money agreed and not yet received. */
  async function awaitingDownpayment(salesOrderId: string) {
    await db.salesOrder.update({
      where: { id: salesOrderId },
      data: {
        financeStatus: "awaiting_downpayment",
        downpaymentPct: "0.5000",
        downpaymentAmount: "21000.00",
      },
    });
  }

  it("blocks the send", async () => {
    const { order, po } = await makeDraftPo();
    await awaitingDownpayment(order.id);
    await approve(po.id);

    const gates = await supplierPoGatesService(po.id);
    expect(gates.downpayment.blocks).toBe(true);
    expect(gates.clear).toBe(false);

    await expect(sendSupplierPoService(actor, officer, { supplierPOId: po.id })).rejects.toThrow(
      /Waiting on a 50% downpayment/,
    );

    const stored = await db.supplierPO.findUniqueOrThrow({ where: { id: po.id } });
    expect(stored.status).toBe("approved");
  }, 60_000);

  it("refuses an override from somebody without the permission", async () => {
    // §11: "override is permitted **only with the permission**".
    const { order, po } = await makeDraftPo();
    await awaitingDownpayment(order.id);
    await approve(po.id);

    await expect(
      sendSupplierPoService(actor, buyer, {
        supplierPOId: po.id,
        downpaymentOverrideReason: "The customer confirmed the transfer is in flight.",
      }),
    ).rejects.toThrow(/Only the President or Vice President may override/);
  }, 60_000);

  it("refuses an override with no reason, and one that says nothing", async () => {
    const { order, po } = await makeDraftPo();
    await awaitingDownpayment(order.id);
    await approve(po.id);

    await expect(sendSupplierPoService(actor, officer, { supplierPOId: po.id })).rejects.toThrow(
      /Waiting on a 50% downpayment/,
    );
    await expect(
      sendSupplierPoService(actor, officer, {
        supplierPOId: po.id,
        downpaymentOverrideReason: "urgent",
      }),
    ).rejects.toThrow(/Give a real reason/);
  }, 60_000);

  it("lets an officer through with a reason, and writes it to the record and the log", async () => {
    // §11: "…and writes a reason to the audit log." Both places, because they answer different
    // questions — the log is the evidence, the column is what the next person to open the PO reads.
    const { order, po } = await makeDraftPo();
    await awaitingDownpayment(order.id);
    await approve(po.id);

    const reason = "EA authorised: the customer's cheque cleared this morning, proof on file.";
    const sent = await sendSupplierPoService(actor, officer, {
      supplierPOId: po.id,
      downpaymentOverrideReason: reason,
    });

    expect(sent.status).toBe("sent");
    expect(sent.downpaymentOverrideReason).toBe(reason);
    expect(sent.downpaymentOverrideById).toBe(officer.id);

    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityType: SUPPLIER_PO_ENTITY_TYPE, entityId: po.id, action: "supplier_po_sent" },
    });
    expect(audit.summary).toContain(reason);
    expect(audit.summary).toMatch(/Downpayment gate overridden/);
  }, 60_000);

  it("does not block once finance records the payment", async () => {
    const { order, po } = await makeDraftPo();
    await awaitingDownpayment(order.id);
    await db.salesOrder.update({
      where: { id: order.id },
      data: { financeStatus: "downpayment_received" },
    });
    await approve(po.id);

    const sent = await sendSupplierPoService(actor, buyer, { supplierPOId: po.id });
    expect(sent.status).toBe("sent");
    // Nothing was overridden, so nothing is recorded as overridden.
    expect(sent.downpaymentOverrideReason).toBeNull();
  }, 60_000);
});

describe("clause 8.4's gate, which is where session 1's approval finally bites", () => {
  it("blocks a send to an unapproved supplier", async () => {
    const { po } = await makeDraftPo({ approved: false });
    await approve(po.id);

    await expect(sendSupplierPoService(actor, officer, { supplierPOId: po.id })).rejects.toThrow(
      /not an approved supplier/,
    );
  }, 60_000);

  it("blocks a send when the approval has lapsed", async () => {
    const { po } = await makeDraftPo({ approved: true, expiry: new Date("2020-01-01") });
    await approve(po.id);

    await expect(sendSupplierPoService(actor, officer, { supplierPOId: po.id })).rejects.toThrow(
      /approval expired on 2020-01-01/,
    );
  }, 60_000);

  it("lets an officer override it, separately from the downpayment", async () => {
    const { po } = await makeDraftPo({ approved: false });
    await approve(po.id);

    const sent = await sendSupplierPoService(actor, officer, {
      supplierPOId: po.id,
      unapprovedSupplierOverrideReason:
        "Single source for this obsolete part; approval paperwork is in progress.",
    });

    expect(sent.status).toBe("sent");
    expect(sent.unapprovedSupplierOverrideBy).toBe(officer.id);
    // The other gate was never in play, so it records nothing — the two questions stay separate.
    expect(sent.downpaymentOverrideReason).toBeNull();
  }, 60_000);

  it("refuses the override from a buyer", async () => {
    const { po } = await makeDraftPo({ approved: false });
    await approve(po.id);

    await expect(
      sendSupplierPoService(actor, buyer, {
        supplierPOId: po.id,
        unapprovedSupplierOverrideReason: "They are the only ones who stock it in the country.",
      }),
    ).rejects.toThrow(/Only the President or Vice President may override/);
  }, 60_000);
});

describe("sending, acknowledging, cancelling", () => {
  it("will not send a PO that was never approved", async () => {
    const { po } = await makeDraftPo();
    await expect(sendSupplierPoService(actor, officer, { supplierPOId: po.id })).rejects.toThrow(
      /Only an approved PO can be sent/,
    );
  }, 60_000);

  it("moves the sales order to ordered on send", async () => {
    const { order, po } = await makeDraftPo();
    await approve(po.id);
    await sendSupplierPoService(actor, buyer, { supplierPOId: po.id });

    const after = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.procurementStatus).toBe("ordered");
  }, 60_000);

  it("records the supplier's own reference on acknowledgement", async () => {
    const { po } = await makeDraftPo();
    await approve(po.id);
    await sendSupplierPoService(actor, buyer, { supplierPOId: po.id });

    const acked = await acknowledgeSupplierPoService(actor, {
      supplierPOId: po.id,
      supplierRef: "AB-99231",
      expectedArrivalDate: new Date("2026-10-01"),
    });

    expect(acked.status).toBe("acknowledged");
    // Every follow-up call quotes their number, not ours.
    expect(acked.supplierRef).toBe("AB-99231");
  }, 60_000);

  it("refuses to cancel a PO that goods have arrived against", async () => {
    const { po } = await makeDraftPo();
    await db.supplierPO.update({ where: { id: po.id }, data: { status: "partially_received" } });

    await expect(
      cancelSupplierPoService(actor, { supplierPOId: po.id, reason: "No longer needed" }),
    ).rejects.toThrow(/raise a return instead/);
  }, 60_000);
});

describe("§5's expediting view", () => {
  it("lists only open commitments, with days late and whose delivery they support", async () => {
    const { order, po } = await makeDraftPo();
    await approve(po.id);
    await sendSupplierPoService(actor, buyer, { supplierPOId: po.id });
    const detail = await getSupplierPoService(po.id);
    await db.supplierPO.update({
      where: { id: po.id },
      data: { expectedArrivalDate: new Date(Date.now() - 3 * 86_400_000) },
    });
    expect(detail.status).toBe("sent");

    const open = await listSupplierPosService({ openOnly: true, salesOrderId: order.id });
    expect(open).toHaveLength(1);
    expect(open[0]!.daysLate).toBe(3);
    // §5: "and the customer commitment they support".
    expect(open[0]!.salesOrder?.number).toBe(order.number);
    expect(open[0]!.salesOrder?.account.name).toContain("SPO Co");
  }, 60_000);

  it("leaves a draft out of the expediting view", async () => {
    // A draft is somebody working out what to buy. Nothing has been promised, so nothing is late.
    const { order } = await makeDraftPo();
    const open = await listSupplierPosService({ openOnly: true, salesOrderId: order.id });
    expect(open).toHaveLength(0);
  }, 60_000);
});
