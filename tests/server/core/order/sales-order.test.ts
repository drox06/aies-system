import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  checkCustomerPoService,
  createSalesOrderFromPoService,
  recordDownpaymentService,
  getSalesOrderService,
  lineRequiresExecution,
  verifyCustomerPoService,
} from "@/server/core/order/sales-order-service";
import { createQuotationService } from "@/server/core/quotation/quotation-service";
import { saveQuotationLinesService } from "@/server/core/quotation/quotation-line-service";

/**
 * specs/03-order-procurement.md §3 — the pivot point.
 *
 * §1: this is "where the deal stops being a sales artifact and becomes an obligation". Two claims
 * are worth pinning against the real database rather than a mock:
 *
 *   1. The verification gate is real — a sales order cannot be raised from an unverified PO, and a
 *      PO with differences cannot be verified without somebody writing down why.
 *   2. The copy is a copy. Revising the quotation afterwards must not move the obligation.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `so-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "SO Test" };

const accountIds: string[] = [];
const quotationIds: string[] = [];
const poIds: string[] = [];
const salesOrderIds: string[] = [];
const fileIds: string[] = [];

const officer = {
  id: OWNER,
  permissions: new Set([
    "sales_order.view",
    "sales_order.view_all",
    "finance.view_cost",
  ]) as ReadonlySet<string>,
};

/** Two lines: one product, one service — so `requiresExecution` has both cases to decide. */
const LINES = [
  {
    itemType: "product",
    description: "Flow meter DN150",
    quantity: "5",
    unitCost: "10000",
    markupPct: "20",
  },
  {
    itemType: "service",
    description: "Commissioning",
    quantity: "1",
    unitCost: "20000",
    markupPct: "25",
  },
];

async function makeQuotationWithPo(options: { poAmount?: string; lines?: typeof LINES } = {}) {
  const account = await db.customerAccount.create({
    data: { code: `SO-${randomUUID().slice(0, 12)}`, name: `SO Co ${suffix}`, ownerId: OWNER },
  });
  accountIds.push(account.id);

  const quotation = await createQuotationService(actor, {
    accountId: account.id,
    title: `Supply and commission ${randomUUID().slice(0, 6)}`,
  });
  quotationIds.push(quotation.id);

  await saveQuotationLinesService(actor, {
    quotationId: quotation.id,
    version: quotation.version,
    canSeeCost: true,
    lines: options.lines ?? LINES,
  });
  // Re-read rather than trust the return: saving lines recomputes the header totals, and the PO
  // below has to match the number the quotation actually ended up with.
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

  const po = await db.customerPO.create({
    data: {
      accountId: account.id,
      quotationId: quotation.id,
      poNumber: `PO-${randomUUID().slice(0, 8)}`,
      poDate: new Date(),
      // Matches the quotation unless the caller wants a mismatch.
      amount: options.poAmount ?? saved.total.toString(),
      currency: saved.currency,
      fileId: file.id,
      receivedById: OWNER,
      receivedAt: new Date(),
    },
  });
  poIds.push(po.id);

  return { account, quotation: saved, po };
}

