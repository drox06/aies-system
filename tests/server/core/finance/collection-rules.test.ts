import { describe, expect, it } from "vitest";
import {
  REMINDER_OFFSETS_DAYS,
  checkCreditLimit,
  collectionPriority,
  daysOverdue,
  suggestChase,
} from "@/server/core/finance/collection-rules";

/**
 * specs/05-finance-billing.md §5, as pure functions.
 *
 * The cases that matter are the ones where a plausible ordering or a plausible default quietly loses
 * money: ranking by amount alone, chasing somebody who has already promised a date, or a credit
 * limit that blocks so often people raise it until it never bites.
 */

describe("how overdue something is", () => {
  const now = new Date("2026-06-30T00:00:00.000Z");

  it("counts days past the due date", () => {
    expect(daysOverdue("2026-06-20", now)).toBe(10);
  });

  it("is zero for something not yet due, rather than negative", () => {
    expect(daysOverdue("2026-07-20", now)).toBe(0);
  });
});

describe("what to chase first", () => {
  const now = new Date("2026-06-30T00:00:00.000Z");

  /**
   * §5: "sorted by amount × days overdue".
   *
   * Sorting by amount alone puts a huge bill overdue by a day above a small one nobody has chased in
   * four months — but the first is probably in somebody's payment run and the second has been
   * forgotten. The product is peso-days of money not in the bank, which is what is actually being
   * minimised.
   */
  it("ranks a small old debt above a large fresh one", () => {
    const fresh = collectionPriority({ balance: 2_000_000_00, dueDate: "2026-06-29" }, now);
    const old = collectionPriority({ balance: 50_000_00, dueDate: "2026-02-28" }, now);
    expect(old).toBeGreaterThan(fresh);
  });

  it("gives a statement not yet due no priority at all", () => {
    expect(collectionPriority({ balance: 999_999_00, dueDate: "2026-07-30" }, now)).toBe(0);
  });
});

describe("the next move", () => {
  const now = new Date("2026-06-30T00:00:00.000Z");

  it("says to leave alone somebody who has promised a future date", () => {
    const suggestion = suggestChase({
      balance: 100_000,
      dueDate: "2026-06-01",
      promisedDate: "2026-07-15",
      now,
    });
    expect(suggestion.urgent).toBe(false);
    expect(suggestion.action).toMatch(/until the date they promised/);
    expect(suggestion.because).toMatch(/costs goodwill/);
  });

  /**
   * The case people most often miss, because nothing on an ordinary ageing report distinguishes it:
   * a customer who said the 15th and did not pay has changed the situation.
   */
  it("marks a broken promise urgent, and says it is a different conversation", () => {
    const suggestion = suggestChase({
      balance: 100_000,
      dueDate: "2026-06-01",
      promisedDate: "2026-06-15",
      now,
    });
    expect(suggestion.urgent).toBe(true);
    expect(suggestion.action).toMatch(/missed the date/);
    expect(suggestion.because).toMatch(/different conversation/);
  });

  it("flags an old debt nobody has chased at all", () => {
    const suggestion = suggestChase({ balance: 100_000, dueDate: "2026-04-01", now });
    expect(suggestion.urgent).toBe(true);
    expect(suggestion.because).toMatch(/write-off/);
  });

  it("says nothing is needed before the due date", () => {
    const suggestion = suggestChase({ balance: 100_000, dueDate: "2026-07-30", now });
    expect(suggestion.action).toBe("Nothing yet");
  });

  it("waits a few days after a recent contact, then says to chase again", () => {
    expect(
      suggestChase({
        balance: 100_000,
        dueDate: "2026-06-01",
        lastContactAt: "2026-06-28",
        now,
      }).action,
    ).toMatch(/Give it a few days/);

    expect(
      suggestChase({
        balance: 100_000,
        dueDate: "2026-06-01",
        lastContactAt: "2026-06-10",
        now,
      }).action,
    ).toMatch(/Chase again/);
  });
});

describe("the reminder schedule", () => {
  /** §5: "3 days before due, on due date, +7, +15, +30". */
  it("is the five intervals the spec names, in order", () => {
    expect([...REMINDER_OFFSETS_DAYS]).toEqual([-3, 0, 7, 15, 30]);
  });
});

describe("the credit limit", () => {
  it("passes when there is no limit set", () => {
    const check = checkCreditLimit({
      openReceivables: 500_000_00,
      newOrderAmount: 500_000_00,
      creditLimit: null,
    });
    expect(check.ok).toBe(true);
    expect(check.limit).toBeNull();
  });

  it("passes when the exposure fits", () => {
    expect(
      checkCreditLimit({
        openReceivables: 100_000_00,
        newOrderAmount: 100_000_00,
        creditLimit: 500_000_00,
      }).ok,
    ).toBe(true);
  });

  /**
   * Warns rather than blocks by default — see the note on checkCreditLimit. The message names all
   * three numbers, because "over the credit limit" without them is something people learn to click
   * past.
   */
  it("names what is owed, what it would become, and the limit", () => {
    const check = checkCreditLimit({
      openReceivables: 400_000_00,
      newOrderAmount: 200_000_00,
      creditLimit: 500_000_00,
    });
    expect(check.ok).toBe(false);
    expect(check.exposure).toBe(600_000_00);
    expect(check.message).toMatch(/already owes/);
    expect(check.message).toMatch(/credit limit/);
  });
});
