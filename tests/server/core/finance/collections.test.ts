import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  COLLECTIONS_MATURED_NOTIFICATION_TYPE,
  COLLECTIONS_TIMELINE_MISSED_NOTIFICATION_TYPE,
  COLLECTIONS_TIMELINE_NEEDED_NOTIFICATION_TYPE,
  COLLECTIONS_WEEKLY_NOTIFICATION_TYPE,
  collectionHistoryService,
  collectionWorklistService,
  creditExposureService,
  logCollectionActivityService,
  setExpectedPaymentDateService,
  sweepDunningCycleService,
  sweepOverdueStatementsService,
} from "@/server/core/finance/collection-service";
import {
  DUNNING_CHECKPOINT_DAYS_AFTER_PROMISE,
  DUNNING_GRACE_DAYS,
  DUNNING_WEEKLY_INTERVAL_DAYS,
} from "@/server/core/finance/collection-rules";
import {
  issueStatementService,
  raiseStatementService,
} from "@/server/core/finance/invoice-service";

/**
 * specs/05-finance-billing.md §5, against the real database.
 *
 * docs/DECISIONS.md #188's dunning cycle is the property pure functions cannot prove on their own:
 * that `sweepDunningCycleService` actually creates the `CollectionCycle` row, actually writes real
 * notifications real people would see, and stays idempotent when the same night's sweep runs twice —
 * a nightly job that fires the maturity notice again on every re-run sends the same demand daily,
 * and a customer (or in this case a colleague) who sees that stops reading any of them.
 */

const suffix = randomUUID().slice(0, 8);
const actor = { actorId: `coll-${suffix}`, actorLabel: "Finance officer" };

const accountIds: string[] = [];
const statementIds: string[] = [];

async function makeAccount(over: { creditLimit?: string } = {}) {
  const account = await db.customerAccount.create({
    data: {
      code: `COLL-${randomUUID().slice(0, 12)}`,
      name: `Collections Co ${randomUUID().slice(0, 6)}`,
      ownerId: actor.actorId,
      ...(over.creditLimit ? { creditLimit: over.creditLimit } : {}),
    },
  });
  accountIds.push(account.id);
  return account;
}

