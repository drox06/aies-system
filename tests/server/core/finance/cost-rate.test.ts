import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  costRatesService,
  setCostRateService,
  uncostedDaysService,
} from "@/server/core/finance/cost-rate-service";

/**
 * §6's cost rates.
 *
 * These exist because the table did not have a service at all until 2026-08-20 — §6's P&L priced
 * labour from it, reported *"N days with no rate"* when it found none, and nothing on earth could
 * answer that. docs/DECISIONS.md #133.
 *
 * What is worth pinning here is **not** the arithmetic — `rateOn` and `timesheetCost` are pure and
 * already covered in project-pnl.test.ts. It is the three decisions this service makes that a future
 * change could quietly reverse:
 *
 *   1. A second rate on the same start date **replaces**; a rate on a later date **accumulates**.
 *   2. A multiplier below 1 is refused, because overtime cheaper than ordinary time is a typo that
 *      understates exactly the jobs that ran long.
 *   3. Somebody with no rate is reported as **no rate**, not as zero.
 */

const suffix = randomUUID().slice(0, 8);
const actor = { actorId: `cr-${suffix}`, actorLabel: "Cost Rate Test" };

const userIds: string[] = [];
const rateIds: string[] = [];
const timesheetIds: string[] = [];

async function makePerson(name: string) {
  const user = await db.user.create({
    data: {
      email: `cr-${randomUUID().slice(0, 8)}@example.invalid`,
      name,
      passwordHash: "not-a-real-hash",
    },
  });
  userIds.push(user.id);
  return user;
}

