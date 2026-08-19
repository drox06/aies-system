import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  collectionHistoryService,
  collectionWorklistService,
  creditExposureService,
  logCollectionActivityService,
  setRemindersEnabledService,
  sweepCollectionRemindersService,
  sweepOverdueStatementsService,
} from "@/server/core/finance/collection-service";
import {
  issueStatementService,
  raiseStatementService,
} from "@/server/core/finance/invoice-service";

/**
 * specs/05-finance-billing.md §5, against the real database.
 *
 * The property that matters most is the reminder sweep being **idempotent**. A nightly job that
 * finds the +7 reminder due every night from day seven onwards sends the same demand daily, and a
 * customer who receives that stops reading any of them — which costs more than never having chased.
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

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
const daysAhead = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

afterAll(async () => {
  await db.collectionReminder.deleteMany({ where: { statementId: { in: statementIds } } });
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

describe("the reminder sweep", () => {
  /**
   * The property the whole design turns on. Without a recorded row, a nightly job finds the +7
   * reminder due every night from day seven onwards.
   */
  it("schedules each interval once, however many times it runs", async () => {
    const account = await makeAccount();
    const raised = await statement(account.id, 100_000, daysAgo(20));

    const first = await sweepCollectionRemindersService();
    const mine = first.due.filter((row) => row.statementId === raised.id);
    // -3, 0, +7 and +15 have all passed; +30 has not.
    expect(mine.map((row) => row.offsetDays).sort((a, b) => a - b)).toEqual([-3, 0, 7, 15]);

    const second = await sweepCollectionRemindersService();
    expect(second.due.filter((row) => row.statementId === raised.id)).toEqual([]);

    const rows = await db.collectionReminder.findMany({ where: { statementId: raised.id } });
    expect(rows).toHaveLength(4);
  });

  it("does not schedule one whose time has not come", async () => {
    const account = await makeAccount();
    const raised = await statement(account.id, 100_000, daysAhead(30));

    const result = await sweepCollectionRemindersService();
    expect(result.due.filter((row) => row.statementId === raised.id)).toEqual([]);
  });

  /**
   * §5's off switch. Suppression is **recorded** rather than skipped: "we did not chase them, and
   * here is why" is a different fact from "nobody looked", and only one of them is defensible.
   */
  it("records a suppression for an account with reminders switched off", async () => {
    const account = await makeAccount();
    await setRemindersEnabledService(actor, {
      accountId: account.id,
      enabled: false,
      reason: "Handled by phone only at the customer's request.",
    });

    const raised = await statement(account.id, 100_000, daysAgo(20));
    const result = await sweepCollectionRemindersService();

    expect(result.due.filter((row) => row.statementId === raised.id)).toEqual([]);

    const rows = await db.collectionReminder.findMany({ where: { statementId: raised.id } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.suppressedAt !== null)).toBe(true);
    expect(rows[0]!.suppressedReason).toMatch(/switched off/);
  });

  it("insists on a reason before switching reminders off", async () => {
    const account = await makeAccount();
    await expect(
      setRemindersEnabledService(actor, { accountId: account.id, enabled: false, reason: "no" }),
    ).rejects.toThrow(/Say why/);
  });
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
