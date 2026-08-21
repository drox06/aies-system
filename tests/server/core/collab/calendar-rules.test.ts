import { describe, expect, it } from "vitest";
import {
  groupByDay,
  isAddressedTo,
  isCurrent,
  manilaDayKey,
  monthGrid,
  overlaps,
  toIcs,
  type CalendarEntry,
} from "@/server/core/collab/calendar-rules";

/**
 * §4's calendar rules and §5's audience test, without a database.
 *
 * The iCal serialiser is pure precisely so it can be tested: a feed with a bad escape or an unstable
 * UID does not fail — it quietly produces duplicate events on somebody's phone every half hour,
 * which nobody would trace back to here.
 */

const entry = (over: Partial<CalendarEntry> = {}): CalendarEntry => ({
  id: "e1",
  source: "manual",
  title: "Something",
  startsAt: new Date("2026-08-21T02:00:00.000Z"),
  endsAt: null,
  allDay: false,
  userIds: [],
  entityType: null,
  entityId: null,
  reference: null,
  ...over,
});

describe("overlaps", () => {
  const from = new Date("2026-08-01T00:00:00.000Z");
  const to = new Date("2026-09-01T00:00:00.000Z");

  it("includes something starting inside the window", () => {
    expect(overlaps(entry(), from, to)).toBe(true);
  });

  it("includes something that started before and is still running", () => {
    // Leave that began in July and ends in August is August's problem too.
    expect(
      overlaps(
        entry({
          startsAt: new Date("2026-07-28T00:00:00.000Z"),
          endsAt: new Date("2026-08-04T00:00:00.000Z"),
        }),
        from,
        to,
      ),
    ).toBe(true);
  });

  it("excludes something wholly before or after", () => {
    expect(overlaps(entry({ startsAt: new Date("2026-07-01") }), from, to)).toBe(false);
    expect(overlaps(entry({ startsAt: new Date("2026-09-02") }), from, to)).toBe(false);
  });
});

describe("manilaDayKey", () => {
  it("puts a late-evening UTC time on the next Manila day", () => {
    /*
      The company is UTC+8 and thinks in local days. A ticket scheduled at 21:00 UTC is the following
      morning in Manila, and a calendar that showed it on the previous day would be wrong about the
      only thing a calendar is for.
    */
    expect(manilaDayKey(new Date("2026-08-20T21:00:00.000Z"))).toBe("2026-08-21");
    expect(manilaDayKey(new Date("2026-08-21T01:00:00.000Z"))).toBe("2026-08-21");
  });
});

describe("monthGrid", () => {
  it("returns six whole weeks starting on a Monday", () => {
    const days = monthGrid(2026, 7); // August 2026
    expect(days).toHaveLength(42);
    expect(days[0]!.getUTCDay()).toBe(1);
  });

  it("pads with real dates from the neighbouring months", () => {
    // August 2026 starts on a Saturday, so the grid opens in July — and an event on the 1st is
    // still visible in the week it belongs to.
    const days = monthGrid(2026, 7);
    expect(days[0]!.getUTCMonth()).toBe(6);
    expect(days.some((day) => day.getUTCMonth() === 8)).toBe(true);
  });
});

describe("groupByDay", () => {
  it("puts a multi-day entry on every day it covers", () => {
    // Somebody looking at Wednesday needs to see that the technician is away all week.
    const byDay = groupByDay([
      entry({
        startsAt: new Date("2026-08-17T00:00:00.000Z"),
        endsAt: new Date("2026-08-19T00:00:00.000Z"),
        allDay: true,
        source: "leave",
      }),
    ]);
    expect([...byDay.keys()].sort()).toEqual(["2026-08-17", "2026-08-18", "2026-08-19"]);
  });

  it("puts a point in time on exactly one day", () => {
    const byDay = groupByDay([entry()]);
    expect(byDay.size).toBe(1);
  });
});

describe("toIcs", () => {
  it("gives every entry a UID that does not change between fetches", () => {
    /*
      The whole difference between a calendar that updates and one that fills up with duplicates.
      A phone refetches this every half hour; an unstable UID means a new event each time.
    */
    const first = toIcs([entry()], "AIES");
    const second = toIcs([entry()], "AIES");
    expect(first.match(/UID:.*/)![0]).toBe(second.match(/UID:.*/)![0]);
    expect(first).toContain("UID:manual-e1@aies");
  });

  it("escapes the characters iCal treats as syntax", () => {
    const ics = toIcs([entry({ title: "Site visit; Bataan, 09:00" })], "AIES");
    expect(ics).toContain("SUMMARY:Site visit\\; Bataan\\, 09:00");
  });

  it("writes an all-day entry as a date and an ordinary one as a timestamp", () => {
    const allDay = toIcs([entry({ allDay: true })], "AIES");
    expect(allDay).toContain("DTSTART;VALUE=DATE:20260821");

    const timed = toIcs([entry()], "AIES");
    expect(timed).toMatch(/DTSTART:20260821T020000Z/);
  });

  it("uses CRLF line endings, which the format requires", () => {
    expect(toIcs([entry()], "AIES")).toContain("\r\n");
  });

  it("puts the record's number in the summary when there is one", () => {
    const ics = toIcs([entry({ title: "Job", reference: "AIESTKT-260012" })], "AIES");
    expect(ics).toContain("SUMMARY:Job (AIESTKT-260012)");
  });
});

describe("isAddressedTo", () => {
  it("treats an empty audience as the whole company", () => {
    expect(isAddressedTo([], ["technician"])).toBe(true);
  });

  it("matches on any one of the reader's roles", () => {
    expect(isAddressedTo(["technician", "sales"], ["sales"])).toBe(true);
    expect(isAddressedTo(["technician"], ["finance_officer"])).toBe(false);
  });
});

describe("isCurrent", () => {
  const now = new Date("2026-08-21T00:00:00.000Z");

  it("keeps an announcement with no expiry forever", () => {
    expect(isCurrent({ expiresAt: null }, now)).toBe(true);
  });

  it("drops one whose date has passed", () => {
    expect(isCurrent({ expiresAt: new Date("2026-08-20T00:00:00.000Z") }, now)).toBe(false);
    expect(isCurrent({ expiresAt: new Date("2026-08-22T00:00:00.000Z") }, now)).toBe(true);
  });
});
