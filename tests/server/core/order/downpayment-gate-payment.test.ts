import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createSalesOrderFromPoService,
  satisfyDownpaymentGateOnPayment,
  verifyCustomerPoService,
} from "@/server/core/order/sales-order-service";
import { createQuotationService } from "@/server/core/quotation/quotation-service";
import { saveQuotationLinesService } from "@/server/core/quotation/quotation-line-service";
import { generateScheduleService } from "@/server/core/finance/billing-service";
import {
  clearChequeService,
  issueStatementService,
  raiseStatementService,
  recordPaymentService,
} from "@/server/core/finance/invoice-service";

/**
 * docs/DECISIONS.md #182 — reported directly against a real order: a supplier PO stayed "blocked,
 * waiting for downpayment" against a sales order whose downpayment had, in fact, already been paid
 * through Finance. `recordDownpaymentService` (module 03) and `recordPaymentService` (module 05) had
 * never been connected — this exercises the connection end to end, against the real database, rather
 * than the two halves in isolation the way `sales-order.test.ts` and `invoice.test.ts` already do.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `dpg-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "Downpayment Gate Test" };

const accountIds: string[] = [];
const quotationIds: string[] = [];
const poIds: string[] = [];
const salesOrderIds: string[] = [];
const fileIds: string[] = [];
const paymentTermIds: string[] = [];
const scheduleIds: string[] = [];
const statementIds: string[] = [];
const paymentIds: string[] = [];

async function termWithMilestones(downpaymentPct: string) {
  const term = await db.paymentTerm.create({
    data: {
      name: `DPG-TERM-${randomUUID().slice(0, 8)}`,
      // Module 03's own gate reads these legacy fields, independently of `milestones` below —
      // matching the ratio so the test fixture is internally consistent, not because the gate
      // needs it.
      downpaymentPct,
      balanceTrigger: "on completion",
      milestones: [
        { label: "Downpayment", pct: downpaymentPct, trigger: "on_order" },
        {
          label: "Balance on completion",
          pct: (100 - Number(downpaymentPct)).toString(),
          trigger: "on_project_close",
        },
      ],
    },
  });
  paymentTermIds.push(term.id);
  return term;
}

/** A verified, ordered sales order gated on a downpayment, with a real billing schedule behind it —
 *  everything downstream of `payment.received` needs to resolve a real `on_order` `BillingMilestone`. */
async function makeGatedOrder(downpaymentPct = "50") {
  const term = await termWithMilestones(downpaymentPct);

  const account = await db.customerAccount.create({
    data: {
      code: `DPG-${randomUUID().slice(0, 12)}`,
      name: `Downpayment Co ${suffix}`,
      ownerId: OWNER,
    },
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
    lines: [
      {
        itemType: "product",
        description: "Flow meter DN150",
        quantity: "2",
        unitCost: "50000",
        markupPct: "20",
      },
    ],
  });
  await db.quotation.update({ where: { id: quotation.id }, data: { paymentTermsId: term.id } });
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
      amount: saved.total.toString(),
      currency: saved.currency,
      fileId: file.id,
      receivedById: OWNER,
      receivedAt: new Date(),
    },
  });
  poIds.push(po.id);

  await verifyCustomerPoService(actor, { customerPOId: po.id });
  const order = await createSalesOrderFromPoService(actor, { customerPOId: po.id });
  salesOrderIds.push(order.id);

  const schedule = await generateScheduleService(actor, { salesOrderId: order.id });
  scheduleIds.push(schedule.scheduleId);

  const milestone = await db.billingMilestone.findFirstOrThrow({
    where: { salesOrderId: order.id, trigger: "on_order" },
  });

  return { account, order, milestone };
}

afterAll(async () => {
  await db.serviceInvoice.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.paymentAllocation.deleteMany({ where: { paymentId: { in: paymentIds } } });
  await db.payment.deleteMany({ where: { id: { in: paymentIds } } });
  await db.billingStatementLine.deleteMany({ where: { statementId: { in: statementIds } } });
  await db.billingStatement.deleteMany({ where: { id: { in: statementIds } } });
  await db.billingMilestone.deleteMany({ where: { scheduleId: { in: scheduleIds } } });
  await db.billingSchedule.deleteMany({ where: { id: { in: scheduleIds } } });
  await db.salesOrderLine.deleteMany({ where: { salesOrderId: { in: salesOrderIds } } });
  await db.salesOrder.deleteMany({ where: { id: { in: salesOrderIds } } });
  await db.auditLog.deleteMany({
    where: {
      entityId: {
        in: [...quotationIds, ...accountIds, ...poIds, ...salesOrderIds, ...statementIds],
      },
    },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: OWNER } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: quotationIds } } });
  await db.customerPO.deleteMany({ where: { id: { in: poIds } } });
  await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.paymentTerm.deleteMany({ where: { id: { in: paymentTermIds } } });
});

