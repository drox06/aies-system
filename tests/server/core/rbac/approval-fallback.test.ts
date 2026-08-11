import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetHolidayProvider, setHolidayProvider } from "@/server/core/calendar/business-days";
import {
  isFallbackDecision,
  resolveApprovalFallback,
  type ApprovalRuleConfig,
} from "@/server/core/rbac/approval-fallback";

/**
 * Spec.md §4.4's automatic fallback.
 *
 * **The window counts working hours.** That is the whole reason this file pins a calendar: every
 * assertion below would pass or fail differently depending on which day of the week the test
 * happened to run, and a fallback that activates over a weekend is the exact failure §4.4 is
 * written to avoid — the President would inherit a decision before anybody had a working hour to
 * make it.
 *
 * Dates are chosen deliberately, in Manila (UTC+8), and named in the tests:
 *   Fri 2026-08-07 · Sat 2026-08-08 · Sun 2026-08-09 · Mon 2026-08-10
 */

const cashAdvanceRule: ApprovalRuleConfig = {
  primaryApproverRole: "vice_president",
  fallbackApproverRole: "president",
  escalateAfterHours: 4,
};

const quotationRule: ApprovalRuleConfig = {
  primaryApproverRole: "vice_president",
  fallbackApproverRole: "president",
  escalateAfterHours: 24,
};

/** Manila local time as a UTC instant. Manila is a fixed UTC+8. */
const manila = (isoLocal: string) => new Date(`${isoLocal}+08:00`);

beforeAll(() => {
  // No holidays in the test window, so weekends are the only non-working days and each assertion
  // isolates one thing.
  setHolidayProvider(() => false);
});
afterAll(() => resetHolidayProvider());

describe("resolveApprovalFallback", () => {
  it("before the window elapses, only the VP sees it in their inbox", () => {
    const requestedAt = manila("2026-08-10T08:00:00"); // Monday
    const now = manila("2026-08-10T10:00:00"); // 2 working hours later, window is 4

    const result = resolveApprovalFallback(cashAdvanceRule, requestedAt, now);

    expect(result.isFallbackWindowElapsed).toBe(false);
    expect(result.inboxRoles).toEqual(["vice_president"]);
  });

  it("after the window elapses, it appears in the president's inbox too", () => {
    const requestedAt = manila("2026-08-10T08:00:00"); // Monday
    const now = manila("2026-08-10T12:30:00"); // 4.5 working hours later

    const result = resolveApprovalFallback(cashAdvanceRule, requestedAt, now);

    expect(result.isFallbackWindowElapsed).toBe(true);
    expect(result.inboxRoles).toEqual(["vice_president", "president"]);
    expect(result.elapsedHours).toBeCloseTo(4.5, 5);
  });

  it("the president can always act immediately, before the window elapses", () => {
    const requestedAt = manila("2026-08-10T08:00:00");
    const now = manila("2026-08-10T08:05:00");

    const result = resolveApprovalFallback(cashAdvanceRule, requestedAt, now);

    expect(result.isFallbackWindowElapsed).toBe(false);
    expect(result.eligibleToDecideRoles).toContain("president");
  });

  it("the VP's inbox still lists the request after fallback activates (it is not a handoff)", () => {
    const requestedAt = manila("2026-08-10T08:00:00");
    const now = manila("2026-08-10T13:00:00");

    expect(resolveApprovalFallback(cashAdvanceRule, requestedAt, now).inboxRoles).toContain(
      "vice_president",
    );
  });
});

describe("the window counts working hours, not wall-clock hours", () => {
  it("does not escalate across a weekend", () => {
    // Submitted Friday 17:00; by Sunday evening 50 wall-clock hours have passed and the old
    // wall-clock reading would have escalated a quotation nobody could have looked at.
    const friday = manila("2026-08-07T17:00:00");
    const sundayEvening = manila("2026-08-09T19:00:00");

    const result = resolveApprovalFallback(quotationRule, friday, sundayEvening);

    expect(result.isFallbackWindowElapsed).toBe(false);
    // Only Friday 17:00-24:00 counts: Saturday and Sunday are not working days.
    expect(result.elapsedHours).toBeCloseTo(7, 5);
  });

  it("resumes on Monday and escalates once a real working day has been spent", () => {
    const friday = manila("2026-08-07T17:00:00");
    // 7 working hours from Friday + 17 from Monday 00:00 = 24, reached at Monday 17:00.
    const mondayFivePm = manila("2026-08-10T17:00:00");

    const result = resolveApprovalFallback(quotationRule, friday, mondayFivePm);

    expect(result.elapsedHours).toBeCloseTo(24, 5);
    expect(result.isFallbackWindowElapsed).toBe(true);
  });

  it("says when the window will elapse, so a queue need not do the arithmetic", () => {
    const friday = manila("2026-08-07T17:00:00");

    const result = resolveApprovalFallback(quotationRule, friday, friday);

    expect(result.isFallbackWindowElapsed).toBe(false);
    expect(result.fallbackAvailableAt.toISOString()).toBe(
      manila("2026-08-10T17:00:00").toISOString(),
    );
  });

  it("skips a holiday the same way it skips a weekend", () => {
    // Rizal Day, a fixed regular holiday, on a Wednesday in 2026.
    setHolidayProvider((isoDate) => isoDate === "2026-12-30");
    try {
      const tuesdayEvening = manila("2026-12-29T18:00:00");
      const thursdayMorning = manila("2026-12-31T06:00:00");

      const result = resolveApprovalFallback(quotationRule, tuesdayEvening, thursdayMorning);

      // Tuesday 18:00-24:00 = 6, all of Wednesday skipped, Thursday 00:00-06:00 = 6.
      expect(result.elapsedHours).toBeCloseTo(12, 5);
      expect(result.isFallbackWindowElapsed).toBe(false);
    } finally {
      setHolidayProvider(() => false);
    }
  });
});

describe("isFallbackDecision", () => {
  it("a VP decision is not a fallback", () => {
    expect(isFallbackDecision("vice_president", cashAdvanceRule)).toBe(false);
  });

  it("a president decision is a fallback, regardless of timing", () => {
    expect(isFallbackDecision("president", cashAdvanceRule)).toBe(true);
  });

  it("an unrelated role deciding is not classified as a fallback for this rule", () => {
    expect(isFallbackDecision("operations_manager", cashAdvanceRule)).toBe(false);
  });
});