afterAll(async () => {
  await db.salesOrderLine.deleteMany({ where: { salesOrderId: { in: salesOrderIds } } });
  await db.salesOrder.deleteMany({ where: { id: { in: salesOrderIds } } });
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...quotationIds, ...accountIds, ...poIds, ...salesOrderIds] } },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: OWNER } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: quotationIds } } });
  await db.customerPO.deleteMany({ where: { id: { in: poIds } } });
  await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("§3's check, run against real records", () => {
  it("passes a PO that matches its quotation", async () => {
    const { po, quotation } = await makeQuotationWithPo();

    const check = await checkCustomerPoService({ customerPOId: po.id });

    expect(check.quotationNumber).toBe(quotation.number);
    expect(check.discrepancies).toEqual([]);
    expect(check.ok).toBe(true);
  }, 60_000);

  it("reports an amount difference without blocking", async () => {
    const { po } = await makeQuotationWithPo({ poAmount: "1000" });

    const check = await checkCustomerPoService({ customerPOId: po.id });

    expect(check.discrepancies.map((d) => d.kind)).toEqual(["amount"]);
    expect(check.ok).toBe(true);
  }, 60_000);

  it("says plainly that there is nothing to check when no quotation is linked", async () => {
    // §2 allows this: "a repeat order on agreed prices". An empty findings list would read as a
    // pass, which is the opposite of the truth.
    const account = await db.customerAccount.create({
      data: { code: `SO-${randomUUID().slice(0, 12)}`, name: `SO Bare ${suffix}`, ownerId: OWNER },
    });
    accountIds.push(account.id);
    const file = await db.fileObject.create({
      data: {
        entityType: "CustomerPO",
        entityId: account.id,
        storageKey: `CustomerPO/${randomUUID()}-po.pdf`,
        filename: "po.pdf",
        mimeType: "application/pdf",
        size: 10,
        sha256: randomUUID().replace(/-/g, ""),
        uploaderId: OWNER,
      },
    });
    fileIds.push(file.id);
    const po = await db.customerPO.create({
      data: {
        accountId: account.id,
        poNumber: `PO-${randomUUID().slice(0, 8)}`,
        poDate: new Date(),
        amount: "5000",
        fileId: file.id,
        receivedById: OWNER,
        receivedAt: new Date(),
      },
    });
    poIds.push(po.id);

    const check = await checkCustomerPoService({ customerPOId: po.id });

    expect(check.quotationNumber).toBeNull();
    expect(check.summary).toMatch(/nothing to check it against/);
  }, 60_000);
});

describe("verifying is a decision somebody has to explain", () => {
  it("records a clean verification with no note", async () => {
    const { po } = await makeQuotationWithPo();

    const verified = await verifyCustomerPoService(actor, { customerPOId: po.id });

    expect(verified.status).toBe("verified");
    expect(verified.discrepancyNotes).toBeNull();
  }, 60_000);

  it("refuses to verify differences that nobody explained", async () => {
    const { po } = await makeQuotationWithPo({ poAmount: "1000" });

    await expect(verifyCustomerPoService(actor, { customerPOId: po.id })).rejects.toThrow(
      /need a word of explanation/,
    );

    const stored = await db.customerPO.findUniqueOrThrow({ where: { id: po.id } });
    expect(stored.status).toBe("received");
  }, 60_000);

  it("keeps the explanation on the record, not only in the audit log", async () => {
    // The log is the evidence; this is what the next person to open the PO actually reads.
    const { po } = await makeQuotationWithPo({ poAmount: "1000" });

    const verified = await verifyCustomerPoService(actor, {
      customerPOId: po.id,
      acceptanceNote: "Customer split the award; the balance follows on a second PO.",
    });

    expect(verified.status).toBe("verified");
    expect(verified.discrepancyNotes).toMatch(/second PO/);
    expect(verified.discrepancyNotes).toMatch(/short by/);
  }, 60_000);

  it("refuses outright when a line was ordered that was never quoted", async () => {
    const { po } = await makeQuotationWithPo();

    await expect(
      verifyCustomerPoService(actor, {
        customerPOId: po.id,
        poLines: [
          { lineNo: 1, description: "Flow meter DN150", quantity: 5 },
          { lineNo: 2, description: "Commissioning", quantity: 1 },
          { lineNo: 3, description: "Spare impeller", quantity: 2 },
        ],
        // Even with an explanation: there is no agreed price, so there is nothing to accept.
        acceptanceNote: "Customer added a spare.",
      }),
    ).rejects.toThrow(/no agreed price/);
  }, 60_000);
});

