import { describe, expect, it } from "vitest";
import {
  UTILITIES,
  inspectionCompleteness,
  inspectionRequiredForTicket,
  isInspectionEditable,
  readUtilities,
  scopeChangeVerdict,
} from "@/server/core/operations/site-inspection-rules";

/**
 * specs/04-operations-projects.md §6.1, as pure functions.
 *
 * The rule that carries the most weight here is the scope-change one, because §6.1 says so: "This
 * link is one of the highest-value things the platform does." A link that fires twice is one people
 * stop reading, and a link that fires on an empty flag tells sales nothing they can act on.
 */

const BASE = {
  inspectedAt: new Date("2026-08-20T00:00:00.000Z"),
  inspectedByIds: ["tech-1"],
  findings: "Existing flow meter is a DN100, not the DN150 on the drawing.",
  photoFileIds: ["file-1"],
  scopeChangeIdentified: false,
  scopeChangeNotes: null as string | null,
};

describe("§6.1's completeness", () => {
  it("accepts a report with a date, an attendee and findings", () => {
    expect(inspectionCompleteness(BASE).complete).toBe(true);
  });

  it("names each missing field rather than refusing generically", () => {
    const check = inspectionCompleteness({
      ...BASE,
      inspectedAt: null,
      inspectedByIds: [],
      findings: "  ",
    });
    expect(check.complete).toBe(false);
    expect(check.missing).toHaveLength(3);
    expect(check.missing.join(" ")).toMatch(/who attended/);
  });

  /**
   * The deliberate non-rule.
   *
   * A refused-entry visit produces no photographs and is still a real inspection whose finding is
   * "we could not get in". Blocking on photographs would make that unrecordable, and a gate people
   * cannot satisfy honestly gets satisfied dishonestly — one meaningless photograph to clear it.
   */
  it("warns about missing photographs without blocking", () => {
    const check = inspectionCompleteness({ ...BASE, photoFileIds: [] });
    expect(check.complete).toBe(true);
    expect(check.warnings.join(" ")).toMatch(/No photographs/);
  });

  /** The one hard rule beyond the three: a scope-change flag with nothing sales can act on. */
  it("refuses a scope change flagged with no explanation", () => {
    const check = inspectionCompleteness({
      ...BASE,
      scopeChangeIdentified: true,
      scopeChangeNotes: null,
    });
    expect(check.complete).toBe(false);
    expect(check.missing.join(" ")).toMatch(/what changed about the scope/);
  });

  it("accepts a scope change that is explained", () => {
    const check = inspectionCompleteness({
      ...BASE,
      scopeChangeIdentified: true,
      scopeChangeNotes: "Two extra tie-in points not on the drawing.",
    });
    expect(check.complete).toBe(true);
  });
});

describe("§6's branch", () => {
  it("says a new project wants a survey", () => {
    expect(inspectionRequiredForTicket({ type: "new_project" })).toBe(true);
  });

  it("does not require one for the other three types", () => {
    for (const type of ["installation", "after_sales", "delivery"]) {
      expect(inspectionRequiredForTicket({ type })).toBe(false);
    }
  });
});

describe("editability", () => {
  it("allows edits while scheduled or completed", () => {
    expect(isInspectionEditable("scheduled")).toBe(true);
    expect(isInspectionEditable("completed")).toBe(true);
  });

  it("closes an approved report — a signature does not get rewritten", () => {
    expect(isInspectionEditable("approved")).toBe(false);
  });
});

describe("§6.1's scope-change link", () => {
  it("does not fire when nothing was flagged", () => {
    expect(
      scopeChangeVerdict({
        scopeChangeIdentified: false,
        scopeChangeNotes: null,
        scopeChangeReportedAt: null,
      }).shouldReport,
    ).toBe(false);
  });

  it("fires on the first save that flags it with an explanation", () => {
    expect(
      scopeChangeVerdict({
        scopeChangeIdentified: true,
        scopeChangeNotes: "Two extra tie-in points.",
        scopeChangeReportedAt: null,
      }).shouldReport,
    ).toBe(true);
  });

  /**
   * The rule that keeps the warning worth reading.
   *
   * A surveyor correcting a measurement re-saves the record. If that sent a second "the job is
   * bigger than quoted" notification, sales would learn to close them unread — which is precisely
   * the warning §6.1 says must land.
   */
  it("never fires twice for one inspection", () => {
    const verdict = scopeChangeVerdict({
      scopeChangeIdentified: true,
      scopeChangeNotes: "Two extra tie-in points.",
      scopeChangeReportedAt: new Date("2026-08-20T00:00:00.000Z"),
    });
    expect(verdict.shouldReport).toBe(false);
    expect(verdict.reason).toMatch(/already been told/);
  });

  it("holds back a flag with no explanation, so a half-filled draft does not page sales", () => {
    const verdict = scopeChangeVerdict({
      scopeChangeIdentified: true,
      scopeChangeNotes: "   ",
      scopeChangeReportedAt: null,
    });
    expect(verdict.shouldReport).toBe(false);
    expect(verdict.reason).toMatch(/Say what changed/);
  });
});

describe("§6.1's utilities", () => {
  it("reports all five, whatever the record holds", () => {
    expect(readUtilities({}).map((u) => u.key)).toEqual([...UTILITIES]);
  });

  /**
   * Absent is not "not available", and the difference is a wasted day.
   *
   * A planner who reads "no crane" brings one. A planner who reads "nobody checked" asks. Collapsing
   * the two into a boolean would turn every unanswered question into a confident "no".
   */
  it("keeps unchecked distinct from unavailable", () => {
    const utilities = readUtilities({ power: { available: false }, water: { available: true } });
    const byKey = Object.fromEntries(utilities.map((u) => [u.key, u.available]));
    expect(byKey.power).toBe(false);
    expect(byKey.water).toBe(true);
    expect(byKey.crane).toBeNull();
  });

  it("carries a note when one was left", () => {
    const utilities = readUtilities({ power: { available: true, note: "415V, 60A spare way" } });
    expect(utilities.find((u) => u.key === "power")?.note).toBe("415V, 60A spare way");
  });

  it("survives a malformed column rather than throwing at a surveyor", () => {
    expect(readUtilities(null)).toHaveLength(5);
    expect(readUtilities("nonsense")).toHaveLength(5);
    expect(readUtilities({ power: "yes" }).find((u) => u.key === "power")?.available).toBeNull();
  });
});
