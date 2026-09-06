import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  generateScheduleService,
  getScheduleService,
  recordCustomerBillingReplyService,
  releaseMilestoneService,
} from "@/server/core/finance/billing-service";

/**
 * docs/DECISIONS.md #184 — the two acts specific to the payment-terms redesign that no earlier test
 * covers: releasing a `manual` milestone by hand, and logging §14's customer reply.
 *
 * What only a real run settles:
 *
 *  1. **`manual` cannot be released by any event** — only `releaseMilestoneService` moves it, so a
 *     term with no matching subscriber does not silently sit `pending` forever undetected.
 *  2. **"100% Payment on Delivery" bills itself the moment it is released.** `autoRaiseOnRelease` is
 *     read from the frozen `termSnapshot`, not the live `PaymentTerm` — this is the only test that
 *     exercises that read.
 *  3. **The delivery ticket only ever auto-generates when the proposal is unambiguous.** A goods-only
 *     order gets one; an order that would also need an installation ticket gets none, and a person is
 *     left to use the ordinary ticket screen instead.
 */

const suffix = randomUUID().slice(0, 8);
const actor = { actorId: `fin-rel-${suffix}`, actorLabel: "Finance officer" };

const accountIds: string[] = [];
const orderIds: string[] = [];
const termIds: string[] = [];
const scheduleIds: string[] = [];
const quotationIds: string[] = [];
const poIds: string[] = [];
const fileIds: string[] = [];
const statementIds: string[] = [];
const ticketIds: string[] = [];

async function makeTerm(milestones: unknown[]) {
  const term = await db.paymentTerm.create({
    data: {
      name: `Test release term ${randomUUID().slice(0, 8)}`,
      netDays: 15,
      milestones: milestones as object[],
      isActive: true,
    },
  });
  termIds.push(term.id);
  return term;
}

async function makeOrder(
  totalPesos: string,
  paymentTermsId: string,
  lines: { requiresExecution?: boolean; itemType?: string; description: string }[],
) {
  const account = await db.customerAccount.create({
    data: {
      code: `FINREL-${randomUUID().slice(0, 12)}`,
      name: `Release Co ${suffix}`,
      ownerId: actor.actorId,
    },
  });
  accountIds.push(account.id);

  const quotation = await db.quotation.create({
    data: {
      number: `TEST-LQ-${randomUUID().slice(0, 10)}`,
      accountId: account.id,
      title: "Release fixture",
      scopeOfWork: "Whatever the schedule bills for.",
      validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      preparedById: actor.actorId,
      total: totalPesos,
      subtotal: totalPesos,
    },
  });
  quotationIds.push(quotation.id);

  const file = await db.fileObject.create({
    data: {
      entityType: "CustomerPO",
      entityId: account.id,
      filename: "po.pdf",
      mimeType: "application/pdf",
      size: 1024,
      sha256: randomUUID().replace(/-/g, ""),
      storageKey: `test/${randomUUID()}.pdf`,
      uploaderId: actor.actorId,
    },
  });
  fileIds.push(file.id);

  const po = await db.customerPO.create({
    data: {
      accountId: account.id,
      quotationId: quotation.id,
      poNumber: `PO-${randomUUID().slice(0, 8)}`,
      poDate: new Date(),
      amount: totalPesos,
      fileId: file.id,
      receivedById: actor.actorId,
    },
  });
  poIds.push(po.id);

  const order = await db.salesOrder.create({
    data: {
      number: `TEST-SO-${randomUUID().slice(0, 10)}`,
      accountId: account.id,
      quotationId: quotation.id,
      customerPOId: po.id,
      ownerId: actor.actorId,
      status: "open",
      currency: "PHP",
      subtotal: totalPesos,
      total: totalPesos,
      paymentTermsId,
    },
  });
  orderIds.push(order.id);

  await db.salesOrderLine.createMany({
    data: lines.map((line, index) => ({
      salesOrderId: order.id,
      lineNo: index + 1,
      description: line.description,
      itemType: line.itemType ?? "product",
      requiresExecution: line.requiresExecution ?? false,
    })),
  });

  return order;
}