describe("raising the sales order", () => {
  it("refuses an unverified PO", async () => {
    const { po } = await makeQuotationWithPo();

    await expect(createSalesOrderFromPoService(actor, { customerPOId: po.id })).rejects.toThrow(
      /has not been verified/,
    );
  }, 60_000);

  it("copies the lines and flags the service one for execution", async () => {
    const { po, quotation } = await makeQuotationWithPo();
    await verifyCustomerPoService(actor, { customerPOId: po.id });

    const order = await createSalesOrderFromPoService(actor, { customerPOId: po.id });
    salesOrderIds.push(order.id);

    expect(order.quotationId).toBe(quotation.id);
    expect(order.customerPOId).toBe(po.id);
    expect(order.total.toString()).toBe(quotation.total.toString());
    expect(order.lines).toHaveLength(2);
    expect(order.lines.map((line) => line.requiresExecution)).toEqual([false, true]);
    // §3: "If any line requires execution, `executionStatus` starts at `pending`."
    expect(order.executionStatus).toBe("pending");
    expect(order.status).toBe("open");
    expect(order.procurementStatus).toBe("pending");
    // Nothing bought, nothing delivered — the obligation is the full ordered quantity.
    expect(order.lines[0]!.qtyOrdered.toString()).toBe(order.lines[0]!.quantity.toString());
    expect(order.lines[0]!.qtyReceived.toString()).toBe("0");
  }, 60_000);

  it("leaves executionStatus at not_required for a goods-only order", async () => {
    const { po } = await makeQuotationWithPo({
      lines: [LINES[0]!],
    });
    await verifyCustomerPoService(actor, { customerPOId: po.id });

    const order = await createSalesOrderFromPoService(actor, { customerPOId: po.id });
    salesOrderIds.push(order.id);

    expect(order.executionStatus).toBe("not_required");
    // A box of spares must not generate an installation ticket nobody needs.
    expect(order.lines.every((line) => !line.requiresExecution)).toBe(true);
  }, 60_000);

  it("refuses a second order against the same PO", async () => {
    const { po } = await makeQuotationWithPo();
    await verifyCustomerPoService(actor, { customerPOId: po.id });
    const first = await createSalesOrderFromPoService(actor, { customerPOId: po.id });
    salesOrderIds.push(first.id);

    await expect(createSalesOrderFromPoService(actor, { customerPOId: po.id })).rejects.toThrow(
      /same money committed twice/,
    );
  }, 60_000);

  it("does not move when the quotation is revised afterwards", async () => {
    // The obligation is to what the customer ordered on the day. This is why §3 copies rather than
    // references, and it is the assertion that proves the copy is real.
    const { po, quotation } = await makeQuotationWithPo();
    await verifyCustomerPoService(actor, { customerPOId: po.id });
    const order = await createSalesOrderFromPoService(actor, { customerPOId: po.id });
    salesOrderIds.push(order.id);

    const before = order.lines[0]!.unitPrice.toString();

    await db.quotationLine.updateMany({
      where: { quotationId: quotation.id, lineNo: 1 },
      data: { description: "Flow meter DN200", unitPrice: "999999" },
    });

    const stored = await db.salesOrderLine.findFirstOrThrow({
      where: { salesOrderId: order.id, lineNo: 1 },
    });
    expect(stored.unitPrice.toString()).toBe(before);
    expect(stored.description).toBe("Flow meter DN150");
    // And the trail back is intact, so anybody can still see which quotation line this came from.
    expect(stored.quotationLineId).toBeTruthy();
  }, 60_000);

  it("announces itself to module 04 with the per-line flags", async () => {
    // §3: "Each ticket links back to the specific sales order lines it covers." A summary would make
    // module 04 re-read the order, turning its proposal into a function of whenever the job runs.
    const { po } = await makeQuotationWithPo();
    await verifyCustomerPoService(actor, { customerPOId: po.id });
    const order = await createSalesOrderFromPoService(actor, { customerPOId: po.id });
    salesOrderIds.push(order.id);

    const event = await db.eventOutbox.findFirstOrThrow({
      where: { event: "sales_order.created", actorId: OWNER },
      orderBy: { createdAt: "desc" },
    });
    const payload = event.payload as {
      salesOrderId: string;
      lines: { requiresExecution: boolean }[];
    };
    expect(payload.salesOrderId).toBe(order.id);
    expect(payload.lines.map((line) => line.requiresExecution)).toEqual([false, true]);
  }, 60_000);
});

