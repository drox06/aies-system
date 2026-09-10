import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  askMilestoneReadinessService,
  billingReadinessForOrderService,
  declareMilestoneReadyService,
  generateScheduleService,
  getScheduleService,
  replyMilestoneReadinessService,
} from "@/server/core/finance/billing-service";

/**
 * docs/DECISIONS.md #185 — the finance/operations "are we ready to bill this?" exchange terms 4
 * through 6 need, since their balances are `manual` on purpose rather than wired to an automatic
 * trigger (EA's own words: "the installation balance when operations confirms the work is actually
 * done"). docs/DECISIONS.md #205 adds the exchange's other direction: Operations volunteering
 * readiness before finance thinks to ask.
 *
 * What only a real run settles:
 *
 *  1. **`replyMilestoneReadinessService` still has a direction.** Operations cannot *reply* to a
 *     question finance never asked through that specific function — `declareMilestoneReadyService`
 *     is the deliberate, separate door for going first, not a loosening of this one.
 *  2. **"We can bill this" is exactly a release, not a second mechanism that happens to agree with
 *     one.** Both the reply path and the declare path go through `releaseMilestoneService` directly,
 *     so anything true of a release (the race guard, the notification to finance) is true of either.
 *  3. **term 3 is not part of this exchange.** `autoRaiseOnRelease` releases on finance's own
 *     say-so; asking operations about it would be asking the wrong department.
 */

const suffix = randomUUID().slice(0, 8);
const actor = { actorId: `fin-rdy-${suffix}`, actorLabel: "Finance officer" };
const ops = { actorId: `ops-rdy-${suffix}`, actorLabel: "Operations manager" };

const accountIds: string[] = [];
const orderIds: string[] = [];
const termIds: string[] = [];
const scheduleIds: string[] = [];
const quotationIds: string[] = [];
const poIds: string[] = [];
const fileIds: string[] = [];

async function makeTerm(milestones: unknown[]) {
  const term = await db.paymentTerm.create({
    data: {
      name: `Test readiness term ${randomUUID().slice(0, 8)}`,
      netDays: 15,
      milestones: milestones as object[],
      isActive: true,
    },
  });
  termIds.push(term.id);
  return term;
}

