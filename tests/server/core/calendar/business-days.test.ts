import { afterEach, describe, expect, it } from "vitest";
import {
  addBusinessDays,
  addBusinessMs,
  businessMsBetween,
  BUSINESS_DAY_MS,
  isWorkingDay,
  resetHolidayProvider,
  setHolidayProvider,
} from "@/server/core/calendar/business-days";

/**
 * The working calendar underneath specs/01-crm-inquiry.md §3's SLA.
 *
 * Every instant here is written in UTC with the Manila local time named in the comment, because
 * that is where this can go wrong: 2026-08-08T16:00:00Z is already Sunday the 9th in Manila, and a
 * calendar that reads it as Saturday would hand back a whole extra working day of SLA budget.
 */

afterEach(() => resetHolidayProvider());

describe("isWorkingDay", () => {
  it("treats the Manila calendar day as authoritative, not the UTC one", () => {
    // 16:00Z on Friday 7 Aug 2026 is 00:00 Saturday in Manila. UTC says working day; Manila does
    // not, and Manila is the one the customer lives in.
    expect(isWorkingDay(new Date("2026-08-07T15:59:00Z"))).toBe(true); // Fri 23:59 Manila
    expect(isWorkingDay(new Date("2026-08-07T16:00:00Z"))).toBe(false); // Sat 00:00 Manila
  });

  it("excludes weekends", () => {
    expect(isWorkingDay(new Date("2026-08-08T02:00:00Z"))).toBe(false); // Sat 10:00 Manila
    expect(isWorkingDay(new Date("2026-08-09T02:00:00Z"))).toBe(false); // Sun 10:00 Manila
    expect(isWorkingDay(new Date("2026-08-10T02:00:00Z"))).toBe(true); // Mon 10:00 Manila
  });

  it("excludes the fixed Philippine regular holidays", () => {
    // Rizal Day, 30 December 2026, a Wednesday.
    expect(isWorkingDay(new Date("2026-12-30T02:00:00Z"))).toBe(false);
    expect(isWorkingDay(new Date("2026-12-29T02:00:00Z"))).toBe(true);
  });

  it("lets a provider supply the movable holidays it cannot compute", () => {
    // Maundy Thursday is proclaimed annually, so the built-in list cannot know it.
    setHolidayProvider((iso) => iso === "2026-04-02");
    expect(isWorkingDay(new Date("2026-04-02T02:00:00Z"))).toBe(false);
    // And the provider fully replaces the default rather than adding to it.
    expect(isWorkingDay(new Date("2026-12-30T02:00:00Z"))).toBe(true);
  });
});

describe("addBusinessDays", () => {
  it("lands on the same clock time on the next working day", () => {
    // Wed 12 Aug 2026, 16:30 Manila → Thu 13 Aug, 16:30 Manila.
    const from = new Date("2026-08-12T08:30:00Z");
    expect(addBusinessDays(from, 1).toISOString()).toBe("2026-08-13T08:30:00.000Z");
  });

  it("steps over a weekend", () => {
    // Fri 14 Aug 2026, 16:30 Manila → Mon 17 Aug, 16:30 Manila. This is the case §3's SLA lives or
    // dies on: a Friday-afternoon inquiry must not be overdue on Saturday morning.
    const from = new Date("2026-08-14T08:30:00Z");
    expect(addBusinessDays(from, 1).toISOString()).toBe("2026-08-17T08:30:00.000Z");
  });

  it("advances to the next working day when it starts on one that is not", () => {
    // Sat 15 Aug 2026, 10:00 Manila → Mon 17 Aug, 10:00 Manila. A Saturday call is not already late.
    const from = new Date("2026-08-15T02:00:00Z");
    expect(addBusinessDays(from, 1).toISOString()).toBe("2026-08-17T02:00:00.000Z");
  });
});

describe("businessMsBetween", () => {
  it("counts a plain working day in full", () => {
    const from = new Date("2026-08-12T02:00:00Z"); // Wed 10:00 Manila
    const to = new Date("2026-08-13T02:00:00Z"); // Thu 10:00 Manila
    expect(businessMsBetween(from, to)).toBe(BUSINESS_DAY_MS);
  });

  it("contributes nothing for a weekend", () => {
    // Sat 00:00 through Mon 00:00 Manila: two whole non-working days.
    const from = new Date("2026-08-07T16:00:00Z");
    const to = new Date("2026-08-09T16:00:00Z");
    expect(businessMsBetween(from, to)).toBe(0);
  });

  it("counts only the working part of a span that crosses a weekend", () => {
    // Fri 12:00 Manila → Mon 12:00 Manila is 72 wall hours but 24 working hours.
    const from = new Date("2026-08-14T04:00:00Z");
    const to = new Date("2026-08-17T04:00:00Z");
    expect(businessMsBetween(from, to)).toBe(BUSINESS_DAY_MS);
  });

  it("is zero when the range is empty or inverted", () => {
    const at = new Date("2026-08-12T02:00:00Z");
    expect(businessMsBetween(at, at)).toBe(0);
    expect(businessMsBetween(at, new Date(at.getTime() - 1000))).toBe(0);
  });
});

describe("addBusinessMs", () => {
  it("is the exact inverse of businessMsBetween across a weekend", () => {
    const from = new Date("2026-08-14T04:00:00Z"); // Fri 12:00 Manila
    const reached = addBusinessMs(from, BUSINESS_DAY_MS);
    expect(businessMsBetween(from, reached)).toBe(BUSINESS_DAY_MS);
    expect(reached.toISOString()).toBe("2026-08-17T04:00:00.000Z"); // Mon 12:00 Manila
  });

  it("handles a partial day without rounding it to a whole one", () => {
    const from = new Date("2026-08-12T02:00:00Z"); // Wed 10:00 Manila
    const reached = addBusinessMs(from, 6 * 3_600_000);
    expect(reached.toISOString()).toBe("2026-08-12T08:00:00.000Z"); // Wed 16:00 Manila
  });
});
