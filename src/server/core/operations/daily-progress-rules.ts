/**
 * Daily progress rules (specs/04-operations-projects.md §8's execution half).
 *
 * Pure — no Prisma, no node builtins — so the screen shows exactly what the server enforces. On
 * `UI_SAFE_SERVER_MODULES` in eslint.config.mjs.
 *
 * §8 explains why standby is modelled at all, and it is the sentence this file is built around:
 * "**Standby and delay tracking** with cause codes… This is the evidence base for a variation claim,
 * and **today it exists only in people's memory**."
 */

export const DAILY_PROGRESS_ENTITY_TYPE = "DailyProgress";

/** §19's `ticket.execute` — the crew logs its own day. */
export const PROGRESS_LOG_PERMISSION = "ticket.execute";

/**
 * §8's six cause codes, verbatim.
 *
 * A closed list rather than free text, and the reason is the claim: "client not ready" written six
 * different ways across four months is not evidence of anything, where six rows carrying the same
 * code are. The whole value of this data is that it can be counted.
 */
export const STANDBY_CAUSES = [
  "client_not_ready",
  "permit_delay",
  "weather",
  "material_shortage",
  "equipment_failure",
  "access_denied",
] as const;

export type StandbyCause = (typeof STANDBY_CAUSES)[number];

export const STANDBY_CAUSE_LABELS: Record<StandbyCause, string> = {
  client_not_ready: "Client not ready",
  permit_delay: "Permit delay",
  weather: "Weather",
  material_shortage: "Material shortage",
  equipment_failure: "Equipment failure",
  access_denied: "Access denied",
};

/**
 * Whose delay each cause is.
 *
 * This is the judgement that makes the log worth keeping. A variation claim rests on standby the
 * **customer** caused; standby AIES caused is a cost the company swallows, and mixing the two
 * produces a claim that falls apart on the first line somebody checks.
 *
 * `weather` is neither, and deliberately so: it is nobody's fault and most contracts treat it as an
 * extension of time rather than money. Calling it the client's would be the kind of overreach that
 * loses the argument about the rest.
 */
export const CAUSE_ATTRIBUTION: Record<StandbyCause, "customer" | "aies" | "neither"> = {
  client_not_ready: "customer",
  permit_delay: "customer",
  access_denied: "customer",
  material_shortage: "aies",
  equipment_failure: "aies",
  weather: "neither",
};

export interface ProgressEntry {
  logDate: Date | string;
  percentComplete: number;
  hoursWorked: number;
  standbyHours: number;
  standbyCause?: string | null;
}

// ---- what a log has to say ----------------------------------------------------------------------

export interface ProgressCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Whether a day's log is coherent.
 *
 * The one hard rule is that standby hours need a cause. Everything else warns, because a site day is
 * messy and a form that refuses a messy day gets filled in with fiction — which is worse than a
 * gap, since the fiction is what a claim would later rest on.
 */