afterAll(async () => {
  // Tracked at the point of creation, not listed by hand at the bottom of the file — an untracked
  // id does not leak one record, it aborts the cleanup and leaks everything below it.
  // docs/DECISIONS.md #132.
  await db.timesheet.deleteMany({ where: { id: { in: timesheetIds } } });
  await db.costRate.deleteMany({ where: { userId: { in: userIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: rateIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("setting a rate", () => {
  it("keeps a later rate alongside the earlier one, so past jobs keep their figures", async () => {
    const person = await makePerson(`Rates ${suffix}`);

    const first = await setCostRateService(actor, {
      userId: person.id,
      effectiveFrom: new Date("2025-01-01"),
      hourlyCost: 200,
    });
    rateIds.push(first.id);
    expect(first.replaced).toBe(false);

    const second = await setCostRateService(actor, {
      userId: person.id,
      effectiveFrom: new Date("2026-01-01"),
      hourlyCost: 260,
    });
    rateIds.push(second.id);
    expect(second.replaced).toBe(false);

    const rows = await costRatesService();
    const mine = rows.find((row) => row.userId === person.id);

    // Both on the record. A rise must not rewrite what last year's jobs cost.
    expect(mine?.history).toHaveLength(2);
    expect(Number(mine?.current?.hourlyCost)).toBe(260);
  }, 60_000);

  it("replaces rather than accumulates when the same start date is used twice", async () => {
    const person = await makePerson(`Correction ${suffix}`);

    const first = await setCostRateService(actor, {
      userId: person.id,
      effectiveFrom: new Date("2025-06-01"),
      hourlyCost: 200,
    });
    rateIds.push(first.id);

    // A second row for the same day is somebody fixing a typo, not a second rise — and the schema's
    // unique constraint says so. If this ever starts creating a row, the constraint will throw and
    // the failure will look like a database error rather than a design decision being reversed.
    const corrected = await setCostRateService(actor, {
      userId: person.id,
      effectiveFrom: new Date("2025-06-01"),
      hourlyCost: 210,
    });
    expect(corrected.replaced).toBe(true);
    expect(corrected.id).toBe(first.id);

    const rows = await costRatesService();
    const mine = rows.find((row) => row.userId === person.id);
    expect(mine?.history).toHaveLength(1);
    expect(Number(mine?.current?.hourlyCost)).toBe(210);
  }, 60_000);

  it("refuses a multiplier that makes overtime cheaper than ordinary time", async () => {
    const person = await makePerson(`Multiplier ${suffix}`);

    await expect(
      setCostRateService(actor, {
        userId: person.id,
        effectiveFrom: new Date("2025-01-01"),
        hourlyCost: 200,
        // A decimal in the wrong place. Accepting it would understate the cost of every job that
        // ran long — precisely the jobs §6 exists to find.
        overtimeMultiplier: 0.125,
      }),
    ).rejects.toThrow(/cheaper than ordinary time/);
  }, 60_000);

  it("refuses an hour that costs less than nothing", async () => {
    const person = await makePerson(`Negative ${suffix}`);

    await expect(
      setCostRateService(actor, {
        userId: person.id,
        effectiveFrom: new Date("2025-01-01"),
        hourlyCost: -50,
      }),
    ).rejects.toThrow(/less than nothing/);
  }, 60_000);

  it("reports somebody with no rate as having none, not as zero", async () => {
    const person = await makePerson(`Unset ${suffix}`);

    const rows = await costRatesService();
    const mine = rows.find((row) => row.userId === person.id);

    /*
      Null, not 0. A rate of zero is a real statement — an unpaid director — and it is not the same
      as nobody having decided. Collapsing them would make the P&L's "uncosted" caveat look like a
      contradiction of the screen it sends people to.
    */
    expect(mine).toBeTruthy();
    expect(mine?.current).toBeNull();
  }, 60_000);
});

describe("which days cannot be priced", () => {
  it("counts the approved days with no rate in force, and the earliest of them", async () => {
    const person = await makePerson(`Uncosted ${suffix}`);

    const days = [new Date("2026-03-02"), new Date("2026-03-03"), new Date("2026-03-04")];
    for (const date of days) {
      const sheet = await db.timesheet.create({
        data: {
          userId: person.id,
          date,
          regularHours: "8",
          status: "approved",
          approvedById: actor.actorId,
          approvedAt: new Date(),
        },
      });
      timesheetIds.push(sheet.id);
    }

    const before = await uncostedDaysService();
    const mine = before.find((row) => row.userId === person.id);
    expect(mine?.days).toBe(3);
    // The earliest decides the start date of the fix. A rate entered from today would leave all
    // three still uncosted, which is the mistake this figure exists to prevent.
    expect(mine?.earliestDay.toISOString().slice(0, 10)).toBe("2026-03-02");

    const rate = await setCostRateService(actor, {
      userId: person.id,
      effectiveFrom: new Date("2026-03-01"),
      hourlyCost: 300,
    });
    rateIds.push(rate.id);

    const after = await uncostedDaysService();
    expect(after.find((row) => row.userId === person.id)).toBeUndefined();
  }, 60_000);

  it("still counts a day worked before the rate started", async () => {
    const person = await makePerson(`Backdate ${suffix}`);

    const early = await db.timesheet.create({
      data: {
        userId: person.id,
        date: new Date("2026-02-10"),
        regularHours: "8",
        status: "approved",
        approvedById: actor.actorId,
        approvedAt: new Date(),
      },
    });
    timesheetIds.push(early.id);

    // Deliberately starting after the day worked — the exact mistake somebody makes when they
    // cannot see how far back the gap runs.
    const rate = await setCostRateService(actor, {
      userId: person.id,
      effectiveFrom: new Date("2026-05-01"),
      hourlyCost: 300,
    });
    rateIds.push(rate.id);

    const rows = await uncostedDaysService();
    expect(rows.find((row) => row.userId === person.id)?.days).toBe(1);
  }, 60_000);

  it("ignores timesheets nobody has approved", async () => {
    const person = await makePerson(`Draft ${suffix}`);

    const draft = await db.timesheet.create({
      data: {
        userId: person.id,
        date: new Date("2026-04-01"),
        regularHours: "8",
        status: "draft",
      },
    });
    timesheetIds.push(draft.id);

    /*
      §6 counts only approved timesheets as cost, so an unapproved day is not a day that "cannot be
      priced" — it is a day that is not a cost yet. Counting it here would send somebody to enter a
      rate for hours that may never be approved, and the count would not go down when they did.
    */
    const rows = await uncostedDaysService();
    expect(rows.find((row) => row.userId === person.id)).toBeUndefined();
  }, 60_000);
});
