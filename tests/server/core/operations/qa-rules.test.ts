import { describe, expect, it } from "vitest";
import {
  DEFECT_SEVERITIES,
  EVIDENCE_TYPES,
  checkQaRecord,
  firstTimeRightRate,
  ncrWorthyDefects,
  qaOutcome,
  type Defect,
} from "@/server/core/operations/qa-rules";

/**
 * specs/04-operations-projects.md §9, as pure functions.
 *
 * The assertion the section turns on: "**`approved = true` cannot be saved without at least one
 * evidence file.** Not a warning, a hard block. An unevidenced approval is an assertion."
 */

const EVIDENCED = {
  approved: true,
  clientInspected: true,
  evidenceFileIds: ["file-1"],
  evidenceType: "client_signed_form",
  defects: [] as Defect[],
  remarks: null,
};

describe("§9's vocabulary", () => {
  it("is the five evidence types and three severities the spec names", () => {
    expect([...EVIDENCE_TYPES]).toEqual([
      "client_signed_form",
      "email_confirmation",
      "inspection_report",
      "punch_sheet",
      "other",
    ]);
    expect([...DEFECT_SEVERITIES]).toEqual(["minor", "major", "critical"]);
  });
});

describe("§9's hard block", () => {
  it("accepts an approval backed by the client's document", () => {
    expect(checkQaRecord(EVIDENCED).ok).toBe(true);
  });

  /** The rule the whole section rests on. */
  it("refuses an approval with no evidence at all", () => {
    const check = checkQaRecord({ ...EVIDENCED, evidenceFileIds: [] });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/needs the client's own documentation/);
  });

  it("refuses an approval with evidence but no stated type", () => {
    const check = checkQaRecord({ ...EVIDENCED, evidenceType: null });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/what kind of evidence/);
  });

  /**
   * §9 anticipates the awkward case and answers it: a written-up verbal approval marked `other` is
   * "weak evidence but it is evidence, and it is honest about what it is". The block has to be
   * satisfiable in every real situation, which is what makes it fair to enforce.
   */
  it("accepts a written-up verbal approval marked as other", () => {
    const check = checkQaRecord({
      ...EVIDENCED,
      evidenceType: "other",
      remarks: "Approved verbally by the plant engineer on site; note written up the same day.",
    });
    expect(check.ok).toBe(true);
  });

  it("does not require evidence to record a rejection", () => {
    const check = checkQaRecord({
      ...EVIDENCED,
      approved: false,
      evidenceFileIds: [],
      evidenceType: null,
      defects: [{ description: "Weld porosity", severity: "major" }],
    });
    expect(check.ok).toBe(true);
  });

  it("refuses a rejection with no defects listed", () => {
    const check = checkQaRecord({ ...EVIDENCED, approved: false, defects: [] });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/needs at least one defect/);
  });

  /**
   * §9: "A silently skipped gate and a deliberately waived one look identical in a database unless
   * you make them different." A waiver with no explanation is a blank gate wearing a label.
   */
  it("refuses a non-inspection with no explanation", () => {
    const check = checkQaRecord({ ...EVIDENCED, clientInspected: false, remarks: null });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/indistinguishable from one nobody opened/);
  });

  it("accepts a non-inspection that is explained", () => {
    const check = checkQaRecord({
      ...EVIDENCED,
      clientInspected: false,
      remarks: "Client waived inspection under the framework agreement; email attached.",
    });
    expect(check.ok).toBe(true);
  });

  /** Approval with a punch list is legitimate, and worth saying out loud. */
  it("warns when work is approved with defects still open", () => {
    const check = checkQaRecord({
      ...EVIDENCED,
      defects: [{ description: "Touch-up paint", severity: "minor" }],
    });
    expect(check.ok).toBe(true);
    expect(check.warnings.join(" ")).toMatch(/approval is not closure/i);
  });
});

describe("§9's rework loop", () => {
  /** §9: "loops failures back to Project Execution — implement that literally." */
  it("sends a rejection back to in_progress and counts the round", () => {
    const outcome = qaOutcome({
      approved: false,
      previousRounds: 0,
      defects: [{ description: "Weld porosity", severity: "major" }],
    });
    expect(outcome.ticketStatus).toBe("in_progress");
    expect(outcome.reworkRound).toBe(1);
  });

  it("keeps counting across rounds", () => {
    expect(
      qaOutcome({
        approved: false,
        previousRounds: 2,
        defects: [{ description: "x", severity: "minor" }],
      }).reworkRound,
    ).toBe(3);
  });

  it("moves an approval on to testing and commissioning", () => {
    const outcome = qaOutcome({ approved: true, previousRounds: 0, defects: [] });
    expect(outcome.ticketStatus).toBe("tc");
    expect(outcome.message).toMatch(/first time/);
  });

  it("names the defects module 08 will raise an NCR for", () => {
    const defects: Defect[] = [
      { description: "Touch-up paint", severity: "minor" },
      { description: "Weld porosity", severity: "major" },
      { description: "Wrong pressure rating", severity: "critical" },
    ];
    expect(ncrWorthyDefects(defects).map((d) => d.severity)).toEqual(["major", "critical"]);
  });
});

describe("§9's first-time-right rate", () => {
  it("counts approvals that took no rework", () => {
    const rate = firstTimeRightRate([
      { approved: true, reworkRound: 0 },
      { approved: true, reworkRound: 0 },
      { approved: true, reworkRound: 2 },
    ]);
    expect(rate.total).toBe(3);
    expect(rate.firstTimeRight).toBe(2);
    expect(rate.ratePct).toBeCloseTo(66.7, 1);
  });

  /**
   * A job still going round the loop is not yet a first-time-right failure — it might be approved on
   * round two. Counting it early would make the number move backwards as work finishes, which is the
   * fastest way to make a metric distrusted.
   */
  it("ignores records still in the rework loop", () => {
    const rate = firstTimeRightRate([
      { approved: true, reworkRound: 0 },
      { approved: false, reworkRound: 1 },
    ]);
    expect(rate.total).toBe(1);
    expect(rate.ratePct).toBe(100);
  });

  /** A rate over zero jobs is not 100%. */
  it("reports no rate at all when nothing has been inspected", () => {
    const rate = firstTimeRightRate([]);
    expect(rate.ratePct).toBeNull();
    expect(rate.message).toMatch(/no rate to report/);
  });
});