afterAll(async () => {
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.billingStatementLine.deleteMany({ where: { statementId: { in: statementIds } } });
  await db.billingStatement.deleteMany({ where: { id: { in: statementIds } } });
  await db.billingMilestone.deleteMany({ where: { salesOrderId: { in: orderIds } } });
  await db.billingSchedule.deleteMany({ where: { salesOrderId: { in: orderIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: [...scheduleIds, ...orderIds] } } });
  await db.eventOutbox.deleteMany({ where: { actorId: actor.actorId } });
  await db.salesOrderLine.deleteMany({ where: { salesOrderId: { in: orderIds } } });
  await db.salesOrder.deleteMany({ where: { id: { in: orderIds } } });
  await db.customerPO.deleteMany({ where: { id: { in: poIds } } });
  await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.paymentTerm.deleteMany({ where: { id: { in: termIds } } });
});

describe("releasing a manual milestone by hand", () => {
  it("refuses a milestone whose trigger is not manual", async () => {
    const term = await makeTerm([{ label: "All", pct: "100", trigger: "on_order" }]);
    const order = await makeOrder("10000.00", term.id, [{ description: "A widget" }]);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    const schedule = await getScheduleService(order.id);

    await expect(
      releaseMilestoneService(actor, { milestoneId: schedule!.milestones[0]!.id }),
    ).rejects.toThrow(/nothing to release/i);
  });

  it("readies the milestone but raises nothing, when the term does not auto-raise", async () => {
    const term = await makeTerm([{ label: "30/70 balance", pct: "100", trigger: "manual" }]);
    const order = await makeOrder("10000.00", term.id, [
      { description: "Installation", requiresExecution: true },
    ]);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    const schedule = await getScheduleService(order.id);

    const released = await releaseMilestoneService(actor, {
      milestoneId: schedule!.milestones[0]!.id,
    });
    expect(released.statement).toBeNull();

    const after = await getScheduleService(order.id);
    expect(after!.milestones[0]!.status).toBe("ready_to_bill");
  });

  it("refuses a milestone that is not pending", async () => {
    const term = await makeTerm([{ label: "Balance", pct: "100", trigger: "manual" }]);
    const order = await makeOrder("10000.00", term.id, [{ description: "A widget" }]);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    const schedule = await getScheduleService(order.id);
    const milestoneId = schedule!.milestones[0]!.id;

    await releaseMilestoneService(actor, { milestoneId });
    await expect(releaseMilestoneService(actor, { milestoneId })).rejects.toThrow(/already/i);
  });

  /**
   * §14's "100% Payment on Delivery": releasing this one milestone *is* finance's decision to bill
   * it, so the statement is raised and issued in the same act rather than waiting for somebody to
   * separately notice it on the work list.
   */
  it("raises and issues the statement immediately when the term says to", async () => {
    const term = await makeTerm([
      { label: "Full amount", pct: "100", trigger: "manual", autoRaiseOnRelease: true },
    ]);
    const order = await makeOrder("50000.00", term.id, [{ description: "Equipment" }]);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    const schedule = await getScheduleService(order.id);

    const released = await releaseMilestoneService(actor, {
      milestoneId: schedule!.milestones[0]!.id,
    });
    expect(released.statement).not.toBeNull();
    statementIds.push(released.statement!.id);

    const statement = await db.billingStatement.findUniqueOrThrow({
      where: { id: released.statement!.id },
    });
    expect(statement.status).toBe("issued");
    // The milestone amount is VAT-exclusive, same as everywhere else money is planned in this
    // build — `raiseStatementService` defaults to `exclusive`, so VAT lands on top of it in `total`.
    expect(statement.subtotal).toBe(5_000_000);
    expect(statement.total).toBe(5_600_000);

    const after = await getScheduleService(order.id);
    expect(after!.milestones[0]!.status).toBe("invoiced");
    expect(after!.milestones[0]!.billingStatementId).toBe(released.statement!.id);
  });
});