/** An issued statement with a due date somewhere in the past or future. */
async function statement(accountId: string, unitPrice: number, dueDate: Date) {
  const raised = await raiseStatementService(actor, {
    accountId,
    dueDate,
    lines: [{ description: "Work done", quantity: 1, unitPrice }],
  });
  statementIds.push(raised.id);
  await issueStatementService(actor, { statementId: raised.id });
  return raised;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const daysAhead = (days: number) => new Date(Date.now() + days * DAY_MS);

/**
 * `sweepDunningCycleService`'s own "still open" half deliberately reads every open `CollectionCycle`
 * row in the database, unscoped — that is exactly what lets a statement paid weeks after it went
 * quiet still get closed on the next real nightly run. In this file that same query means every test
 * that leaves a cycle open gets re-processed, and renotified, by every later test's sweep calls —
 * strictly a test-hygiene problem, not the production design, but one that turns a handful of tests
 * quadratic. Closing the loop after each test keeps the table empty between them.
 */
afterEach(async () => {
  await db.collectionCycle.deleteMany({ where: { statementId: { in: statementIds } } });
});

afterAll(async () => {
  await db.collectionActivity.deleteMany({ where: { statementId: { in: statementIds } } });
  await db.billingStatementLine.deleteMany({ where: { statementId: { in: statementIds } } });
  await db.billingStatement.deleteMany({ where: { id: { in: statementIds } } });
  await db.auditLog.deleteMany({ where: { actorId: actor.actorId } });
  await db.eventOutbox.deleteMany({ where: { actorId: actor.actorId } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("the worklist", () => {
  it("shows overdue statements and leaves out the ones not yet due", async () => {
    const account = await makeAccount();
    const overdue = await statement(account.id, 100_000, daysAgo(20));
    const notYet = await statement(account.id, 100_000, daysAhead(20));

    const rows = await collectionWorklistService({ accountId: account.id });
    const ids = rows.map((row) => row.id);

    expect(ids).toContain(overdue.id);
    expect(ids).not.toContain(notYet.id);
  });

  /** §5: "sorted by amount × days overdue" — peso-days of money not in the bank. */
  it("puts a small old debt above a large fresh one", async () => {
    const account = await makeAccount();
    const fresh = await statement(account.id, 2_000_000_00, daysAgo(1));
    const old = await statement(account.id, 50_000_00, daysAgo(120));

    const rows = await collectionWorklistService({ accountId: account.id });
    expect(rows[0]!.id).toBe(old.id);
    expect(rows.map((row) => row.id)).toContain(fresh.id);
  });

  it("carries the last contact and what was said", async () => {
    const account = await makeAccount();
    const raised = await statement(account.id, 100_000, daysAgo(30));

    await logCollectionActivityService(actor, {
      statementId: raised.id,
      type: "call",
      notes: "Spoke to Marissa in accounts; says the cheque is being signed.",
      outcome: "reached",
    });

    const rows = await collectionWorklistService({ accountId: account.id });
    const row = rows.find((r) => r.id === raised.id)!;

    expect(row.lastContactAt).not.toBeNull();
    expect(row.lastContactType).toBe("call");
    expect(row.lastContactNotes).toMatch(/Marissa/);
    expect(row.suggestion.action).toMatch(/Give it a few days/);
  });

  /**
   * The case an ordinary ageing report cannot show. A promise not yet due means leave them alone; a
   * promise already broken means the next call is a different conversation.
   */
  it("changes its advice once a promised date passes", async () => {
    const account = await makeAccount();
    const raised = await statement(account.id, 100_000, daysAgo(40));

    await logCollectionActivityService(actor, {
      statementId: raised.id,
      type: "call",
      notes: "Promised to pay on the 15th.",
      outcome: "promised",
      promisedDate: daysAhead(10),
    });

    let rows = await collectionWorklistService({ accountId: account.id });
    expect(rows.find((r) => r.id === raised.id)!.suggestion.urgent).toBe(false);

    // The same statement, with the promise now in the past.
    await db.collectionActivity.updateMany({
      where: { statementId: raised.id },
      data: { promisedDate: daysAgo(3) },
    });

    rows = await collectionWorklistService({ accountId: account.id });
    const row = rows.find((r) => r.id === raised.id)!;
    expect(row.suggestion.urgent).toBe(true);
    expect(row.suggestion.action).toMatch(/missed the date/);
  });
});

describe("logging a follow-up", () => {
  it("insists on notes, because a timestamp helps nobody", async () => {
    const account = await makeAccount();
    const raised = await statement(account.id, 100_000, daysAgo(10));

    await expect(
      logCollectionActivityService(actor, { statementId: raised.id, type: "call", notes: "x" }),
    ).rejects.toThrow(/Say what was said/);
  });

  it("keeps the whole history, newest first", async () => {
    const account = await makeAccount();
    const raised = await statement(account.id, 100_000, daysAgo(60));

    await logCollectionActivityService(actor, {
      statementId: raised.id,
      type: "email",
      notes: "First reminder sent.",
      contactedAt: daysAgo(20),
    });
    await logCollectionActivityService(actor, {
      statementId: raised.id,
      type: "call",
      notes: "No answer on the landline.",
      outcome: "no_answer",
      contactedAt: daysAgo(5),
    });

    const history = await collectionHistoryService(raised.id);
    expect(history).toHaveLength(2);
    expect(history[0]!.type).toBe("call");
    expect(history[1]!.notes).toMatch(/First reminder/);
  });
});

describe("docs/DECISIONS.md #188's dunning cycle", () => {
  it("does nothing for a statement not yet due", async () => {
    const account = await makeAccount();
    const raised = await statement(account.id, 100_000, daysAhead(30));

    await sweepDunningCycleService();

    expect(await db.collectionCycle.findUnique({ where: { statementId: raised.id } })).toBeNull();
  }, 60000);

  it("creates the cycle and notifies finance the day a statement matures", async () => {
    const account = await makeAccount();
    const dueDate = new Date();
    const raised = await statement(account.id, 100_000, dueDate);

    const since = new Date();
    await sweepDunningCycleService(dueDate);

    const cycle = await db.collectionCycle.findUniqueOrThrow({
      where: { statementId: raised.id },
    });
    expect(cycle.state).toBe("matured");
    expect(cycle.maturedNotifiedAt).not.toBeNull();

    const notified = await db.notification.count({
      where: { type: COLLECTIONS_MATURED_NOTIFICATION_TYPE, createdAt: { gte: since } },
    });
    expect(notified).toBeGreaterThan(0);
  }, 90000);

  /** The property the whole design turns on: a second sweep on the same night sends nothing twice. */
  it("is idempotent within the same tick", async () => {
    const account = await makeAccount();
    const dueDate = new Date();
    const raised = await statement(account.id, 100_000, dueDate);

    await sweepDunningCycleService(dueDate);
    const afterFirst = await db.collectionCycle.findUniqueOrThrow({
      where: { statementId: raised.id },
    });

    await sweepDunningCycleService(dueDate);
    const afterSecond = await db.collectionCycle.findUniqueOrThrow({
      where: { statementId: raised.id },
    });

    expect(afterSecond.maturedNotifiedAt).toEqual(afterFirst.maturedNotifiedAt);
    expect(afterSecond.state).toBe("matured");
  }, 90000);

  it("moves into weekly dunning once the grace period passes, and back out once paid", async () => {
    const account = await makeAccount();
    const dueDate = new Date();
    const raised = await statement(account.id, 100_000, dueDate);

    await sweepDunningCycleService(dueDate);
    const graceDay = new Date(dueDate.getTime() + DUNNING_GRACE_DAYS * DAY_MS);
    const since = new Date();
    await sweepDunningCycleService(graceDay);

    const cycle = await db.collectionCycle.findUniqueOrThrow({
      where: { statementId: raised.id },
    });
    expect(cycle.state).toBe("dunning");
    expect(cycle.weeklyNotifiedCount).toBe(1);

    const weeklyNotices = await db.notification.count({
      where: { type: COLLECTIONS_WEEKLY_NOTIFICATION_TYPE, createdAt: { gte: since } },
    });
    expect(weeklyNotices).toBeGreaterThan(0);

    // Paid in full — the cycle closes on the next sweep regardless of where it was.
    await db.billingStatement.update({ where: { id: raised.id }, data: { balance: 0 } });
    await sweepDunningCycleService(graceDay);
    const closed = await db.collectionCycle.findUniqueOrThrow({
      where: { statementId: raised.id },
    });
    expect(closed.state).toBe("closed");
    expect(closed.closedAt).not.toBeNull();
  }, 150000);

  it("opens the timeline prompt after the threshold, and the worklist shows it needs one", async () => {
    const account = await makeAccount();
    const dueDate = new Date();
    const raised = await statement(account.id, 100_000, dueDate);

    await sweepDunningCycleService(dueDate);
    const graceDay = new Date(dueDate.getTime() + DUNNING_GRACE_DAYS * DAY_MS);
    await sweepDunningCycleService(graceDay);
    const nextWeek = new Date(graceDay.getTime() + DUNNING_WEEKLY_INTERVAL_DAYS * DAY_MS);
    const since = new Date();
    await sweepDunningCycleService(nextWeek);

    const cycle = await db.collectionCycle.findUniqueOrThrow({
      where: { statementId: raised.id },
    });
    expect(cycle.state).toBe("awaiting_timeline");
    expect(cycle.timelinePromptOpenedAt).not.toBeNull();

    const opened = await db.notification.count({
      where: { type: COLLECTIONS_TIMELINE_NEEDED_NOTIFICATION_TYPE, createdAt: { gte: since } },
    });
    expect(opened).toBeGreaterThan(0);

    const rows = await collectionWorklistService({ accountId: account.id });
    const row = rows.find((r) => r.id === raised.id)!;
    expect(row.cycle?.state).toBe("awaiting_timeline");
    expect(row.cycle?.needsTimeline).toBe(true);
  }, 150000);
});

describe("answering docs/DECISIONS.md #188's 'when is payment expected?' prompt", () => {
  /** Drives a fresh statement to `awaiting_timeline` with no date set yet. */
  async function awaitingTimeline(accountId: string) {
    const dueDate = new Date();
    const raised = await statement(accountId, 100_000, dueDate);
    await sweepDunningCycleService(dueDate);
    const graceDay = new Date(dueDate.getTime() + DUNNING_GRACE_DAYS * DAY_MS);
    await sweepDunningCycleService(graceDay);
    const nextWeek = new Date(graceDay.getTime() + DUNNING_WEEKLY_INTERVAL_DAYS * DAY_MS);
    await sweepDunningCycleService(nextWeek);
    return raised;
  }

  it("refuses a date when nothing is asking for one", async () => {
    const account = await makeAccount();
    const raised = await statement(account.id, 100_000, daysAgo(1));

    await expect(
      setExpectedPaymentDateService(actor, { statementId: raised.id, expectedDate: daysAhead(5) }),
    ).rejects.toThrow(/not currently waiting/);
  }, 30000);

  it("records the date, then refuses a second one for the same round", async () => {
    const account = await makeAccount();
    const raised = await awaitingTimeline(account.id);

    await setExpectedPaymentDateService(actor, {
      statementId: raised.id,
      expectedDate: daysAhead(7),
      notes: "Accounts team says next Friday.",
    });

    const cycle = await db.collectionCycle.findUniqueOrThrow({
      where: { statementId: raised.id },
    });
    expect(cycle.expectedPaymentDate).not.toBeNull();
    expect(cycle.expectedPaymentSetById).toBe(actor.actorId);

    const log = await db.auditLog.findFirst({
      where: { entityId: cycle.id, action: "expected_payment_date_set" },
    });
    expect(log?.summary).toMatch(/Accounts team says next Friday/);

    await expect(
      setExpectedPaymentDateService(actor, {
        statementId: raised.id,
        expectedDate: daysAhead(14),
      }),
    ).rejects.toThrow(/already on file/);
  }, 180000);

  it("refuses a date that has already passed", async () => {
    const account = await makeAccount();
    const raised = await awaitingTimeline(account.id);

    await expect(
      setExpectedPaymentDateService(actor, { statementId: raised.id, expectedDate: daysAgo(2) }),
    ).rejects.toThrow(/has not already passed/);
  }, 150000);

  /** "if no payment prompt is opened again, cycle repeats until payment is received." */
  it("reopens the prompt and counts the miss once a promised date passes unpaid", async () => {
    const account = await makeAccount();
    const raised = await awaitingTimeline(account.id);

    const promised = daysAhead(5);
    await setExpectedPaymentDateService(actor, { statementId: raised.id, expectedDate: promised });

    const checkpoint = new Date(
      promised.getTime() + DUNNING_CHECKPOINT_DAYS_AFTER_PROMISE * DAY_MS,
    );
    const since = new Date();
    await sweepDunningCycleService(checkpoint);

    const cycle = await db.collectionCycle.findUniqueOrThrow({
      where: { statementId: raised.id },
    });
    expect(cycle.state).toBe("awaiting_timeline");
    expect(cycle.expectedPaymentDate).toBeNull();
    expect(cycle.missedDateCount).toBe(1);

    const missed = await db.notification.count({
      where: { type: COLLECTIONS_TIMELINE_MISSED_NOTIFICATION_TYPE, createdAt: { gte: since } },
    });
    expect(missed).toBeGreaterThan(0);

    // The loop closes: a fresh date can be set again for the new round.
    await setExpectedPaymentDateService(actor, {
      statementId: raised.id,
      expectedDate: daysAhead(3),
    });
    const after = await db.collectionCycle.findUniqueOrThrow({
      where: { statementId: raised.id },
    });
    expect(after.expectedPaymentDate).not.toBeNull();
  }, 200000);
});

describe("the overdue sweep", () => {
  it("moves an issued statement to overdue once its date passes", async () => {
    const account = await makeAccount();
    const raised = await statement(account.id, 100_000, daysAgo(2));

    expect((await db.billingStatement.findUniqueOrThrow({ where: { id: raised.id } })).status).toBe(
      "issued",
    );

    await sweepOverdueStatementsService();

    expect((await db.billingStatement.findUniqueOrThrow({ where: { id: raised.id } })).status).toBe(
      "overdue",
    );
  });

  it("leaves one that is not yet due alone", async () => {
    const account = await makeAccount();
    const raised = await statement(account.id, 100_000, daysAhead(10));

    await sweepOverdueStatementsService();

    expect((await db.billingStatement.findUniqueOrThrow({ where: { id: raised.id } })).status).toBe(
      "issued",
    );
  });
});

describe("the credit limit", () => {
  it("adds the new order to what is already open", async () => {
    const account = await makeAccount({ creditLimit: "5000.00" });
    // ₱1,000 + 12% VAT = ₱1,120 outstanding.
    await statement(account.id, 100_000, daysAhead(30));

    const check = await creditExposureService({
      accountId: account.id,
      newOrderAmount: 500_000,
    });

    expect(check.openReceivables).toBe(112_000);
    expect(check.exposure).toBe(612_000);
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/already owes/);
  });

  it("passes when no limit is set, rather than inventing one", async () => {
    const account = await makeAccount();
    const check = await creditExposureService({
      accountId: account.id,
      newOrderAmount: 100_000_00,
    });
    expect(check.ok).toBe(true);
    expect(check.limit).toBeNull();
  });
});
