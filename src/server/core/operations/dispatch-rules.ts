/**
 * specs/04-operations-projects.md §17, as pure functions.
 *
 * ## The card colour is §8's answer, not a second opinion
 *
 * §17: "**Gate status is visible on every card.** A ticket that is scheduled but has no released cash
 * advance or unissued materials shows red. The dispatcher sees the blocker before the crew does."
 *
 * The temptation is to compute that here — query the advance, query the materials, decide. That
 * would be a second implementation of §8's readiness check, and the two would disagree within a
 * month: the board would show green while mobilisation refused, or the reverse, and whoever noticed
 * would have no way to tell which was right.
 *
 * So `cardStatus` takes §8's `Readiness` and renders it. It adds exactly one thing §8 does not have:
 * the fact that a ticket is *scheduled*. An unready ticket nobody has committed to a date is a
 * to-do; an unready ticket with a crew booked on Thursday is a problem, and only the board knows
 * which it is.
 *
 * ## What is deliberately absent
 *
 * §17 asks for "skills matching against module 08's competence matrix; expired certification removes
 * the technician from eligible assignment". Module 08 does not exist, and there is no competence
 * matrix to read. Guessing one — a `skills String[]` on the user, say — would be inventing the shape
 * module 08 then has to reconcile, which is the mistake #46 warned about with the DR. So eligibility
 * here is availability only, and the seam is named rather than filled.
 */

// ---- what a card says ------------------------------------------------------------------------------

/** §8's shape, restated as the input this needs rather than imported, so the rules stay pure. */
export interface ReadinessLike {
  ready: boolean;
  blockers: { key: string; label: string; state: string }[];
}

/**
 * Three, and every one of them is returned by `cardStatus`.
 *
 * A fourth — `at_risk` — was written and then removed: nothing produced it, and a state the type
 * offers but the code never returns is a lie the next person builds a branch against.
 */
export const CARD_STATES = ["ready", "blocked", "unscheduled"] as const;
export type CardState = (typeof CARD_STATES)[number];

export const CARD_STATE_LABELS: Record<CardState, string> = {
  ready: "Ready to go",
  blocked: "Blocked, and scheduled",
  unscheduled: "No date",
};

export interface CardStatus {
  state: CardState;
  /** The first thing standing in the way, named. Empty when nothing is. */
  blockers: string[];
  /** One line for the card face. */
  summary: string;
}

/**
 * What the dispatcher sees on a block.
 *
 * The distinction §17 is really asking for is between *blocked* and *blocked with a crew committed*.
 * A ticket with no cash advance and no date is ordinary work-in-progress. The same ticket with three
 * technicians booked on Thursday is the thing that ruins a week, and it should not look the same.
 */
export function cardStatus(input: {
  readiness: ReadinessLike;
  scheduledStart?: Date | string | null;
}): CardStatus {
  const blockers = input.readiness.blockers
    .filter((blocker) => blocker.state === "fail" || blocker.state === "unknown")
    .map((blocker) => blocker.label);

  if (!input.scheduledStart) {
    return {
      state: "unscheduled",
      blockers,
      summary: blockers.length > 0 ? `Not scheduled · ${blockers[0]}` : "Not scheduled",
    };
  }

  if (blockers.length === 0) {
    return { state: "ready", blockers: [], summary: "Ready" };
  }

  return {
    state: "blocked",
    blockers,
    summary:
      blockers.length === 1 ? blockers[0]! : `${blockers[0]} and ${blockers.length - 1} more`,
  };
}

// ---- availability ------------------------------------------------------------------------------------

export const UNAVAILABILITY_KINDS = ["leave", "training", "sick", "other"] as const;
export type UnavailabilityKind = (typeof UNAVAILABILITY_KINDS)[number];

export const UNAVAILABILITY_LABELS: Record<UnavailabilityKind, string> = {
  leave: "Leave",
  training: "Training",
  sick: "Sick",
  other: "Unavailable",
};