describe("logging the customer's reply on a billed milestone", () => {
  async function raiseAndInvoice(order: { id: string }, milestoneId: string) {
    const released = await releaseMilestoneService(actor, { milestoneId });
    if (released.statement) statementIds.push(released.statement.id);
    return released;
  }

  it("refuses a reply on a milestone that has not been billed yet", async () => {
    const term = await makeTerm([
      { label: "Full amount", pct: "100", trigger: "manual", autoRaiseOnRelease: true },
    ]);
    const order = await makeOrder("10000.00", term.id, [{ description: "Equipment" }]);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    const schedule = await getScheduleService(order.id);

    await expect(
      recordCustomerBillingReplyService(actor, {
        milestoneId: schedule!.milestones[0]!.id,
        paymentReady: true,
        preferredDeliveryDate: new Date(),
      }),
    ).rejects.toThrow(/has not been billed/);
  });

  it("insists on a preferred delivery date when the customer says payment is ready", async () => {
    const term = await makeTerm([
      { label: "Full amount", pct: "100", trigger: "manual", autoRaiseOnRelease: true },
    ]);
    const order = await makeOrder("10000.00", term.id, [{ description: "Equipment" }]);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    const schedule = await getScheduleService(order.id);
    await raiseAndInvoice(order, schedule!.milestones[0]!.id);

    await expect(
      recordCustomerBillingReplyService(actor, {
        milestoneId: schedule!.milestones[0]!.id,
        paymentReady: true,
      }),
    ).rejects.toThrow(/preferred delivery date/);
  });

  it("records 'not ready yet' without touching tickets", async () => {
    const term = await makeTerm([
      { label: "Full amount", pct: "100", trigger: "manual", autoRaiseOnRelease: true },
    ]);
    const order = await makeOrder("10000.00", term.id, [{ description: "Equipment" }]);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    const schedule = await getScheduleService(order.id);
    await raiseAndInvoice(order, schedule!.milestones[0]!.id);

    const reply = await recordCustomerBillingReplyService(actor, {
      milestoneId: schedule!.milestones[0]!.id,
      paymentReady: false,
      notes: "Customer says next week.",
    });
    expect(reply.ticket).toBeNull();
    expect(reply.milestone.customerConfirmedAt).toBeNull();
  });

  /**
   * The safe-auto-creation guard: a goods-only order proposes exactly one "delivery" ticket, which
   * is unambiguous enough for the reply itself to be the human decision that generates it.
   */
  it("creates the delivery ticket when the order proposes exactly one, unambiguously", async () => {
    const term = await makeTerm([
      { label: "Full amount", pct: "100", trigger: "manual", autoRaiseOnRelease: true },
    ]);
    const order = await makeOrder("10000.00", term.id, [{ description: "Pump unit" }]);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    const schedule = await getScheduleService(order.id);
    await raiseAndInvoice(order, schedule!.milestones[0]!.id);

    const preferredDate = new Date("2026-10-01T00:00:00.000Z");
    const reply = await recordCustomerBillingReplyService(actor, {
      milestoneId: schedule!.milestones[0]!.id,
      paymentReady: true,
      preferredDeliveryDate: preferredDate,
    });

    expect(reply.ticket).not.toBeNull();
    ticketIds.push(reply.ticket!.id);
    expect(reply.ticket!.type).toBe("delivery");
    expect(reply.ticket!.requiredByDate).toEqual(preferredDate);
    expect(reply.milestone.customerConfirmedAt).not.toBeNull();
    expect(reply.milestone.customerPreferredDeliveryDate).toEqual(preferredDate);
  });

  /**
   * The refusal side of the same guard: an order that would also need an installation ticket makes
   * the proposal ambiguous, so nothing is auto-generated — a person uses the ordinary screen instead.
   */
  it("does not guess when the order would need more than a delivery ticket", async () => {
    const term = await makeTerm([
      { label: "Full amount", pct: "100", trigger: "manual", autoRaiseOnRelease: true },
    ]);
    const order = await makeOrder("10000.00", term.id, [
      { description: "Pump unit" },
      { description: "Installation", requiresExecution: true },
    ]);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    const schedule = await getScheduleService(order.id);
    await raiseAndInvoice(order, schedule!.milestones[0]!.id);

    const reply = await recordCustomerBillingReplyService(actor, {
      milestoneId: schedule!.milestones[0]!.id,
      paymentReady: true,
      preferredDeliveryDate: new Date(),
    });

    expect(reply.ticket).toBeNull();
    // The reply is still recorded — only the ticket auto-creation is refused.
    expect(reply.milestone.customerConfirmedAt).not.toBeNull();
  });
});
