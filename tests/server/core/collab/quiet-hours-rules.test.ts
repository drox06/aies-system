import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUIET_HOURS,
  checkSchedule,
  formatMinutes,
  isQuiet,
  manilaMinutes,
  passesQuietHours,
  releaseAt,
} from "@/server/core/collab/quiet-hours-rules";

/**
 * §7's quiet hours, without a database.
 *
 * The window wraps midnight, which is the whole difficulty: treated as an ordinary range, 18:00 to
 * 07:00 would let every evening message through and hold every morning one. Nothing would error —
 * the platform would just be silent at exactly the wrong times.
 */

/** An instant, given as Manila wall-clock time. */
const manila = (hour: number, minute = 0) => new Date(Date.UTC(2026, 7, 21, hour - 8, minute));

describe("manilaMinutes", () => {
  it("reads an instant as minutes past midnight in Manila", () => {
    expect(manilaMinutes(manila(0))).toBe(0);
    expect(manilaMinutes(manila(18, 30))).toBe(18 * 60 + 30);
    expect(manilaMinutes(manila(23, 59))).toBe(23 * 60 + 59);
  });
});

describe("isQuiet", () => {
  it("holds the evening and the small hours, and lets the working day through", () => {
    // The default: 18:00 to 07:00.
    expect(isQuiet(manila(19))).toBe(true);
    expect(isQuiet(manila(2))).toBe(true);
    expect(isQuiet(manila(6, 59))).toBe(true);
    expect(isQuiet(manila(7))).toBe(false);
    expect(isQuiet(manila(12))).toBe(false);
    expect(isQuiet(manila(17, 59))).toBe(false);
  });

  it("handles a window that does not wrap midnight", () => {
    const lunch = { ...DEFAULT_QUIET_HOURS, quietFromMinutes: 12 * 60, quietToMinutes: 13 * 60 };
    expect(isQuiet(manila(12, 30), lunch)).toBe(true);
    expect(isQuiet(manila(2), lunch)).toBe(false);
  });

  it("is never quiet when somebody has switched it off", () => {
    expect(isQuiet(manila(2), { ...DEFAULT_QUIET_HOURS, quietHoursOn: false })).toBe(false);
  });
});

describe("passesQuietHours", () => {
  it("lets urgent work through whatever the hour", () => {
    // §7 names the exceptions; the rest of the point is that the list stays short, or the phone
    // ends up face-down and the important message is missed too.
    expect(passesQuietHours("task.assigned", true)).toBe(true);
    expect(passesQuietHours("task.assigned", false)).toBe(false);
  });

  it("lets an emergency ticket and a cash advance request through", () => {
    expect(passesQuietHours("ticket.emergency", false)).toBe(true);
    // §5 of module 04 gives the advance a four-working-hour escalation window; a night's silence
    // would eat most of it.
    expect(passesQuietHours("cash_advance.requested", false)).toBe(true);
  });
});

describe("releaseAt", () => {
  it("holds an evening message until the next morning's digest", () => {
    const held = releaseAt(manila(23));
    expect(manilaMinutes(held)).toBe(DEFAULT_QUIET_HOURS.digestAtMinutes);
    // The next day, not the same one.
    expect(held.getTime()).toBeGreaterThan(manila(23).getTime());
  });

  it("holds a small-hours message until the same morning", () => {
    const held = releaseAt(manila(3));
    expect(manilaMinutes(held)).toBe(DEFAULT_QUIET_HOURS.digestAtMinutes);
    expect(held.getTime() - manila(3).getTime()).toBeLessThan(24 * 60 * 60_000);
  });

  it("respects a digest time somebody has moved later", () => {
    /*
      Release is the digest time, not the moment quiet hours lift. They are the same by default and
      come apart the instant somebody chooses a later digest — at which point releasing at 07:00
      would deliver the night's messages before they had asked for them.
    */
    const late = { ...DEFAULT_QUIET_HOURS, digestAtMinutes: 9 * 60 };
    expect(manilaMinutes(releaseAt(manila(23), late))).toBe(9 * 60);
  });
});

describe("checkSchedule", () => {
  it("accepts the defaults", () => {
    expect(checkSchedule(DEFAULT_QUIET_HOURS).ok).toBe(true);
  });

  it("refuses a window whose ends are the same", () => {
    // It could mean "never quiet" or "always quiet", and guessing decides whether somebody is told
    // about a job at all.
    const result = checkSchedule({
      ...DEFAULT_QUIET_HOURS,
      quietFromMinutes: 60,
      quietToMinutes: 60,
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a time that is not a time of day", () => {
    expect(checkSchedule({ ...DEFAULT_QUIET_HOURS, digestAtMinutes: 2000 }).ok).toBe(false);
    expect(checkSchedule({ ...DEFAULT_QUIET_HOURS, quietFromMinutes: -1 }).ok).toBe(false);
  });
});

describe("formatMinutes", () => {
  it("reads back as a wall clock", () => {
    expect(formatMinutes(0)).toBe("00:00");
    expect(formatMinutes(7 * 60)).toBe("07:00");
    expect(formatMinutes(18 * 60 + 30)).toBe("18:30");
  });
});
