import { describe, expect, it } from "vitest";
import {
  projectPnl,
  rateOn,
  timesheetCost,
  type CostLine,
} from "@/server/core/finance/project-pnl-rules";

/**
 * §6's project profitability.
 *
 * §6 states the purpose plainly: *"The gap between quoted margin and actual margin is the single
 * most useful number the platform can give management, because today it is unknowable."* These tests
 * pin the arithmetic of that gap, and — more importantly — the cases where the honest answer is to
 * refuse to produce a number.
 */

const line = (category: CostLine["category"], amount: number): CostLine => ({
  category,
  amount,
  source: "test",
});

describe("the gap between quoted and actual", () => {
  it("reports the variance in percentage points, negative when the job earned less", () => {
    // Sold for 1,000,000 against a quoted cost of 700,000 — 30% quoted.
    // It actually cost 820,000, so 18% actual: twelve points down.
    const pnl = projectPnl({
      contractValue: 1_000_000,
      quotedCost: 700_000,
      costs: [line("materials", 600_000), line("labour", 220_000)],
    });

    expect(pnl.quotedMarginPct).toBeCloseTo(30);
    expect(pnl.actualMarginPct).toBeCloseTo(18);
    expect(pnl.marginVariancePts).toBeCloseTo(-12);
  });

  it("reports a job that beat its quote as positive", () => {
    const pnl = projectPnl({
      contractValue: 500_000,
      quotedCost: 400_000,
      costs: [line("materials", 350_000)],
    });
    expect(pnl.marginVariancePts).toBeGreaterThan(0);
  });

  /**
   * The case that would otherwise put a spectacular lie on a screen.
   *
   * A project nobody has costed yet has, arithmetically, a 100% margin. Rendering that would tell
   * management the job is the most profitable they have ever done, on the day it starts.
   */
  it("says nothing has been costed rather than reporting a 100% margin", () => {
    const pnl = projectPnl({ contractValue: 250_000, quotedCost: 200_000, costs: [] });
    expect(pnl.noCostsYet).toBe(true);
  });

  it("does not divide by zero on a project with no contract value", () => {
    // Internal work, or a goodwill job. Percentages are meaningless rather than infinite.
    const pnl = projectPnl({ contractValue: 0, quotedCost: 0, costs: [line("labour", 40_000)] });
    expect(Number.isFinite(pnl.actualMarginPct)).toBe(true);
    expect(pnl.actualMarginPct).toBe(0);
  });

  it("keeps every category, including the empty ones", () => {
    /*
      A breakdown that hides its zeroes makes "we spent nothing on subcontractors" and "nobody has
      entered the subcontractors yet" look identical, and only one of those is good news.
    */
    const pnl = projectPnl({
      contractValue: 100_000,
      quotedCost: 60_000,
      costs: [line("labour", 50_000)],
    });
    expect(pnl.byCategory).toHaveLength(8);
    expect(pnl.byCategory.find((row) => row.category === "subcontract")?.amount).toBe(0);
  });

  it("reports rework on its own as well as inside the total", () => {
    // §6: "tracked separately — this is the cost of poor quality and it should be reportable on its
    // own, not buried in project cost." Both, not either.
    const pnl = projectPnl({
      contractValue: 100_000,
      quotedCost: 60_000,
      costs: [line("labour", 50_000), line("rework", 12_000)],
    });
    expect(pnl.reworkCost).toBe(12_000);
    expect(pnl.actualCost).toBe(62_000);
  });
});

describe("what an hour costs", () => {
  const rate = {
    hourlyCost: 200,
    overtimeMultiplier: 1.25,
    travelMultiplier: 1,
    standbyMultiplier: 1,
  };

  it("applies each multiplier to its own kind of hour", () => {
    const cost = timesheetCost(
      { regularHours: 8, overtimeHours: 2, travelHours: 3, standbyHours: 1 },
      rate,
    );
    // 8×200 + 2×200×1.25 + 3×200 + 1×200
    expect(cost).toBe(1600 + 500 + 600 + 200);
  });

  /**
   * The one that keeps the margin honest.
   *
   * A day worked by somebody with no rate on file costs zero here — and the *service* counts those
   * days and says so on screen. Guessing a rate would put a fabricated figure into the one number
   * §6 says management cannot get anywhere else.
   */
  it("costs nothing when no rate is in force, so the caller must report it", () => {
    expect(
      timesheetCost({ regularHours: 8, overtimeHours: 0, travelHours: 0, standbyHours: 0 }, null),
    ).toBe(0);
  });
});

describe("which rate applied on the day", () => {
  const rates = [
    { effectiveFrom: "2025-01-01", hourlyCost: 150 },
    { effectiveFrom: "2026-03-01", hourlyCost: 200 },
  ];

  it("uses the newest rate starting on or before the day worked", () => {
    expect(rateOn(rates, "2026-06-15")?.hourlyCost).toBe(200);
    expect(rateOn(rates, "2026-03-01")?.hourlyCost).toBe(200);
  });

  /**
   * Rates are a history, not a setting.
   *
   * A job costed in February must keep February's rate however many rises have happened since, or
   * last year's margins move every time payroll does — and a report whose past changes is a report
   * nobody can act on.
   */
  it("keeps an old job on the old rate", () => {
    expect(rateOn(rates, "2026-02-28")?.hourlyCost).toBe(150);
  });

  it("returns nothing for work done before any rate existed", () => {
    expect(rateOn(rates, "2024-11-01")).toBeNull();
  });
});
