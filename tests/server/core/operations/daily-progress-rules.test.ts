import { describe, expect, it } from "vitest";
import {
  CAUSE_ATTRIBUTION,
  STANDBY_CAUSES,
  checkProgressEntry,
  latestProgress,
  summariseStandby,
} from "@/server/core/operations/daily-progress-rules";

/**
 * specs/04-operations-projects.md §8's execution half, as pure functions.
 *
 * §8: "**Standby and delay tracking** with cause codes… This is the evidence base for a variation
 * claim, and today it exists only in people's memory." So the assertions that matter are about the
 * cause codes being closed, and about whose delay each one is — a claim that mixes the two falls
 * apart on the first line somebody checks.
 */

const GOOD = {
  percentComplete: 40,
  hoursWorked: 8,
  standbyHours: 0,
  manpowerOnSite: 3,
  stepsCompleted: [1, 2],
};

describe("§8's cause codes", () => {
  it("is the six the spec names, and nothing else", () => {
    expect([...STANDBY_CAUSES]).toEqual([
      "client_not_ready",
      "permit_delay",
      "weather",
      "material_shortage",
      "equipment_failure",
      "access_denied",
    ]);
  });

  /**
   * The judgement that makes the log worth keeping. A variation claim rests on standby the customer
   * caused; standby AIES caused is a cost the company swallows.
   */
  it("attributes each cause to whoever actually caused it", () => {
    expect(CAUSE_ATTRIBUTION.client_not_ready).toBe("customer");
    expect(CAUSE_ATTRIBUTION.permit_delay).toBe("customer");
    expect(CAUSE_ATTRIBUTION.access_denied).toBe("customer");
    expect(CAUSE_ATTRIBUTION.material_shortage).toBe("aies");
    expect(CAUSE_ATTRIBUTION.equipment_failure).toBe("aies");
  });

  /**
   * Weather is nobody's fault, and most contracts treat it as an extension of time rather than
   * money. Claiming it as the client's would be the overreach that loses the argument about the
   * rest.
   */
  it("attributes weather to neither party", () => {
    expect(CAUSE_ATTRIBUTION.weather).toBe("neither");
  });
});

describe("what a day's log has to say", () => {
  it("accepts an ordinary day", () => {
    expect(checkProgressEntry(GOOD).ok).toBe(true);
  });

  /** The one hard rule: hours with no cause prove nothing later. */
  it("refuses standby hours with no cause", () => {
    const check = checkProgressEntry({ ...GOOD, standbyHours: 4 });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/Standby hours need a cause/);
  });

  it("accepts standby with one of the six", () => {
    expect(
      checkProgressEntry({ ...GOOD, standbyHours: 4, standbyCause: "client_not_ready" }).ok,
    ).toBe(true);
  });

  it("refuses a cause that is not one of the six", () => {
    const check = checkProgressEntry({ ...GOOD, standbyHours: 4, standbyCause: "just_because" });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/not one of §8's six/);
  });

  it("refuses a percentage outside 0 to 100", () => {
    expect(checkProgressEntry({ ...GOOD, percentComplete: 140 }).ok).toBe(false);
    expect(checkProgressEntry({ ...GOOD, percentComplete: -1 }).ok).toBe(false);
  });

  /**
   * Everything else warns. A site day is messy, and a form that refuses a messy day gets filled in
   * with fiction — which is worse than a gap, because the fiction is what a claim later rests on.
   */
  it("warns rather than refuses when progress goes backwards", () => {
    const check = checkProgressEntry({ ...GOOD, percentComplete: 30, previousPercent: 45 });
    expect(check.ok).toBe(true);
    expect(check.warnings.join(" ")).toMatch(/gone backwards/);
  });

  it("warns about standby with nobody on site", () => {
    const check = checkProgressEntry({
      ...GOOD,
      manpowerOnSite: 0,
      standbyHours: 4,
      standbyCause: "weather",
    });
    expect(check.ok).toBe(true);
    expect(check.warnings.join(" ")).toMatch(/nobody on site/);
  });

  it("warns when hours were worked but no method statement step was ticked", () => {
    const check = checkProgressEntry({ ...GOOD, stepsCompleted: [] });
    expect(check.ok).toBe(true);
    expect(check.warnings.join(" ")).toMatch(/no method statement steps/);
  });
});

describe("§8's evidence base", () => {
  const entries = [
    { logDate: "2026-08-10", percentComplete: 20, hoursWorked: 8, standbyHours: 0 },
    {
      logDate: "2026-08-11",
      percentComplete: 30,
      hoursWorked: 4,
      standbyHours: 4,
      standbyCause: "client_not_ready",
    },
    {
      logDate: "2026-08-12",
      percentComplete: 45,
      hoursWorked: 6,
      standbyHours: 2,
      standbyCause: "access_denied",
    },
    {
      logDate: "2026-08-13",
      percentComplete: 55,
      hoursWorked: 5,
      standbyHours: 3,
      standbyCause: "equipment_failure",
    },
    {
      logDate: "2026-08-14",
      percentComplete: 60,
      hoursWorked: 7,
      standbyHours: 1,
      standbyCause: "weather",
    },
  ];

  it("totals the standby and splits it by who caused it", () => {
    const summary = summariseStandby(entries);
    expect(summary.totalStandbyHours).toBe(10);
    expect(summary.customerCausedHours).toBe(6);
    expect(summary.aiesCausedHours).toBe(3);
    expect(summary.neitherHours).toBe(1);
  });

  /**
   * A claim that quietly omits AIES's own equipment failures is one the customer takes apart. The
   * person preparing it needs both halves before deciding what to ask for.
   */
  it("reports our own delays alongside theirs rather than hiding them", () => {
    const summary = summariseStandby(entries);
    expect(summary.message).toMatch(/3 by us/);
    expect(summary.byCause.some((row) => row.attribution === "aies")).toBe(true);
  });

  it("orders the causes by hours, so the biggest is first", () => {
    const summary = summariseStandby(entries);
    expect(summary.byCause[0]!.cause).toBe("client_not_ready");
  });

  it("says plainly when there is nothing to claim", () => {
    const summary = summariseStandby([
      { logDate: "2026-08-10", percentComplete: 10, hoursWorked: 8, standbyHours: 0 },
    ]);
    expect(summary.totalStandbyHours).toBe(0);
    expect(summary.message).toMatch(/Nothing to claim/);
  });

  /**
   * `percentComplete` is cumulative by design, so the latest entry is the answer. Summing would
   * produce numbers over 100 on any job that reported twice.
   */
  it("reads progress from the newest day, not by adding them up", () => {
    expect(latestProgress(entries)).toBe(60);
    expect(latestProgress([])).toBe(0);
  });

  it("reads the newest day even when they arrive out of order", () => {
    expect(latestProgress([entries[2]!, entries[4]!, entries[0]!])).toBe(60);
  });
});