export interface Unavailability {
  userId: string;
  from: Date | string;
  to: Date | string;
  kind: string;
  notes?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A date with the time discarded, so a comparison is about days rather than hours. */
export function dayKey(at: Date | string): string {
  const date = typeof at === "string" ? new Date(at) : at;
  return date.toISOString().slice(0, 10);
}

/** Every day from `from` to `to` inclusive, as `YYYY-MM-DD`. */
export function daysBetween(from: Date | string, to: Date | string): string[] {
  const start = new Date(dayKey(from));
  const end = new Date(dayKey(to));
  if (end < start) return [];

  const out: string[] = [];
  for (let at = start.getTime(); at <= end.getTime(); at += DAY_MS) {
    out.push(new Date(at).toISOString().slice(0, 10));
  }
  return out;
}

export function isUnavailable(
  userId: string,
  day: Date | string,
  unavailability: readonly Unavailability[],
): Unavailability | null {
  const key = dayKey(day);
  return (
    unavailability.find(
      (entry) => entry.userId === userId && dayKey(entry.from) <= key && key <= dayKey(entry.to),
    ) ?? null
  );
}

// ---- conflicts ---------------------------------------------------------------------------------------

export interface Assignment {
  ticketId: string;
  ticketNumber: string;
  userId: string;
  scheduledStart: Date | string;
  scheduledEnd?: Date | string | null;
}

export interface Conflict {
  userId: string;
  day: string;
  /** Every ticket that wants this person on this day. Two or more is the conflict. */
  ticketNumbers: string[];
  reason: string;
}

/**
 * Where one person is wanted in two places, or wanted while away.
 *
 * Reported rather than prevented. A dispatcher double-booking somebody deliberately — two short jobs
 * on one industrial estate — is a real and reasonable thing to do, and a scheduler that refuses it
 * teaches people to work around the scheduler. What it must not do is let the double-booking happen
 * *unnoticed*.
 */
export function findConflicts(
  assignments: readonly Assignment[],
  unavailability: readonly Unavailability[] = [],
): Conflict[] {
  const byUserDay = new Map<string, string[]>();

  for (const assignment of assignments) {
    const days = daysBetween(
      assignment.scheduledStart,
      assignment.scheduledEnd ?? assignment.scheduledStart,
    );
    for (const day of days) {
      const key = `${assignment.userId}|${day}`;
      const list = byUserDay.get(key) ?? [];
      if (!list.includes(assignment.ticketNumber)) list.push(assignment.ticketNumber);
      byUserDay.set(key, list);
    }
  }

  const conflicts: Conflict[] = [];

  for (const [key, ticketNumbers] of byUserDay) {
    const [userId, day] = key.split("|") as [string, string];

    if (ticketNumbers.length > 1) {
      conflicts.push({
        userId,
        day,
        ticketNumbers,
        reason: `Booked on ${ticketNumbers.length} jobs the same day.`,
      });
    }

    const away = isUnavailable(userId, day, unavailability);
    if (away) {
      conflicts.push({
        userId,
        day,
        ticketNumbers,
        reason: `${UNAVAILABILITY_LABELS[away.kind as UnavailabilityKind] ?? away.kind}${
          away.notes ? ` — ${away.notes}` : ""
        }.`,
      });
    }
  }

  return conflicts;
}

// ---- capacity ------------------------------------------------------------------------------------------

/** §17: "next 4 weeks of committed field days vs available technician days". */
export const CAPACITY_WEEKS = 4;

export interface CapacityWeek {
  /** Monday of the week, `YYYY-MM-DD`. */
  weekOf: string;
  /** Technician-days the crew could work, less leave and training. */
  available: number;
  /** Technician-days already promised to tickets. */
  committed: number;
  /** available − committed. Negative means the company has promised more than it has. */
  spare: number;
  utilisationPct: number;
}

/** Monday of the week containing `at`. */
export function weekOf(at: Date | string): string {
  const date = new Date(dayKey(at));
  const weekday = (date.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(date.getTime() - weekday * DAY_MS).toISOString().slice(0, 10);
}

/**
 * What the next four weeks look like.
 *
 * §17 calls this "the number sales needs before promising a date", which is the whole reason it is
 * a *forward* view rather than a report on the past.
 *
 * Working days only — counting weekends as available capacity would flatter every week by 40% and
 * make the number useless for exactly the promise it exists to inform.
 */
export function capacityByWeek(input: {
  technicianIds: readonly string[];
  assignments: readonly Assignment[];
  unavailability?: readonly Unavailability[];
  from?: Date;
  weeks?: number;
  /** Injected so a holiday calendar can be supplied without this file importing one. */
  isWorkingDay?: (day: string) => boolean;
}): CapacityWeek[] {
  const weeks = input.weeks ?? CAPACITY_WEEKS;
  const start = new Date(weekOf(input.from ?? new Date()));
  const unavailability = input.unavailability ?? [];
  const working =
    input.isWorkingDay ??
    ((day: string) => {
      const weekday = new Date(day).getUTCDay();
      return weekday !== 0 && weekday !== 6;
    });

  const committedByDay = new Map<string, number>();
  for (const assignment of input.assignments) {
    const days = daysBetween(
      assignment.scheduledStart,
      assignment.scheduledEnd ?? assignment.scheduledStart,
    );
    for (const day of days) {
      committedByDay.set(day, (committedByDay.get(day) ?? 0) + 1);
    }
  }

  return Array.from({ length: weeks }, (_, index) => {
    const monday = new Date(start.getTime() + index * 7 * DAY_MS);
    const days = daysBetween(monday, new Date(monday.getTime() + 6 * DAY_MS)).filter(working);

    let available = 0;
    let committed = 0;

    for (const day of days) {
      for (const technicianId of input.technicianIds) {
        if (!isUnavailable(technicianId, day, unavailability)) available += 1;
      }
      committed += committedByDay.get(day) ?? 0;
    }

    return {
      weekOf: monday.toISOString().slice(0, 10),
      available,
      committed,
      spare: available - committed,
      utilisationPct: available > 0 ? Math.round((committed / available) * 100) : 0,
    };
  });
}

// ---- travel ----------------------------------------------------------------------------------------------

/**
 * §17 asks the board to show "travel time between consecutive sites".
 *
 * It returns `null` when either site has no coordinates, and the board says so rather than showing a
 * number. A guessed travel time is worse than none: the dispatcher would plan a day around it, and
 * the crew would discover it was wrong on the road. Site addresses are `Json` and coordinates are
 * optional (prisma/schema/crm.prisma), so "unknown" is the common case today and has to read as an
 * honest gap rather than as zero.
 *
 * The estimate itself is straight-line distance at an average road speed — crude, and labelled as
 * crude wherever it is shown. Metro Manila traffic makes anything more precise a lie without a
 * routing service, which is a module 10 integration rather than something to fake here.
 */
export const AVERAGE_ROAD_SPEED_KPH = 30;

export interface Coordinates {
  lat: number;
  lng: number;
}

export function readCoordinates(address: unknown): Coordinates | null {
  if (!address || typeof address !== "object" || Array.isArray(address)) return null;
  const record = address as Record<string, unknown>;
  const lat = record.lat ?? record.latitude;
  const lng = record.lng ?? record.longitude;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/** Great-circle kilometres. */
export function distanceKm(a: Coordinates, b: Coordinates): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface TravelEstimate {
  known: boolean;
  km: number | null;
  minutes: number | null;
  note: string;
}

export function travelBetween(from: unknown, to: unknown): TravelEstimate {
  const a = readCoordinates(from);
  const b = readCoordinates(to);

  if (!a || !b) {
    return {
      known: false,
      km: null,
      minutes: null,
      note: "No coordinates on one of these sites, so the travel time is unknown.",
    };
  }

  const km = distanceKm(a, b);
  return {
    known: true,
    km: Math.round(km * 10) / 10,
    minutes: Math.round((km / AVERAGE_ROAD_SPEED_KPH) * 60),
    note: `Straight line at ${AVERAGE_ROAD_SPEED_KPH} km/h — a rough floor, not a route.`,
  };
}

export const TICKET_SCHEDULE_ENTITY_TYPE = "Ticket";
export const DISPATCH_PERMISSION = "ticket.dispatch";