describe("recording the downpayment in Finance opens module 03's gate on its own", () => {
  it("opens the gate the moment the downpayment statement is paid in full", async () => {
    const { account, order, milestone } = await makeGatedOrder("50");

    const raised = await raiseStatementService(actor, {
      accountId: account.id,
      salesOrderId: order.id,
      milestoneId: milestone.id,
      dueDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
      lines: [{ description: milestone.label, quantity: 1, unitPrice: milestone.amount }],
    });
    statementIds.push(raised.id);
    await issueStatementService(actor, { statementId: raised.id });

    const statement = await db.billingStatement.findUniqueOrThrow({ where: { id: raised.id } });
    const payment = await recordPaymentService(actor, {
      accountId: account.id,
      receivedAt: new Date(),
      method: "bank_transfer",
      amount: statement.total,
      reference: "BDO deposit slip 998211",
    });
    paymentIds.push(payment.paymentId);

    // What the drain job would do — call the subscriber directly, exactly the payload shape
    // `payment.received` carries.
    await satisfyDownpaymentGateOnPayment({ paymentId: payment.paymentId });

    const saved = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(saved.financeStatus).toBe("downpayment_received");

    const log = await db.auditLog.findFirst({
      where: { entityId: order.id, action: "downpayment_received" },
    });
    expect(log?.summary).toContain("998211");
  }, 60_000);

  it("does not open the gate on a partial payment — the demand was for the whole downpayment", async () => {
    const { account, order, milestone } = await makeGatedOrder("50");

    const raised = await raiseStatementService(actor, {
      accountId: account.id,
      salesOrderId: order.id,
      milestoneId: milestone.id,
      dueDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
      lines: [{ description: milestone.label, quantity: 1, unitPrice: milestone.amount }],
    });
    statementIds.push(raised.id);
    await issueStatementService(actor, { statementId: raised.id });

    const payment = await recordPaymentService(actor, {
      accountId: account.id,
      receivedAt: new Date(),
      method: "bank_transfer",
      amount: 1000, // a token amount, nowhere near the milestone's total
      reference: "Partial deposit",
    });
    paymentIds.push(payment.paymentId);

    await satisfyDownpaymentGateOnPayment({ paymentId: payment.paymentId });

    const saved = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(saved.financeStatus).toBe("awaiting_downpayment");

    const statement = await db.billingStatement.findUniqueOrThrow({ where: { id: raised.id } });
    expect(statement.status).toBe("partially_paid");
  }, 60_000);

  it("waits for a post-dated cheque to actually clear before opening the gate", async () => {
    const { account, order, milestone } = await makeGatedOrder("30");

    const raised = await raiseStatementService(actor, {
      accountId: account.id,
      salesOrderId: order.id,
      milestoneId: milestone.id,
      dueDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
      lines: [{ description: milestone.label, quantity: 1, unitPrice: milestone.amount }],
    });
    statementIds.push(raised.id);
    await issueStatementService(actor, { statementId: raised.id });

    const statement = await db.billingStatement.findUniqueOrThrow({ where: { id: raised.id } });
    const payment = await recordPaymentService(actor, {
      accountId: account.id,
      receivedAt: new Date(),
      method: "check",
      checkNumber: "CHK-99182",
      amount: statement.total,
      reference: "Post-dated cheque",
    });
    paymentIds.push(payment.paymentId);

    // Uncleared — `applySettlement` has not run yet, so there is nothing yet for this to find.
    await satisfyDownpaymentGateOnPayment({ paymentId: payment.paymentId });
    let saved = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(saved.financeStatus).toBe("awaiting_downpayment");

    await clearChequeService(actor, { paymentId: payment.paymentId });
    await satisfyDownpaymentGateOnPayment({ paymentId: payment.paymentId });

    saved = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(saved.financeStatus).toBe("downpayment_received");
  }, 60_000);

  it("is a no-op, not a failure, when the gate is already open", async () => {
    const { account, order, milestone } = await makeGatedOrder("50");

    const raised = await raiseStatementService(actor, {
      accountId: account.id,
      salesOrderId: order.id,
      milestoneId: milestone.id,
      dueDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
      lines: [{ description: milestone.label, quantity: 1, unitPrice: milestone.amount }],
    });
    statementIds.push(raised.id);
    await issueStatementService(actor, { statementId: raised.id });

    const statement = await db.billingStatement.findUniqueOrThrow({ where: { id: raised.id } });
    const payment = await recordPaymentService(actor, {
      accountId: account.id,
      receivedAt: new Date(),
      method: "bank_transfer",
      amount: statement.total,
      reference: "BDO deposit slip 118820",
    });
    paymentIds.push(payment.paymentId);

    await satisfyDownpaymentGateOnPayment({ paymentId: payment.paymentId });
    // A second delivery of the same event — a retried job, or the same statement settling twice —
    // must not throw.
    await expect(
      satisfyDownpaymentGateOnPayment({ paymentId: payment.paymentId }),
    ).resolves.toBeUndefined();

    const saved = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(saved.financeStatus).toBe("downpayment_received");
  }, 60_000);
});
