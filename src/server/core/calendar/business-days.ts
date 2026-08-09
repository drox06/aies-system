/**
 * Working-calendar arithmetic, in Asia/Manila.
 *
 * specs/01-crm-inquiry.md §3 puts the inquiry acknowledgement SLA at "1 business day", and §5
 * pauses that clock during a site inspection. Neither is meaningful without knowing which days are
 * working days, so this is the piece that has to exist first.
 *
 * Spec.md §10 describes a configurable working calendar under system settings. `SystemSetting` is
 * not built (it belongs to module 09), so the holiday list lives here for now. That is a real
 * shortcut and it is stated rather than hidden: `setHolidayProvider` exists so module 09 can
 * replace the source without any caller changing.
 *
 * **No timezone library.** The Philippines has not observed daylight saving since 1978, so
 * Asia/Manila is a fixed UTC+8. Every date here is a real UTC instant (Spec.md §6.6: "Asia/Manila
 * fixed; store UTC"); the offset is applied only to decide which *calendar day* an instant falls
 * on. Introducing a tz database to model an offset that has not moved in half a century would be a
 * dependency to maintain for no behaviour.
 */

const DAY_MS = 86_400_000;
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Philippine **regular** holidays that fall on a fixed date, as "MM-DD".
 *
 * Regular holidays only. The movable ones — Maundy Thursday, Good Friday, Eid'l Fitr, Eid'l Adha,
 * Chinese New Year — are set by presidential proclamation each year and cannot be computed, and the
 * "special non-working days" (Ninoy Aquino Day, All Saints' Day, 31 December) are no-work-no-pay
 * days that many private firms still work through. Both are therefore omitted here.
 *
 * The direction of that omission is deliberate: a missing non-working day makes the SLA deadline
 * *earlier*, so an inquiry escalates sooner than it strictly must. Erring the other way would let a
 * genuinely late inquiry sit quietly, which is the exact failure §3 exists to prevent.
 */
export const PH_FIXED_REGULAR_HOLIDAYS: readonly string[] = [
  "01-01", // New Year's Day
  "04-09", // Araw ng Kagitingan
  "05-01", // Labor Day
  "06-12", // Independence Day
  "11-30", // Bonifacio Day
  "12-25", // Christmas Day
  "12-30", // Rizal Day
];

export type HolidayProvider = (isoDate: string) => boolean;

const fixedHolidays = new Set(PH_FIXED_REGULAR_HOLIDAYS);
let holidayProvider: HolidayProvider = (isoDate) => fixedHolidays.has(isoDate.slice(5));

/**
 * Replaces the holiday source. Module 09's settings screen is the intended caller; tests use it to
 * pin a calendar rather than depend on which year they happen to run in.
 *
 * Receives a full `YYYY-MM-DD` (Manila) so a provider can honour the proclaimed movable holidays,
 * which the default cannot.
 */
export function setHolidayProvider(provider: HolidayProvider): void {
  holidayProvider = provider;
}

/** Restores the built-in fixed-date list. */
export function resetHolidayProvider(): void {
  holidayProvider = (isoDate) => fixedHolidays.has(isoDate.slice(5));
}

/** Whole days since the epoch, in Manila local time. */
function manilaDayIndex(timeMs: number): number {
  return Math.floor((timeMs + MANILA_OFFSET_MS) / DAY_MS);
}

/** The UTC instant at which that Manila day begins (00:00 Manila = 16:00 UTC the day before). */
function manilaDayStartUtc(index: number): number {
  return index * DAY_MS - MANILA_OFFSET_MS;
}

/**
 * The Manila calendar date of a day index, as `YYYY-MM-DD`.
 *
 * `index * DAY_MS` read as UTC *is* the Manila calendar date — that is the whole trick, and why
 * this needs no timezone conversion.
 */
function manilaIsoDate(index: number): string {
  return new Date(index * DAY_MS).toISOString().slice(0, 10);
}

function isWorkingDayIndex(index: number): boolean {
  // Epoch day 0 (1970-01-01) was a Thursday, so +4 lands 0 on Sunday.
  const dayOfWeek = (((index + 4) % 7) + 7) % 7;
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  return !holidayProvider(manilaIsoDate(index));
}

/** Whether this instant falls on a Manila working day. */
export function isWorkingDay(at: Date): boolean {
  return isWorkingDayIndex(manilaDayIndex(at.getTime()));
}

/**
 * Advances by whole working days, keeping the time of day.
 *
 * So "1 business day" means the same clock time on the next working day: an inquiry taken at 16:30
 * on Friday is due at 16:30 on Monday. That is how people read the phrase, and it removes any need
 * to model office hours — a full working day forward is a full working day forward whatever time
 * the clock started.
 *
 * A start on a non-working day still advances to the next working day, so a Saturday call is due
 * Monday rather than being treated as already overdue.
 */
export function addBusinessDays(from: Date, days: number): Date {
  if (days <= 0) return new Date(from.getTime());
  let index = manilaDayIndex(from.getTime());
  const timeIntoDay = from.getTime() - manilaDayStartUtc(index);

  let remaining = days;
  while (remaining > 0) {
    index += 1;
    if (isWorkingDayIndex(index)) remaining -= 1;
  }
  return new Date(manilaDayStartUtc(index) + timeIntoDay);
}

/**
 * Elapsed milliseconds between two instants, counting only time that falls on working days.
 *
 * This is what makes a paused SLA clock honest. A site inspection raised on Friday afternoon and
 * closed on Monday morning consumed one working day of *wall* time but should give back only the
 * working part — otherwise pausing over a weekend would hand the inquiry two free days of budget
 * that were never spent.
 *
 * Half-open: `[from, to)`. Returns 0 when `to` is not after `from`.
 */
export function businessMsBetween(from: Date, to: Date): number {
  const start = from.getTime();
  const end = to.getTime();
  if (end <= start) return 0;

  const firstIndex = manilaDayIndex(start);
  const lastIndex = manilaDayIndex(end - 1);

  let total = 0;
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    if (!isWorkingDayIndex(index)) continue;
    const dayStart = manilaDayStartUtc(index);
    total += Math.min(end, dayStart + DAY_MS) - Math.max(start, dayStart);
  }
  return total;
}

/**
 * The instant reached by spending `ms` of *working* time from `from`.
 *
 * The inverse of `businessMsBetween`: `businessMsBetween(from, addBusinessMs(from, n)) === n`. Used
 * to turn an SLA budget into a real deadline, including one that has been extended by a pause —
 * whole `addBusinessDays` cannot express "one working day plus the six working hours this inquiry
 * spent waiting on a site inspection".
 */
export function addBusinessMs(from: Date, ms: number): Date {
  if (ms <= 0) return new Date(from.getTime());

  let index = manilaDayIndex(from.getTime());
  let cursor = from.getTime();
  let remaining = ms;

  // Bounded so a corrupt input cannot spin forever. Ten years of working days is far beyond any
  // SLA this models, and reaching it means the caller passed something nonsensical.
  for (let guard = 0; guard < 3700; guard += 1) {
    const dayEnd = manilaDayStartUtc(index) + DAY_MS;
    if (isWorkingDayIndex(index)) {
      const available = dayEnd - cursor;
      if (available >= remaining) return new Date(cursor + remaining);
      remaining -= available;
    }
    index += 1;
    cursor = manilaDayStartUtc(index);
  }
  throw new Error(`addBusinessMs: ${ms}ms is too far ahead to resolve to a working-day instant.`);
}

/** One working day, in milliseconds — the unit `businessMsBetween` returns. */
export const BUSINESS_DAY_MS = DAY_MS;
