import { describe, expect, it } from "vitest";
import {
  DUNNING_CHECKPOINT_DAYS_AFTER_PROMISE,
  DUNNING_GRACE_DAYS,
  DUNNING_WEEKLY_INTERVAL_DAYS,
  advanceDunningCycle,
  checkCreditLimit,
  collectionPriority,
  daysOverdue,
  suggestChase,
  type CollectionCycleSnapshot,
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

describe("docs/DECISIONS.md #188's dunning cycle", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const dueDate = new Date("2026-06-01T00:00:00.000Z");

  const CLEAR: CollectionCycleSnapshot = {
    state: "matured",
    dueDate,
    balance: 100_000,
    maturedNotifiedAt: null,
    weeklyNotifiedCount: 0,
    lastWeeklyNotifiedAt: null,
    expectedPaymentDate: null,
    lastEscalationNotifiedAt: null,
    missedDateCount: 0,
  };

  /** "until payment is received" overrides every other rule, at any stage. */
  it("closes the moment the balance reaches zero, regardless of state", () => {
    for (const state of ["matured", "dunning", "awaiting_timeline"] as const) {
      expect(advanceDunningCycle({ ...CLEAR, state, balance: 0 }, dueDate)).toEqual({
        action: "close",
      });
    }
  });

  it("does nothing more once closed", () => {
    expect(advanceDunningCycle({ ...CLEAR, state: "closed" }, dueDate)).toEqual({
      action: "none",
    });
  });

  describe("matured: EA's 'finance is notified upon maturity'", () => {
    it("notifies the moment it matures, before anything else happens", () => {
      expect(advanceDunningCycle(CLEAR, dueDate)).toEqual({ action: "notify_matured" });
    });

    it("waits out the five-day grace period once notified", () => {
      const notified = { ...CLEAR, maturedNotifiedAt: dueDate };
      const day4 = new Date(dueDate.getTime() + 4 * DAY_MS);
      expect(advanceDunningCycle(notified, day4)).toEqual({ action: "none" });

      const day5 = new Date(dueDate.getTime() + DUNNING_GRACE_DAYS * DAY_MS);
      expect(advanceDunningCycle(notified, day5)).toEqual({ action: "start_dunning_and_notify" });
    });
  });

  describe("dunning: 'notification is sent every week until payment is received'", () => {
    const started = {
      ...CLEAR,
      state: "dunning" as const,
      maturedNotifiedAt: dueDate,
      weeklyNotifiedCount: 1,
      lastWeeklyNotifiedAt: new Date(dueDate.getTime() + DUNNING_GRACE_DAYS * DAY_MS),
    };

    it("waits out the week between reminders", () => {
      const day3 = new Date(started.lastWeeklyNotifiedAt.getTime() + 3 * DAY_MS);
      expect(advanceDunningCycle(started, day3)).toEqual({ action: "none" });
    });

    /**
     * The threshold is 2, and the first reminder was the one that started dunning — so the very
     * next weekly check is already the second, and EA's own rule fires: the notice that reaches the
     * threshold *is* the moment the prompt opens, not a third, separate message.
     */
    it("opens the timeline prompt on the reminder that reaches the threshold", () => {
      const nextWeek = new Date(
        started.lastWeeklyNotifiedAt.getTime() + DUNNING_WEEKLY_INTERVAL_DAYS * DAY_MS,
      );
      expect(advanceDunningCycle(started, nextWeek)).toEqual({ action: "open_timeline_prompt" });
    });

    /**
     * Exercised directly against the general mechanism (an unreached count in the deployed
     * schedule, since the threshold is 2 and the first reminder already happens on entry) — proving
     * `send_weekly_notice` fires correctly if the threshold is ever loosened, not merely that today's
     * exact numbers happen to skip past it.
     */
    it("sends an ordinary weekly notice below the threshold", () => {
      const belowThreshold = { ...started, weeklyNotifiedCount: 0 };
      const nextWeek = new Date(
        belowThreshold.lastWeeklyNotifiedAt.getTime() + DUNNING_WEEKLY_INTERVAL_DAYS * DAY_MS,
      );
      expect(advanceDunningCycle(belowThreshold, nextWeek)).toEqual({
        action: "send_weekly_notice",
        count: 1,
      });
    });
  });

  describe("awaiting_timeline: 'a when is payment expected prompt, which is filled by admin'", () => {
    const opened = {
      ...CLEAR,
      state: "awaiting_timeline" as const,
      weeklyNotifiedCount: 2,
      timelinePromptOpenedAt: dueDate,
    };

    it("escalates once a day while nobody has answered", () => {
      expect(advanceDunningCycle(opened, dueDate)).toEqual({
        action: "escalate_unfilled_timeline",
      });

      const sameDayLater = new Date(dueDate.getTime() + 6 * 60 * 60 * 1000);
      expect(
        advanceDunningCycle({ ...opened, lastEscalationNotifiedAt: dueDate }, sameDayLater),
      ).toEqual({ action: "none" });

      const nextDay = new Date(dueDate.getTime() + DAY_MS);
      expect(
        advanceDunningCycle({ ...opened, lastEscalationNotifiedAt: dueDate }, nextDay),
      ).toEqual({ action: "escalate_unfilled_timeline" });
    });

    it("waits until two days past a set date before checking it", () => {
      const promised = new Date("2026-07-01T00:00:00.000Z");
      const withDate = { ...opened, expectedPaymentDate: promised };

      const dayAfter = new Date(promised.getTime() + DAY_MS);
      expect(advanceDunningCycle(withDate, dayAfter)).toEqual({ action: "none" });

      const checkpoint = new Date(
        promised.getTime() + DUNNING_CHECKPOINT_DAYS_AFTER_PROMISE * DAY_MS,
      );
      expect(advanceDunningCycle(withDate, checkpoint)).toEqual({
        action: "record_missed_date_and_reopen",
        missedCount: 1,
      });
    });

    /** "if no payment prompt is opened again, cycle repeats until payment is received." */
    it("counts up missed dates across repeated rounds", () => {
      const promised = new Date("2026-07-01T00:00:00.000Z");
      const secondRound = { ...opened, expectedPaymentDate: promised, missedDateCount: 3 };
      const checkpoint = new Date(
        promised.getTime() + DUNNING_CHECKPOINT_DAYS_AFTER_PROMISE * DAY_MS,
      );
      expect(advanceDunningCycle(secondRound, checkpoint)).toEqual({
        action: "record_missed_date_and_reopen",
        missedCount: 4,
      });
    });
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
