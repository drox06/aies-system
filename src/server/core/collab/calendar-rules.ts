/**
 * §4's calendar, as rules — no Prisma, no database.
 *
 * On `UI_SAFE_SERVER_MODULES`: the calendar screen groups by day, colours by source and reads the
 * same labels the iCal feed writes, and a second set of either on the client would drift.
 */

/**
 * Where a calendar entry comes from.
 *
 * Every one but `manual` is **derived from a record that already holds the date**. Nothing is copied
 * onto the calendar, because a copied due date is a second thing to keep in step and the calendar's
 * copy is the one nobody updates.
 */
export const CALENDAR_SOURCES = [
  "ticket",
  "mobilization",
  "demobilization",
  "delivery",
  "pm_visit",
  "quotation_expiry",
  "invoice_due",
  "liquidation_due",
  "calibration_due",
  "leave",
  "manual",
] as const;
export type CalendarSource = (typeof CALENDAR_SOURCES)[number];

export const CALENDAR_SOURCE_LABELS: Record<CalendarSource, string> = {
  ticket: "Job scheduled",
  mobilization: "Crew goes out",
  demobilization: "Crew comes home",
  delivery: "Delivery",
  pm_visit: "PM visit due",
  quotation_expiry: "Quotation expires",
  invoice_due: "Payment due",
  liquidation_due: "Advance to liquidate",
  calibration_due: "Calibration due",
  leave: "Away",
  manual: "Diary",
};

/**
 * Which sources need a permission, and which one.
 *
 * A calendar is a summary of the company, and a summary that ignores permissions is a way to read
 * what you cannot open. Money is the sensitive part — module 05 §10: *"Default every finance
 * permission to off"* — so the two finance sources are gated and the operational ones are not.
 */
export const CALENDAR_SOURCE_PERMISSION: Partial<Record<CalendarSource, string>> = {
  invoice_due: "ar.view",
  liquidation_due: "finance.view",
};

export interface CalendarEntry {
  id: string;
  source: CalendarSource;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  allDay: boolean;
  /** Who it concerns, when the record names somebody. Drives "my calendar". */
  userIds: string[];
  entityType: string | null;
  entityId: string | null;
  /** A number or code to show beside the title. */
  reference: string | null;
}

/** Half-open: `[from, to)`. A day-long event on the last day must still be included. */
export function overlaps(entry: CalendarEntry, from: Date, to: Date): boolean {
  const start = entry.startsAt.getTime();
  const end = (entry.endsAt ?? entry.startsAt).getTime();
  return start < to.getTime() && end >= from.getTime();
}

/** Midnight, Manila. The company works in one time zone and thinks in local days. */
export const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

export function manilaDayKey(date: Date): string {
  return new Date(date.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The days of a month grid, Monday-first, padded to whole weeks.
 *
 * Padding is what makes a month read as a grid rather than a ragged list — and the padding days are
 * real dates from the neighbouring months, so an event on the 1st falling on a Sunday is still
 * visible in the week it belongs to.
 */
export function monthGrid(year: number, monthIndex: number): Date[] {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  // getUTCDay: 0 = Sunday. Monday-first means Sunday is the seventh column.
  const lead = (first.getUTCDay() + 6) % 7;
  const start = new Date(first.getTime() - lead * 24 * 60 * 60 * 1000);

  const days: Date[] = [];
  for (let index = 0; index < 42; index += 1) {
    days.push(new Date(start.getTime() + index * 24 * 60 * 60 * 1000));
  }
  return days;
}

export function groupByDay(entries: CalendarEntry[]): Map<string, CalendarEntry[]> {
  const byDay = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    /*
      A multi-day entry appears on every day it covers.

      Leave from Monday to Friday is not a Monday event — somebody looking at Wednesday needs to see
      that the technician is away, which is the only reason the dispatch board and this screen exist
      in the same platform.
    */
    const last = entry.endsAt ?? entry.startsAt;
    for (
      let day = new Date(entry.startsAt.getTime());
      day.getTime() <= last.getTime();
      day = new Date(day.getTime() + 24 * 60 * 60 * 1000)
    ) {
      const key = manilaDayKey(day);
      byDay.set(key, [...(byDay.get(key) ?? []), entry]);
      // A point-in-time entry has one day, and a long one must not loop forever on a bad date.
      if (byDay.size > 400) break;
    }
  }
  return byDay;
}

/** iCal wants CRLF, escaped commas and semicolons, and no stray newlines inside a value. */
function icsEscape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function icsStamp(date: Date, allDay: boolean): string {
  if (allDay) {
    return new Date(date.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, "");
  }
  return `${date.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
}

/**
 * §4's read-only feed: *"iCal feed per user (token-authenticated) so it can appear in their phone
 * calendar."*
 *
 * Read-only by design. §4 is explicit that there is **no two-way Google sync in v1** — it is a large
 * source of bugs and duplicate events — so nothing here accepts a change from the other end.
 */
export function toIcs(entries: CalendarEntry[], calendarName: string): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//AIES//Operations Platform//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(calendarName)}`,
    // Every half hour. A phone that refetched constantly would be the noisiest client of this
    // platform, and nothing here changes minute to minute.
    "REFRESH-INTERVAL;VALUE=DURATION:PT30M",
    "X-PUBLISHED-TTL:PT30M",
  ];

  for (const entry of entries) {
    const end = entry.endsAt ?? entry.startsAt;
    lines.push(
      "BEGIN:VEVENT",
      // Stable across refetches, so a phone updates an event rather than collecting duplicates of it.
      `UID:${entry.source}-${entry.id}@aies`,
      `DTSTAMP:${icsStamp(new Date(), false)}`,
      entry.allDay
        ? `DTSTART;VALUE=DATE:${icsStamp(entry.startsAt, true)}`
        : `DTSTART:${icsStamp(entry.startsAt, false)}`,
      entry.allDay
        ? `DTEND;VALUE=DATE:${icsStamp(new Date(end.getTime() + 24 * 60 * 60 * 1000), true)}`
        : `DTEND:${icsStamp(end, false)}`,
      `SUMMARY:${icsEscape(entry.reference ? `${entry.title} (${entry.reference})` : entry.title)}`,
      `CATEGORIES:${icsEscape(CALENDAR_SOURCE_LABELS[entry.source])}`,
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

/** §5's audience test: an empty list is the whole company. */
export function isAddressedTo(audienceRoleKeys: string[], roleKeys: string[]): boolean {
  if (audienceRoleKeys.length === 0) return true;
  return audienceRoleKeys.some((key) => roleKeys.includes(key));
}

/**
 * Whether an announcement is still current.
 *
 * Expiry hides it from the live list and **nothing else**. The acknowledgement record outlives the
 * notice by design: ISO clause 7.4 asks who was told, not who is still being told.
 */
export function isCurrent(
  announcement: { expiresAt: Date | null },
  now: Date = new Date(),
): boolean {
  return !announcement.expiresAt || announcement.expiresAt.getTime() > now.getTime();
}