async function makeOrder(totalPesos: string, paymentTermsId: string) {
  const account = await db.customerAccount.create({
    data: {
      code: `FINRDY-${randomUUID().slice(0, 12)}`,
      name: `Readiness Co ${suffix}`,
      ownerId: actor.actorId,
    },
  });
  accountIds.push(account.id);

  const quotation = await db.quotation.create({
    data: {
      number: `TEST-LQ-${randomUUID().slice(0, 10)}`,
      accountId: account.id,
      title: "Readiness fixture",
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
  // docs/DECISIONS.md #205's own test is the first in this file to actually trip
  // `autoRaiseOnRelease`, so it's the first to leave a real BillingStatement behind.
  const statements = await db.billingStatement.findMany({
    where: { salesOrderId: { in: orderIds } },
    select: { id: true },
  });
  const statementIds = statements.map((s) => s.id);
  await db.billingStatementLine.deleteMany({ where: { statementId: { in: statementIds } } });
  await db.billingStatement.deleteMany({ where: { id: { in: statementIds } } });
  await db.billingMilestone.deleteMany({ where: { salesOrderId: { in: orderIds } } });
  await db.billingSchedule.deleteMany({ where: { salesOrderId: { in: orderIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: [...scheduleIds, ...orderIds] } } });
  await db.eventOutbox.deleteMany({ where: { actorId: { in: [actor.actorId, ops.actorId] } } });
  await db.salesOrder.deleteMany({ where: { id: { in: orderIds } } });
  await db.customerPO.deleteMany({ where: { id: { in: poIds } } });
  await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.paymentTerm.deleteMany({ where: { id: { in: termIds } } });
});

describe("finance asking whether a milestone is ready to bill", () => {
  it("refuses a milestone whose trigger is not manual", async () => {
    const term = await makeTerm([{ label: "All", pct: "100", trigger: "on_order" }]);
    const order = await makeOrder("10000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    const schedule = await getScheduleService(order.id);

    await expect(
      askMilestoneReadinessService(actor, { milestoneId: schedule!.milestones[0]!.id }),
    ).rejects.toThrow(/nothing to ask about/);
  });

  it("refuses the auto-raise milestone — there is nobody to ask", async () => {
    const term = await makeTerm([
      { label: "Full amount", pct: "100", trigger: "manual", autoRaiseOnRelease: true },
    ]);
    const order = await makeOrder("10000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    const schedule = await getScheduleService(order.id);

    await expect(
      askMilestoneReadinessService(actor, { milestoneId: schedule!.milestones[0]!.id }),
    ).rejects.toThrow(/nobody to ask/);
  });

  it("refuses a milestone that is not pending", async () => {
    const term = await makeTerm([{ label: "Installation balance", pct: "100", trigger: "manual" }]);
    const order = await makeOrder("10000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    const schedule = await getScheduleService(order.id);
    const milestoneId = schedule!.milestones[0]!.id;

    await askMilestoneReadinessService(actor, { milestoneId });
    await replyMilestoneReadinessService(ops, { milestoneId, accomplished: true });

    await expect(askMilestoneReadinessService(actor, { milestoneId })).rejects.toThrow(/already/);
  });

  it("marks the ask, and the milestone shows up on operations' list", async () => {
    const term = await makeTerm([{ label: "Installation balance", pct: "100", trigger: "manual" }]);
    const order = await makeOrder("10000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    const schedule = await getScheduleService(order.id);
    const milestoneId = schedule!.milestones[0]!.id;

    // docs/DECISIONS.md #205: the milestone is already on the list, unasked — that is the point of
    // widening this query. What the ask actually changes is `readinessAskedAt`.
    const before = await billingReadinessForOrderService(order.id);
    expect(before).toHaveLength(1);
    expect(before[0]!.readinessAskedAt).toBeNull();

    await askMilestoneReadinessService(actor, { milestoneId });

    const readiness = await billingReadinessForOrderService(order.id);
    expect(readiness).toHaveLength(1);
    expect(readiness[0]!.label).toBe("Installation balance");
    expect(readiness[0]!.readinessAskedAt).not.toBeNull();
  });
});

describe("operations answering the ask", () => {
  it("refuses a reply when nobody has asked", async () => {
    const term = await makeTerm([{ label: "Balance", pct: "100", trigger: "manual" }]);
    const order = await makeOrder("10000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    const schedule = await getScheduleService(order.id);

    await expect(
      replyMilestoneReadinessService(ops, {
        milestoneId: schedule!.milestones[0]!.id,
        accomplished: true,
      }),
    ).rejects.toThrow(/nobody at finance has asked/i);
  });

  /**
   * "We can bill this" is exactly `releaseMilestoneService` — same guard, same notification to
   * finance, same "not auto-raised, since only term 3 sets that flag" outcome.
   */
  it("releases the milestone when the answer is accomplished", async () => {
    const term = await makeTerm([{ label: "Installation balance", pct: "100", trigger: "manual" }]);
    const order = await makeOrder("50000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    const schedule = await getScheduleService(order.id);
    const milestoneId = schedule!.milestones[0]!.id;

    await askMilestoneReadinessService(actor, { milestoneId });
    const released = (await replyMilestoneReadinessService(ops, {
      milestoneId,
      accomplished: true,
    })) as { statement: unknown };
    expect(released.statement).toBeNull();

    const after = await getScheduleService(order.id);
    expect(after!.milestones[0]!.status).toBe("ready_to_bill");

    // Answered — no longer awaiting a reply, so it drops off operations' list.
    expect(await billingReadinessForOrderService(order.id)).toEqual([]);
  });

  it("insists on both a percentage and a date together for 'not yet'", async () => {
    const term = await makeTerm([{ label: "Balance", pct: "100", trigger: "manual" }]);
    const order = await makeOrder("10000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    const schedule = await getScheduleService(order.id);
    const milestoneId = schedule!.milestones[0]!.id;
    await askMilestoneReadinessService(actor, { milestoneId });

    await expect(
      replyMilestoneReadinessService(ops, {
        milestoneId,
        accomplished: false,
        percentComplete: 50,
      }),
    ).rejects.toThrow(/say how much is done/i);

    await expect(
      replyMilestoneReadinessService(ops, {
        milestoneId,
        accomplished: false,
        percentComplete: 140,
        estimatedDate: new Date(),
      }),
    ).rejects.toThrow(/0 to 100/);
  });

  it("records 'not yet', leaving the milestone pending and back on the ask list", async () => {
    const term = await makeTerm([{ label: "Balance", pct: "100", trigger: "manual" }]);
    const order = await makeOrder("10000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    const schedule = await getScheduleService(order.id);
    const milestoneId = schedule!.milestones[0]!.id;
    await askMilestoneReadinessService(actor, { milestoneId });

    const estimatedDate = new Date("2026-11-01T00:00:00.000Z");
    const replied = (await replyMilestoneReadinessService(ops, {
      milestoneId,
      accomplished: false,
      percentComplete: 60,
      estimatedDate,
      notes: "Waiting on a part.",
    })) as { milestone: { status: string } };
    expect(replied.milestone.status).toBe("pending");

    const readiness = await billingReadinessForOrderService(order.id);
    expect(readiness).toHaveLength(1);
    expect(readiness[0]!.readinessPercentComplete).toBe("60");
    expect(readiness[0]!.readinessEstimatedDate).toEqual(estimatedDate);
    expect(readiness[0]!.readinessNotes).toBe("Waiting on a part.");

    // A second "not yet" without a fresh ask is refused — the exchange has a direction.
    await expect(
      replyMilestoneReadinessService(ops, {
        milestoneId,
        accomplished: false,
        percentComplete: 70,
        estimatedDate,
      }),
    ).rejects.toThrow(/nobody at finance has asked/i);

    // Finance asks again; now operations can answer "accomplished".
    await askMilestoneReadinessService(actor, { milestoneId });
    const released = (await replyMilestoneReadinessService(ops, {
      milestoneId,
      accomplished: true,
    })) as { statement: unknown };
    expect(released.statement).toBeNull();
    expect((await getScheduleService(order.id))!.milestones[0]!.status).toBe("ready_to_bill");
  }, 40000);
});

describe("docs/DECISIONS.md #205: operations declaring readiness without being asked", () => {
  it("shows up on operations' list before finance has asked anything", async () => {
    const term = await makeTerm([{ label: "Installation balance", pct: "100", trigger: "manual" }]);
    const order = await makeOrder("10000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    const schedule = await getScheduleService(order.id);

    const readiness = await billingReadinessForOrderService(order.id);
    expect(readiness).toHaveLength(1);
    expect(readiness[0]!.id).toBe(schedule!.milestones[0]!.id);
    expect(readiness[0]!.readinessAskedAt).toBeNull();
  });

  it("releases the milestone exactly like an accomplished reply would, unprompted", async () => {
    const term = await makeTerm([{ label: "Installation balance", pct: "100", trigger: "manual" }]);
    const order = await makeOrder("50000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    const schedule = await getScheduleService(order.id);
    const milestoneId = schedule!.milestones[0]!.id;

    const declared = (await declareMilestoneReadyService(ops, { milestoneId })) as {
      statement: unknown;
    };
    expect(declared.statement).toBeNull();

    const after = await getScheduleService(order.id);
    expect(after!.milestones[0]!.status).toBe("ready_to_bill");
    expect(after!.milestones[0]!.readinessAskedAt).toBeNull();

    // Released — drops off the list either way, the same as an answered ask does.
    expect(await billingReadinessForOrderService(order.id)).toEqual([]);
  });

  /**
   * `declareMilestoneReadyService` is a thin call onto `releaseMilestoneService` — this proves the
   * delegation is real rather than a parallel implementation that could drift from it, by checking
   * for a behaviour `declareMilestoneReadyService` itself does nothing to produce: `autoRaiseOnRelease`
   * issuing a statement in the same act.
   */
  it("auto-raises a statement too, exactly as a manual release would", async () => {
    const term = await makeTerm([
      { label: "Full payment", pct: "100", trigger: "manual", autoRaiseOnRelease: true },
    ]);
    const order = await makeOrder("10000.00", term.id);
    const result = await generateScheduleService(actor, { salesOrderId: order.id });
    scheduleIds.push(result.scheduleId);
    const schedule = await getScheduleService(order.id);

    const declared = (await declareMilestoneReadyService(ops, {
      milestoneId: schedule!.milestones[0]!.id,
    })) as { statement: { id: string; number: string } | null };
    expect(declared.statement).not.toBeNull();
    expect(declared.statement!.number).toMatch(/^AIESBS-/);
  });
});
