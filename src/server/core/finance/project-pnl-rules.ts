/**
 * §6's project profitability — what a job was quoted at, what it actually cost, and the gap.
 *
 * §6 states the purpose in one sentence and it is worth keeping in view: *"The gap between quoted
 * margin and actual margin is the single most useful number the platform can give management,
 * because today it is unknowable."*
 *
 * Pure — no Prisma — so the screen shows exactly what the server computed. On
 * `UI_SAFE_SERVER_MODULES` in eslint.config.mjs.
 */

/**
 * §6's seven sources, as one vocabulary.
 *
 * Named by **where the money went**, not by which module recorded it. A manager asking "why did this
 * job cost what it cost" is not thinking about module boundaries, and a P&L that answers in them is
 * a P&L nobody reads twice.
 */
export const COST_CATEGORIES = [
  "materials",
  "labour",
  "subcontract",
  "equipment",
  "travel",
  "permits",
  "rework",
  "other",
] as const;

export type CostCategory = (typeof COST_CATEGORIES)[number];

export const COST_CATEGORY_LABELS: Record<CostCategory, string> = {
  materials: "Materials and goods",
  labour: "Labour",
  subcontract: "Subcontractors",
  equipment: "Equipment and rental",
  travel: "Travel and site costs",
  permits: "Permits and fees",
  rework: "Rework",
  other: "Other",
};

export interface CostLine {
  category: CostCategory;
  amount: number;
  /** Where it came from, so a figure can be argued with rather than only read. */
  source: string;
}

export interface ProjectPnl {
  contractValue: number;
  quotedCost: number;
  quotedMargin: number;
  quotedMarginPct: number;

  actualCost: number;
  actualMargin: number;
  actualMarginPct: number;

  /**
   * Actual margin percentage minus quoted, in percentage points.
   *
   * Negative means the job earned less than it was sold for. Points rather than a ratio because
   * "eight points down" is how the conversation is actually had.
   */
  marginVariancePts: number;

  byCategory: { category: CostCategory; label: string; amount: number; pctOfCost: number }[];

  /**
   * Cost of poor quality, called out separately.
   *
   * §6: "Rework cost from failed QA rounds, tracked separately — this is the cost of poor quality
   * and it should be reportable on its own, not buried in project cost." It is inside `actualCost`
   * as well, because it was really spent; this is the figure that makes it arguable.
   */
  reworkCost: number;

  /**
   * True when nothing has been costed yet.
   *
   * A project with no costs recorded has a 100% margin arithmetically, which is the most misleading
   * number this screen could show. Callers render the emptiness rather than the percentage.
   */
  noCostsYet: boolean;
}

function pct(part: number, whole: number): number {
  if (whole === 0) return 0;
  return (part / whole) * 100;
}

/**
 * Rolls the cost lines up against what was quoted.
 *
 * ## Why quoted cost comes in rather than being derived
 *
 * The quotation's own `totalCost` is the number the deal was priced on, and it is stored on the
 * order at creation precisely so a later edit to the quotation cannot rewrite history. Recomputing
 * it here from current line costs would undo that — see docs/DECISIONS.md #32, which is the same
 * mistake in the other direction.
 *
 * ## Zero-value projects
 *
 * A project with no contract value — internal work, a goodwill job — would divide by zero on every
 * percentage. `pct` returns 0 rather than NaN, and `noCostsYet` covers the other end. Neither
 * pretends to a margin nobody can compute.
 */
export function projectPnl(input: {
  contractValue: number;
  quotedCost: number;
  costs: readonly CostLine[];
}): ProjectPnl {
  const actualCost = input.costs.reduce((sum, line) => sum + line.amount, 0);

  const totals = new Map<CostCategory, number>();
  for (const line of input.costs) {
    totals.set(line.category, (totals.get(line.category) ?? 0) + line.amount);
  }

  const quotedMargin = input.contractValue - input.quotedCost;
  const actualMargin = input.contractValue - actualCost;

  const quotedMarginPct = pct(quotedMargin, input.contractValue);
  const actualMarginPct = pct(actualMargin, input.contractValue);

  return {
    contractValue: input.contractValue,
    quotedCost: input.quotedCost,
    quotedMargin,
    quotedMarginPct,

    actualCost,
    actualMargin,
    actualMarginPct,

    marginVariancePts: actualMarginPct - quotedMarginPct,

    // Every category, including the empty ones. A cost breakdown that hides its zeroes makes
    // "we spent nothing on subcontractors" and "nobody has entered the subcontractors yet" look
    // identical, and only one of those is good news.
    byCategory: COST_CATEGORIES.map((category) => {
      const amount = totals.get(category) ?? 0;
      return {
        category,
        label: COST_CATEGORY_LABELS[category],
        amount,
        pctOfCost: pct(amount, actualCost),
      };
    }),

    reworkCost: totals.get("rework") ?? 0,
    noCostsYet: input.costs.length === 0,
  };
}

/**
 * What an approved timesheet costs, at the rate that applied on the day it was worked.
 *
 * §6 asks for labour as "approved timesheets × the user's cost rate, including overtime, travel, and
 * standby hours". The multipliers live on the rate rather than being constants here, because
 * Philippine overtime is 1.25 for ordinary days and higher on rest days and holidays, and a company
 * that pays travel at plain time should not have to fake that with a blended hourly figure that then
 * misprices ordinary work.
 *
 * A day with no rate in force costs **zero**, and the caller is told how many such days there were.
 * Guessing a rate would put an invented number into the one figure §6 says management cannot get
 * anywhere else; saying "eleven days have no rate" sends somebody to fix the rates.
 */
export function timesheetCost(
  sheet: {
    regularHours: number;
    overtimeHours: number;
    travelHours: number;
    standbyHours: number;
  },
  rate: {
    hourlyCost: number;
    overtimeMultiplier: number;
    travelMultiplier: number;
    standbyMultiplier: number;
  } | null,
): number {
  if (!rate) return 0;
  return (
    sheet.regularHours * rate.hourlyCost +
    sheet.overtimeHours * rate.hourlyCost * rate.overtimeMultiplier +
    sheet.travelHours * rate.hourlyCost * rate.travelMultiplier +
    sheet.standbyHours * rate.hourlyCost * rate.standbyMultiplier
  );
}

/**
 * The rate in force on a given date — the newest one starting on or before it.
 *
 * Rates are a history, not a setting. A job costed in March must keep March's rate however many
 * times somebody has been given a rise since, or last year's margins move every time payroll does.
 */
export function rateOn<T extends { effectiveFrom: Date | string }>(
  rates: readonly T[],
  date: Date | string,
): T | null {
  const when = new Date(date).getTime();
  let best: T | null = null;
  for (const rate of rates) {
    const from = new Date(rate.effectiveFrom).getTime();
    if (from > when) continue;
    if (!best || from > new Date(best.effectiveFrom).getTime()) best = rate;
  }
  return best;
}