describe("cost never leaks", () => {
  it("strips cost and margin from a reader without finance.view_cost", async () => {
    // Spec.md §4.3, the same rule module 02 follows. A sales order carries the quotation's cost, so
    // the screen that shows one is a new place for it to escape.
    const { po } = await makeQuotationWithPo();
    await verifyCustomerPoService(actor, { customerPOId: po.id });
    const order = await createSalesOrderFromPoService(actor, { customerPOId: po.id });
    salesOrderIds.push(order.id);

    const asOfficer = await getSalesOrderService(officer, order.id);
    expect(asOfficer.totalCost).not.toBeNull();
    expect(asOfficer.lines[0]!.unitCost).not.toBeNull();

    const asSalesperson = await getSalesOrderService(
      { id: OWNER, permissions: new Set(["sales_order.view", "sales_order.view_all"]) },
      order.id,
    );
    expect(asSalesperson.totalCost).toBeNull();
    expect(asSalesperson.marginAmount).toBeNull();
    expect(asSalesperson.lines[0]!.unitCost).toBeNull();
    // The price is still there — it is the cost behind it that is gated.
    expect(asSalesperson.lines[0]!.unitPrice).toBe(asOfficer.lines[0]!.unitPrice);
  }, 60_000);

  it("hides somebody else's order from a reader without view_all", async () => {
    const { po } = await makeQuotationWithPo();
    await verifyCustomerPoService(actor, { customerPOId: po.id });
    const order = await createSalesOrderFromPoService(actor, { customerPOId: po.id });
    salesOrderIds.push(order.id);

    await expect(
      getSalesOrderService(
        { id: `stranger-${suffix}`, permissions: new Set(["sales_order.view"]) },
        order.id,
      ),
    ).rejects.toThrow(/no longer exists/);
  }, 60_000);
});

describe("what counts as field work", () => {
  it("is service and labour, and nothing else yet", () => {
    expect(lineRequiresExecution("service")).toBe(true);
    expect(lineRequiresExecution("labour")).toBe(true);
    expect(lineRequiresExecution("product")).toBe(false);
    // §3 also names "whose product is flagged as requiring installation". That flag does not exist
    // on `Product`, and inventing one here would give module 04 a second mechanism to reconcile —
    // recorded rather than half-implemented. This assertion is the reminder.
    expect(lineRequiresExecution("freight")).toBe(false);
  });
});

/**
 * §4's downpayment gate, connected at last.
 *
 * The gate function has been correct and tested since module 03 session 2, and **switched off since
 * module 03 session 1**: `createSalesOrderFromPoService` hardcoded `downpaymentPct: 0` and
 * `financeStatus: "not_required"` with a comment saying module 05 would wire it "when the terms
 * exist". They existed from module 05 session 1 and nobody came back, so no order ever reached the
 * gate and procurement was ungated on the customer's money while looking gated.
 *
 * Nothing in the suite could see it, because `not_required` is a legitimate state and every test
 * asserted the gate function rather than whether anything ever reaches it. These tests assert the
 * reaching.
 */
