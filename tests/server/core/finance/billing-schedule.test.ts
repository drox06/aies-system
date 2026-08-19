import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  applyTriggerToOrdersService,
  applyTriggerToSchedule,
  billableMilestonesService,
  cancelMilestoneService,
  generateScheduleService,
  getScheduleService,
  onDeliveryReceiptSigned,
  onGoodsDelivered,
  onProjectClosed,
  onQaPassed,
  onSupplierPoSent,
  onTcCompleted,
} from "@/server/core/finance/billing-service";

/**
 * specs/05-finance-billing.md §2, against the real database.
 *
 * What only a real run settles:
 *
 *  1. **A trigger fires exactly once**, even when the same event arrives twice — §11 asks for this by
 *     name, and it is a property of the guarded UPDATE rather than of any pure function.
 *  2. **The plan is frozen at generation.** Editing the payment term afterwards must not re-plan a
 *     live order, which only a stored snapshot can guarantee.
 *  3. **A downpayment is billable immediately.** `on_order` has no subscriber to fire it, because the
 *     schedule did not exist when the order was created. If this test passes and that code is
 *     removed, the company's most common term silently never bills its first half.
 */

const suffix = randomUUID().slice(0, 8);
const actor = { actorId: `fin-${suffix}`, actorLabel: "Finance officer" };

const accountIds: string[] = [];
const orderIds: string[] = [];
const termIds: string[] = [];
const scheduleIds: string[] = [];
const quotationIds: string[] = [];
const poIds: string[] = [];
const fileIds: string[] = [];
const ticketIds: string[] = [];
const projectIds: string[] = [];

async function makeTerm(milestones: unknown[], netDays = 15) {
  const term = await db.paymentTerm.create({
    data: {
      name: `Test term ${randomUUID().slice(0, 8)}`,
      netDays,
      milestones: milestones as object[],
      isActive: true,
    },
  });
  termIds.push(term.id);
  return term;
}

/**
 * A sales order at a known value, with a term attached.
 *
 * `SalesOrder` requires a quotation and a customer PO — module 03 made both mandatory on purpose, so
 * an order cannot exist without the documents that authorised it. The fixture therefore builds the
 * whole chain, which is a fair reflection of what a real order costs to bring into being.
 */