export function checkProgressEntry(entry: {
  percentComplete: number;
  hoursWorked: number;
  standbyHours: number;
  standbyCause?: string | null;
  manpowerOnSite: number;
  stepsCompleted?: readonly number[];
  previousPercent?: number;
}): ProgressCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (entry.percentComplete < 0 || entry.percentComplete > 100) {
    errors.push("Percent complete has to be between 0 and 100.");
  }

  if (entry.standbyHours > 0 && !entry.standbyCause) {
    // §8's cause codes are the entire point of recording standby.
    errors.push(
      "Standby hours need a cause. Hours with no cause prove nothing later — the cause is what a " +
        "variation claim is made of.",
    );
  }

  if (entry.standbyCause && !STANDBY_CAUSES.includes(entry.standbyCause as StandbyCause)) {
    errors.push(`"${entry.standbyCause}" is not one of §8's six cause codes.`);
  }

  if (entry.standbyHours > 0 && entry.manpowerOnSite === 0) {
    warnings.push("Standby with nobody on site. Standby is people waiting; check the crew count.");
  }

  if (entry.hoursWorked === 0 && entry.standbyHours === 0) {
    warnings.push(
      "No hours worked and no standby. If nobody was on site, there may be no day to log.",
    );
  }

  if (entry.previousPercent !== undefined && entry.percentComplete < entry.previousPercent) {
    // Going backwards is legitimate — rework happens — but it is worth a second look rather than a
    // silent overwrite of a number somebody is reporting upward.
    warnings.push(
      `Progress has gone backwards, from ${entry.previousPercent}% to ${entry.percentComplete}%. ` +
        `That happens with rework; make sure it is what you meant.`,
    );
  }

  if ((entry.stepsCompleted?.length ?? 0) === 0 && entry.hoursWorked > 0) {
    warnings.push(
      "Hours worked but no method statement steps ticked off. §8 logs progress against the sequence " +
        "of work, so a day with no steps is hard to read later.",
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---- §8's evidence base -------------------------------------------------------------------------

export interface StandbySummary {
  totalStandbyHours: number;
  totalWorkedHours: number;
  /** Standby hours by cause, only for causes that actually occurred. */
  byCause: { cause: StandbyCause; label: string; hours: number; attribution: string }[];
  /** The half a variation claim rests on. */
  customerCausedHours: number;
  aiesCausedHours: number;
  neitherHours: number;
  message: string;
}

/**
 * Totals the standby, split by whose delay it was (§8).
 *
 * §8 calls this "the evidence base for a variation claim". So the summary leads with the number that
 * matters commercially — hours the customer caused — and reports the other two beside it rather than
 * hiding them. A claim that quietly omits AIES's own equipment failures is one the customer will
 * take apart, and the person preparing it needs to see both halves before they decide what to ask
 * for.
 */
export function summariseStandby(entries: readonly ProgressEntry[]): StandbySummary {
  const hoursByCause = new Map<StandbyCause, number>();
  let totalStandbyHours = 0;
  let totalWorkedHours = 0;

  for (const entry of entries) {
    totalWorkedHours += Number(entry.hoursWorked) || 0;
    const hours = Number(entry.standbyHours) || 0;
    if (hours <= 0) continue;
    totalStandbyHours += hours;

    const cause = entry.standbyCause as StandbyCause | undefined;
    if (cause && STANDBY_CAUSES.includes(cause)) {
      hoursByCause.set(cause, (hoursByCause.get(cause) ?? 0) + hours);
    }
  }

  const byCause = [...hoursByCause.entries()]
    .map(([cause, hours]) => ({
      cause,
      label: STANDBY_CAUSE_LABELS[cause],
      hours,
      attribution: CAUSE_ATTRIBUTION[cause],
    }))
    .sort((a, b) => b.hours - a.hours);

  const sumFor = (attribution: string) =>
    byCause
      .filter((row) => row.attribution === attribution)
      .reduce((sum, row) => sum + row.hours, 0);

  const customerCausedHours = sumFor("customer");
  const aiesCausedHours = sumFor("aies");
  const neitherHours = sumFor("neither");

  return {
    totalStandbyHours,
    totalWorkedHours,
    byCause,
    customerCausedHours,
    aiesCausedHours,
    neitherHours,
    message:
      totalStandbyHours === 0
        ? "No standby recorded. Nothing to claim, and nothing to explain."
        : `${totalStandbyHours} standby hour(s): ${customerCausedHours} caused by the customer, ` +
          `${aiesCausedHours} by us, ${neitherHours} by neither. The first figure is the one a ` +
          `variation claim rests on.`,
  };
}

/**
 * How far along the job is, from the newest log.
 *
 * Reads the latest entry rather than summing daily figures, because `percentComplete` is cumulative
 * by design — summing it would produce numbers over 100 on any job that reported twice.
 */
export function latestProgress(entries: readonly ProgressEntry[]): number {
  if (entries.length === 0) return 0;
  const newest = [...entries].sort(
    (a, b) => new Date(b.logDate).getTime() - new Date(a.logDate).getTime(),
  )[0]!;
  return newest.percentComplete;
}