describe("§4 — the downpayment gate, end to end", () => {
  async function termWithDownpayment(pct: string) {
    return db.paymentTerm.create({
      data: {
        name: `SO-TERM-${randomUUID().slice(0, 8)}`,
        downpaymentPct: pct,
        balanceTrigger: "on delivery",
      },
    });
  }

  it("puts an order on the gate when the quotation's terms ask for a downpayment", async () => {
    const term = await termWithDownpayment("0.30");
    const { po, quotation } = await makeQuotationWithPo();
    await db.quotation.update({
      where: { id: quotation.id },
      data: { paymentTermsId: term.id },
    });

    // §3's verification comes first — the gate under test is the one after it.
    await verifyCustomerPoService(actor, { customerPOId: po.id });
    const order = await createSalesOrderFromPoService(actor, { customerPOId: po.id });
    const saved = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id } });

    expect(saved.financeStatus).toBe("awaiting_downpayment");
    expect(Number(saved.downpaymentPct)).toBeCloseTo(0.3);
    // Computed from the order's own total, so finance is never chasing a figure the order does not
    // show — see the comment at the creation site.
    expect(Number(saved.downpaymentAmount)).toBeCloseTo(Number(saved.total) * 0.3, 2);
  });

  it("leaves an order alone when no downpayment was agreed", async () => {
    // A deal nobody set terms on has no agreed downpayment, and inventing one would gate
    // procurement on a figure the customer never saw.
    const { po } = await makeQuotationWithPo();
    await verifyCustomerPoService(actor, { customerPOId: po.id });
    const order = await createSalesOrderFromPoService(actor, { customerPOId: po.id });
    const saved = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id } });

    expect(saved.financeStatus).toBe("not_required");
    expect(Number(saved.downpaymentAmount)).toBe(0);
  });

  it("opens the gate when finance records the money, and keeps the reference", async () => {
    const term = await termWithDownpayment("0.50");
    const { po, quotation } = await makeQuotationWithPo();
    await db.quotation.update({ where: { id: quotation.id }, data: { paymentTermsId: term.id } });

    await verifyCustomerPoService(actor, { customerPOId: po.id });
    const order = await createSalesOrderFromPoService(actor, { customerPOId: po.id });
    await recordDownpaymentService(actor, {
      salesOrderId: order.id,
      reference: "BDO deposit slip 4471902",
    });

    const saved = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(saved.financeStatus).toBe("downpayment_received");

    // The reference is what procurement is relying on when it commits to a supplier, so it has to
    // survive somewhere a person can read it months later.
    const log = await db.auditLog.findFirst({
      where: { entityId: order.id, action: "downpayment_received" },
    });
    expect(log?.summary).toContain("4471902");
  });

  it("refuses to record a downpayment nobody agreed to, or to record one twice", async () => {
    const { po } = await makeQuotationWithPo();
    await verifyCustomerPoService(actor, { customerPOId: po.id });
    const noTerms = await createSalesOrderFromPoService(actor, { customerPOId: po.id });

    await expect(
      recordDownpaymentService(actor, { salesOrderId: noTerms.id, reference: "anything" }),
    ).rejects.toThrow(/no downpayment agreed/);

    const term = await termWithDownpayment("0.25");
    const second = await makeQuotationWithPo();
    await db.quotation.update({
      where: { id: second.quotation.id },
      data: { paymentTermsId: term.id },
    });
    await verifyCustomerPoService(actor, { customerPOId: second.po.id });
    const order = await createSalesOrderFromPoService(actor, { customerPOId: second.po.id });

    await recordDownpaymentService(actor, { salesOrderId: order.id, reference: "first" });
    // A duplicate would suggest two payments where there was one.
    await expect(
      recordDownpaymentService(actor, { salesOrderId: order.id, reference: "again" }),
    ).rejects.toThrow(/already/);
  });

  it("refuses a downpayment with no reference, and one dated in the future", async () => {
    const term = await termWithDownpayment("0.30");
    const { po, quotation } = await makeQuotationWithPo();
    await db.quotation.update({ where: { id: quotation.id }, data: { paymentTermsId: term.id } });
    await verifyCustomerPoService(actor, { customerPOId: po.id });
    const order = await createSalesOrderFromPoService(actor, { customerPOId: po.id });

    await expect(
      recordDownpaymentService(actor, { salesOrderId: order.id, reference: "   " }),
    ).rejects.toThrow(/how the money arrived/);

    await expect(
      recordDownpaymentService(actor, {
        salesOrderId: order.id,
        reference: "ok",
        receivedAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }),
    ).rejects.toThrow(/arrived in the future/);
  });
});