async function makeOrder(totalPesos: string, paymentTermsId: string | null) {
  const account = await db.customerAccount.create({
    data: {
      code: `FIN-${randomUUID().slice(0, 12)}`,
      name: `Finance Co ${suffix}`,
      ownerId: actor.actorId,
    },
  });
  accountIds.push(account.id);

  const quotation = await db.quotation.create({
    data: {
      number: `TEST-LQ-${randomUUID().slice(0, 10)}`,
      accountId: account.id,
      title: "Billing schedule fixture",
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
  return order;
}

afterAll(async () => {
  await db.billingMilestone.deleteMany({ where: { salesOrderId: { in: orderIds } } });
  await db.billingSchedule.deleteMany({ where: { salesOrderId: { in: orderIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: [...scheduleIds, ...orderIds] } } });
  await db.eventOutbox.deleteMany({ where: { actorId: actor.actorId } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.salesOrder.deleteMany({ where: { id: { in: orderIds } } });
  await db.customerPO.deleteMany({ where: { id: { in: poIds } } });
  await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.project.deleteMany({ where: { id: { in: projectIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.paymentTerm.deleteMany({ where: { id: { in: termIds } } });
});

describe("planning how an order will be billed", () => {
  it("splits the order and makes the downpayment billable at once", async () => {
    const term = await makeTerm([
      { label: "Downpayment", pct: "50", trigger: "on_order" },
      { label: "Balance", pct: "50", trigger: "on_project_close" },
    ]);
    const order = await makeOrder("100000.00", term.id);

    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    expect(result.milestones).toBe(2);

    const schedule = await getScheduleService(order.id);
    expect(schedule).not.toBeNull();
    expect(schedule!.milestones).toHaveLength(2);

    // ₱100,000.00 → 10,000,000 centavos, halved.
    expect(schedule!.milestones[0]!.amount).toBe(5_000_000);
    expect(schedule!.milestones[1]!.amount).toBe(5_000_000);

    /**
     * The downpayment is billable already. Nothing fired an event — the schedule did not exist when
     * the order was created, so no subscriber could have. This is the case that would fail silently.
     */
    expect(schedule!.milestones[0]!.status).toBe("ready_to_bill");
    expect(schedule!.milestones[0]!.readyReason).toContain(order.number);
    expect(schedule!.milestones[0]!.dueDate).not.toBeNull();

    // And the balance waits for the project to close.
    expect(schedule!.milestones[1]!.status).toBe("pending");
    expect(schedule!.milestones[1]!.readyAt).toBeNull();
  });

  it("refuses a term whose milestones do not add up", async () => {
    const term = await makeTerm([
      { label: "Downpayment", pct: "30", trigger: "on_order" },
      { label: "Balance", pct: "60", trigger: "on_project_close" },
    ]);
    const order = await makeOrder("50000.00", term.id);

    await expect(generateScheduleService(actor, { salesOrderId: order.id })).rejects.toThrow(
      /have to come to 100%/,
    );

    // Nothing was written — a half-planned schedule is worse than none.
    expect(await getScheduleService(order.id)).toBeNull();
  });

  it("refuses an order with no payment term rather than inventing one", async () => {
    const order = await makeOrder("50000.00", null);
    await expect(generateScheduleService(actor, { salesOrderId: order.id })).rejects.toThrow(
      /no payment term/,
    );
  });

  it("refuses to plan the same order twice", async () => {
    const term = await makeTerm([{ label: "All", pct: "100", trigger: "on_project_close" }]);
    const order = await makeOrder("10000.00", term.id);

    const first = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(first.scheduleId);

    await expect(generateScheduleService(actor, { salesOrderId: order.id })).rejects.toThrow(
      /already has a billing schedule/,
    );
  });

  /**
   * The reason `termSnapshot` exists. A term is configuration somebody can edit, and an order billed
   * under 50/50 must not silently become 30/70 because the term was renegotiated for new business.
   */
  it("does not re-plan a live order when the term is edited afterwards", async () => {
    const term = await makeTerm([
      { label: "Downpayment", pct: "50", trigger: "on_order" },
      { label: "Balance", pct: "50", trigger: "on_project_close" },
    ]);
    const order = await makeOrder("100000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);

    await db.paymentTerm.update({
      where: { id: term.id },
      data: {
        milestones: [
          { label: "Downpayment", pct: "30", trigger: "on_order" },
          { label: "Balance", pct: "70", trigger: "on_project_close" },
        ] as object[],
      },
    });

    const schedule = await getScheduleService(order.id);
    expect(schedule!.milestones[0]!.amount).toBe(5_000_000);
    // Prisma renders a Decimal without trailing zeros; what matters is that it is still 50, not 30.
    expect(Number(schedule!.milestones[0]!.pct)).toBe(50);
  });
});

describe("what an event makes billable", () => {
  it("readies the milestone whose trigger matches, and leaves the others alone", async () => {
    const term = await makeTerm([
      { label: "Advance", pct: "20", trigger: "on_order" },
      { label: "On commissioning", pct: "50", trigger: "on_tc_accepted" },
      { label: "Final", pct: "30", trigger: "on_project_close" },
    ]);
    const order = await makeOrder("100000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);

    const readied = await applyTriggerToOrdersService(actor, {
      salesOrderIds: [order.id],
      eventName: "tc.completed",
      reason: "the customer accepted commissioning",
    });
    expect(readied.readied).toBe(1);

    const schedule = await getScheduleService(order.id);
    const byLabel = new Map(schedule!.milestones.map((m) => [m.label, m]));
    expect(byLabel.get("Advance")!.status).toBe("ready_to_bill");
    expect(byLabel.get("On commissioning")!.status).toBe("ready_to_bill");
    expect(byLabel.get("On commissioning")!.readyReason).toBe(
      "the customer accepted commissioning",
    );
    // Untouched: the project has not closed.
    expect(byLabel.get("Final")!.status).toBe("pending");
  });

  /**
   * §11: "Milestone triggers fire exactly once per event." A redelivered event — the job queue
   * retrying, two modules both reporting the same completion — must not notify twice or overwrite the
   * due date that was set the first time.
   */
  it("fires once, even when the same event arrives twice", async () => {
    const term = await makeTerm([{ label: "All of it", pct: "100", trigger: "on_project_close" }]);
    const order = await makeOrder("80000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);

    const first = await applyTriggerToSchedule(actor, {
      scheduleId: result.scheduleId,
      eventName: "project.closed",
      reason: "the project closed",
    });
    expect(first.readied).toBe(1);

    const before = await getScheduleService(order.id);
    const dueFirst = before!.milestones[0]!.dueDate;

    const second = await applyTriggerToSchedule(actor, {
      scheduleId: result.scheduleId,
      eventName: "project.closed",
      reason: "the project closed again somehow",
    });
    expect(second.readied).toBe(0);

    const after = await getScheduleService(order.id);
    expect(after!.milestones[0]!.readyReason).toBe("the project closed");
    expect(after!.milestones[0]!.dueDate).toEqual(dueFirst);
  });

  it("readies both milestones that listen to the same event", async () => {
    const term = await makeTerm([
      { label: "On close", pct: "70", trigger: "on_project_close" },
      { label: "Retention", pct: "30", trigger: "net_days_after_close", daysAfter: 60 },
    ]);
    const order = await makeOrder("100000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);

    const readied = await applyTriggerToSchedule(actor, {
      scheduleId: result.scheduleId,
      eventName: "project.closed",
      reason: "the project closed",
    });
    expect(readied.readied).toBe(2);

    const schedule = await getScheduleService(order.id);
    const [onClose, retention] = schedule!.milestones;

    // Both billable, and the retention is due much later — the snapshot's daysAfter, not net days.
    const gap = new Date(retention!.dueDate!).getTime() - new Date(onClose!.dueDate!).getTime();
    expect(Math.round(gap / (24 * 60 * 60 * 1000))).toBe(45);
  });

  it("does nothing for an event no milestone listens to", async () => {
    const term = await makeTerm([{ label: "All", pct: "100", trigger: "on_project_close" }]);
    const order = await makeOrder("10000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);

    const readied = await applyTriggerToSchedule(actor, {
      scheduleId: result.scheduleId,
      eventName: "quotation.sent",
      reason: "unrelated",
    });
    expect(readied.readied).toBe(0);
  });
});

describe("the work list", () => {
  it("lists what is billable with the reason it became billable", async () => {
    const term = await makeTerm([
      { label: "Downpayment", pct: "40", trigger: "on_order" },
      { label: "Balance", pct: "60", trigger: "on_project_close" },
    ]);
    const order = await makeOrder("25000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);

    const rows = await billableMilestonesService();
    const mine = rows.filter((row) => row.salesOrderId === order.id);

    expect(mine).toHaveLength(1);
    expect(mine[0]!.label).toBe("Downpayment");
    expect(mine[0]!.amount).toBe(1_000_000);
    expect(mine[0]!.readyReason).toContain(order.number);
    expect(mine[0]!.salesOrderNumber).toBe(order.number);
  });
});

describe("a milestone that will never be billed", () => {
  it("cancels with a reason, and comes off the work list", async () => {
    const term = await makeTerm([
      { label: "Downpayment", pct: "50", trigger: "on_order" },
      { label: "Balance", pct: "50", trigger: "on_project_close" },
    ]);
    const order = await makeOrder("40000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);

    const schedule = await getScheduleService(order.id);
    const downpayment = schedule!.milestones[0]!;

    await cancelMilestoneService(actor, {
      milestoneId: downpayment.id,
      reason: "Customer paid the whole amount up front against a single statement.",
    });

    const rows = await billableMilestonesService();
    expect(rows.filter((row) => row.id === downpayment.id)).toEqual([]);

    const after = await getScheduleService(order.id);
    expect(after!.milestones[0]!.status).toBe("cancelled");
  });

  it("insists on a reason", async () => {
    const term = await makeTerm([{ label: "All", pct: "100", trigger: "on_order" }]);
    const order = await makeOrder("10000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);

    const schedule = await getScheduleService(order.id);
    await expect(
      cancelMilestoneService(actor, { milestoneId: schedule!.milestones[0]!.id, reason: "no" }),
    ).rejects.toThrow(/Say why/);
  });
});

/**
 * The subscribers, wired to the events the platform actually emits.
 *
 * These matter more than they look. A handler reading the wrong field from a payload does not throw —
 * it finds no order, does nothing, and the milestone sits `pending` forever while everybody assumes
 * billing is automatic. The failure is silent by construction, which is why each one is tested
 * against the payload shape its emitter really sends.
 */
describe("the subscribers", () => {
  /** A ticket on a project, tied to an order — what the real handlers resolve through. */
  async function makeTicketOn(order: { id: string; accountId: string }, projectId?: string) {
    const ticket = await db.ticket.create({
      data: {
        number: `TEST-TKT-${randomUUID().slice(0, 10)}`,
        type: "installation",
        title: "Subscriber fixture",
        scopeOfWork: "Do the work.",
        raisedById: actor.actorId,
        accountId: order.accountId,
        salesOrderId: order.id,
        projectId: projectId ?? null,
        status: "generated",
        priority: "normal",
      },
    });
    ticketIds.push(ticket.id);
    return ticket;
  }

  it("bills on_project_close when a project closes, through its tickets", async () => {
    const term = await makeTerm([
      { label: "Downpayment", pct: "50", trigger: "on_order" },
      { label: "On close", pct: "50", trigger: "on_project_close" },
    ]);
    const order = await makeOrder("100000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);

    const project = await db.project.create({
      data: {
        code: `TEST-PRJ-${randomUUID().slice(0, 8)}`,
        name: "Subscriber fixture",
        accountId: order.accountId,
        status: "in_progress",
        scopeOfWork: "Work.",
      },
    });
    projectIds.push(project.id);
    await makeTicketOn(order, project.id);

    // The payload close-out-service.ts really emits.
    await onProjectClosed({ projectId: project.id, projectCode: project.code });

    const schedule = await getScheduleService(order.id);
    expect(schedule!.milestones[1]!.status).toBe("ready_to_bill");
    expect(schedule!.milestones[1]!.readyReason).toContain(project.code);
  });

  /**
   * §2: "with result accepted". The event fires on a failed commissioning too, and billing on a
   * certificate that says the equipment did not pass is the fastest way to lose a collections
   * argument.
   */
  it("bills on_tc_accepted only when the customer accepted it", async () => {
    const term = await makeTerm([
      { label: "On commissioning", pct: "100", trigger: "on_tc_accepted" },
    ]);
    const order = await makeOrder("50000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    const ticket = await makeTicketOn(order);

    await onTcCompleted({ ticketId: ticket.id, number: "AIESTC-1", result: "rejected" });
    expect((await getScheduleService(order.id))!.milestones[0]!.status).toBe("pending");

    await onTcCompleted({ ticketId: ticket.id, number: "AIESTC-1", result: "accepted" });
    const schedule = await getScheduleService(order.id);
    expect(schedule!.milestones[0]!.status).toBe("ready_to_bill");
    expect(schedule!.milestones[0]!.readyReason).toContain("accepted commissioning");
  });

  it("bills on_dr_signed when somebody signs for the goods, and names them", async () => {
    const term = await makeTerm([{ label: "On signature", pct: "100", trigger: "on_dr_signed" }]);
    const order = await makeOrder("20000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);

    await onDeliveryReceiptSigned({
      salesOrderId: order.id,
      number: "AIESDR-1",
      recipientName: "R. Santos",
    });

    const schedule = await getScheduleService(order.id);
    expect(schedule!.milestones[0]!.status).toBe("ready_to_bill");
    expect(schedule!.milestones[0]!.readyReason).toContain("R. Santos");
  });

  it("bills on_delivery when every deliverable line has moved", async () => {
    const term = await makeTerm([{ label: "On delivery", pct: "100", trigger: "on_delivery" }]);
    const order = await makeOrder("20000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);

    await onGoodsDelivered({ salesOrderId: order.id, salesOrderNumber: order.number });
    expect((await getScheduleService(order.id))!.milestones[0]!.status).toBe("ready_to_bill");
  });

  /**
   * The question that had three answers: `ticket.completed` (never emitted), then
   * `service_report.approved`, then this. The company settled it — QA is where the **customer**
   * signs, and a service report is AIES describing its own work.
   *
   * If somebody "corrects" the trigger back to either earlier answer, this fails rather than the
   * feature going quiet.
   */
  it("bills on_installation when the customer accepts the work at QA", async () => {
    const term = await makeTerm([
      { label: "On installation", pct: "100", trigger: "on_installation" },
    ]);
    const order = await makeOrder("30000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    const ticket = await makeTicketOn(order);

    await onQaPassed({ ticketId: ticket.id, number: "AIESQA-1" });

    const schedule = await getScheduleService(order.id);
    expect(schedule!.milestones[0]!.status).toBe("ready_to_bill");
    expect(schedule!.milestones[0]!.readyReason).toContain("accepted the work at QA");
  });

  it("bills on_supplier_order when the supplier order goes out", async () => {
    const term = await makeTerm([
      { label: "On supplier commitment", pct: "100", trigger: "on_supplier_order" },
    ]);
    const order = await makeOrder("40000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);

    await onSupplierPoSent({ salesOrderId: order.id, number: "AIESSPO-1" });
    expect((await getScheduleService(order.id))!.milestones[0]!.status).toBe("ready_to_bill");
  });

  it("does nothing when the payload carries no order, rather than throwing", async () => {
    await expect(onProjectClosed({})).resolves.toBeUndefined();
    await expect(onDeliveryReceiptSigned({})).resolves.toBeUndefined();
    await expect(onSupplierPoSent({ salesOrderId: null })).resolves.toBeUndefined();
  });
});
