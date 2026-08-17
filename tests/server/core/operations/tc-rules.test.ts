import { describe, expect, it } from "vitest";
import {
  PUNCH_SEVERITIES,
  TC_RESULTS,
  checkTcRecord,
  closeoutBlockers,
  criterionFixedAtMeasurement,
  describeCriterion,
  evaluateMeasurement,
  evaluateTests,
  parseCriterion,
  suggestedResult,
  tcOutcome,
  type FunctionalTest,
  type PunchItem,
} from "@/server/core/operations/tc-rules";

/**
 * specs/04-operations-projects.md §10, as pure functions.
 *
 * §20 names the test this section owes: "**T&C** flags an out-of-spec measured value against the
 * quoted specification."
 */

const inSpec: FunctionalTest = {
  test: "Loop 4-20mA output",
  criterion: { kind: "range", min: 4, max: 20 },
  criterionSource: "quotation",
  quotationLineId: "ql-1",
  promiseText: "Transmitter, 4-20mA output",
  criterionSetAt: "2026-08-01T00:00:00.000Z",
  measured: 12,
  measuredAt: "2026-08-02T00:00:00.000Z",
};

const base = {
  result: "accepted" as const,
  functionalTests: [inSpec],
  punchItems: [] as PunchItem[],
  witnessedByCustomer: true,
  calibrationAssetsUsed: ["FLUKE-744"],
  remarks: null,
};

describe("§10's vocabulary", () => {
  it("is the three results and three severities the spec names", () => {
    expect([...TC_RESULTS]).toEqual(["accepted", "accepted_with_punch", "rejected"]);
    expect([...PUNCH_SEVERITIES]).toEqual(["minor", "major", "critical"]);
  });
});

describe("reading a criterion an engineer would actually write", () => {
  it("reads the forms that appear on a data sheet", () => {
    expect(parseCriterion(">= 5").criterion).toEqual({ kind: "min", min: 5 });
    expect(parseCriterion("≥5").criterion).toEqual({ kind: "min", min: 5 });
    expect(parseCriterion("max 10").criterion).toEqual({ kind: "max", max: 10 });
    expect(parseCriterion("4-20").criterion).toEqual({ kind: "range", min: 4, max: 20 });
    expect(parseCriterion("4 to 20").criterion).toEqual({ kind: "range", min: 4, max: 20 });
    expect(parseCriterion("230 ± 5").criterion).toEqual({
      kind: "nominal",
      nominal: 230,
      tolerance: 5,
      toleranceKind: "absolute",
    });
    expect(parseCriterion("230 +/- 2%").criterion).toEqual({
      kind: "nominal",
      nominal: 230,
      tolerance: 2,
      toleranceKind: "percent",
    });
  });

  it("treats anything else as a qualitative check", () => {
    expect(parseCriterion("no leaks").criterion).toEqual({
      kind: "qualitative",
      expected: "no leaks",
    });
  });

  /**
   * The refusal that matters. "230" does not say whether 229.8 passes. Reading it as exact equality
   * would fail nearly every real measurement; reading it as "about 230" would pass nearly all of
   * them. Either way the certificate would not mean what its reader thinks.
   */
  it("refuses a bare number, because it is a value and not a criterion", () => {
    const parsed = parseCriterion("230");
    expect(parsed.criterion).toBeNull();
    expect(parsed.error).toMatch(/does not say how close is close enough/);
  });

  it("refuses a range that runs backwards", () => {
    expect(parseCriterion("20-4").error).toMatch(/runs backwards/);
  });

  it("says the criterion back in words", () => {
    expect(describeCriterion({ kind: "range", min: 4, max: 20 })).toBe("4 to 20");
    expect(
      describeCriterion({
        kind: "nominal",
        nominal: 230,
        tolerance: 2,
        toleranceKind: "percent",
      }),
    ).toBe("230 ± 2%");
  });
});

describe("§10's automatic out-of-spec flag", () => {
  /** §20's named test. */
  it("flags a measured value outside the quoted specification", () => {
    const evaluation = evaluateMeasurement({ kind: "range", min: 4, max: 20 }, 22.5);
    expect(evaluation.verdict).toBe("fail");
    expect(evaluation.reason).toMatch(/22.5 is outside 4 to 20/);
  });

  it("passes a value inside it", () => {
    expect(evaluateMeasurement({ kind: "range", min: 4, max: 20 }, 12).verdict).toBe("pass");
  });

  it("works the tolerance out for a nominal criterion", () => {
    const criterion = {
      kind: "nominal",
      nominal: 230,
      tolerance: 2,
      toleranceKind: "percent",
    } as const;
    expect(evaluateMeasurement(criterion, 234).verdict).toBe("pass"); // 225.4 – 234.6
    expect(evaluateMeasurement(criterion, 235).verdict).toBe("fail");
  });

  /**
   * The third verdict is the one that earns its place: the same distinction §7's undecided material
   * gate and §9's waived client inspection turn on. A question nobody answered must not be stored as
   * an answer.
   */
  it("calls an unmeasured test indeterminate rather than passed", () => {
    const evaluation = evaluateMeasurement({ kind: "min", min: 5 }, null);
    expect(evaluation.verdict).toBe("indeterminate");
    expect(evaluation.reason).toMatch(/Not measured/);
  });

  it("calls a non-numeric reading against a numeric limit indeterminate", () => {
    expect(evaluateMeasurement({ kind: "min", min: 5 }, "seemed fine").verdict).toBe(
      "indeterminate",
    );
  });

  it("refuses to guess what an ambiguous qualitative answer meant", () => {
    const criterion = { kind: "qualitative", expected: "no leaks" } as const;
    expect(evaluateMeasurement(criterion, "no leaks").verdict).toBe("pass");
    expect(evaluateMeasurement(criterion, "pass").verdict).toBe("pass");
    expect(evaluateMeasurement(criterion, "fail").verdict).toBe("fail");
    expect(evaluateMeasurement(criterion, "one weep on the flange").verdict).toBe("indeterminate");
  });

  it("has nothing to judge a test with no criterion against", () => {
    expect(evaluateMeasurement(null, 12).verdict).toBe("indeterminate");
  });
});

describe("§10's provenance", () => {
  it("accepts a criterion fixed before the reading was taken", () => {
    expect(criterionFixedAtMeasurement(inSpec)).toBe(false);
  });

  /** A limit written after the measurement it judges proves less, so the record says so. */
  it("marks a criterion fixed in the same act as its reading", () => {
    expect(
      criterionFixedAtMeasurement({
        ...inSpec,
        criterionSetAt: "2026-08-02T00:00:00.000Z",
        measuredAt: "2026-08-02T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  /** An unprovable claim of prior intent is worth no more than no claim. */
  it("counts a missing timestamp as fixed at measurement", () => {
    expect(criterionFixedAtMeasurement({ ...inSpec, criterionSetAt: null })).toBe(true);
  });

  it("does not accuse a test nobody has measured yet", () => {
    expect(criterionFixedAtMeasurement({ ...inSpec, measured: null, measuredAt: null })).toBe(
      false,
    );
  });

  it("sorts tests into the buckets the record reports", () => {
    const summary = evaluateTests([
      inSpec,
      { ...inSpec, test: "Insulation resistance", criterionSource: "stated", measured: 2 },
      { ...inSpec, test: "Vibration", measured: null, measuredAt: null },
    ]);
    expect(summary.failed).toHaveLength(1); // insulation, 2 is outside 4–20
    expect(summary.indeterminate).toHaveLength(1); // vibration, never measured
    expect(summary.stated).toHaveLength(1);
  });
});

describe("§10's completion rules", () => {
  it("accepts a clean run", () => {
    expect(checkTcRecord(base).ok).toBe(true);
  });

  /**
   * The rule worth defending. A flag somebody can accept over without saying so is a flag that does
   * nothing.
   */
  it("refuses a clean acceptance while a test is out of spec", () => {
    const check = checkTcRecord({
      ...base,
      functionalTests: [{ ...inSpec, measured: 25 }],
    });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/cannot be recorded as a clean acceptance/);
  });

  it("refuses a clean acceptance while a test was never resolved", () => {
    const check = checkTcRecord({
      ...base,
      functionalTests: [{ ...inSpec, measured: null, measuredAt: null }],
    });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/An unmeasured test is not a passed one/);
  });

  /** Accepting real work with a real exception is legitimate — it just has to be carried. */
  it("accepts an out-of-spec result carried on the punch list", () => {
    const check = checkTcRecord({
      ...base,
      result: "accepted_with_punch",
      functionalTests: [{ ...inSpec, measured: 25 }],
      punchItems: [{ description: "Recalibrate transmitter", severity: "major", ownerId: "u1" }],
    });
    expect(check.ok).toBe(true);
  });

  it("refuses an acceptance with a punch list and nothing on it", () => {
    const check = checkTcRecord({ ...base, result: "accepted_with_punch" });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/at least one item on the list/);
  });

  it("refuses a rejection with nothing behind it", () => {
    const check = checkTcRecord({ ...base, result: "rejected" });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/needs a failed test or a punch item/);
  });

  it("refuses commissioning with no tests at all", () => {
    const check = checkTcRecord({ ...base, functionalTests: [] });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/signature on an empty page/);
  });

  /** §9's rule about the waived client inspection, applied to the witness. */
  it("refuses an unwitnessed commissioning with no explanation", () => {
    const check = checkTcRecord({ ...base, witnessedByCustomer: false });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/indistinguishable from one nobody ran/);
  });

  it("accepts an unwitnessed commissioning that is explained", () => {
    const check = checkTcRecord({
      ...base,
      witnessedByCustomer: false,
      remarks: "Plant shut for the holiday; customer accepted our readings by email.",
    });
    expect(check.ok).toBe(true);
  });

  /** Claiming a provenance the record cannot support is worse than admitting there is none. */
  it("refuses a criterion that claims the quotation but names no line", () => {
    const check = checkTcRecord({
      ...base,
      functionalTests: [{ ...inSpec, quotationLineId: null }],
    });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/claims its criterion came from the quotation/);
  });

  it("warns that stated criteria limit what the automatic check is worth", () => {
    const check = checkTcRecord({
      ...base,
      functionalTests: [{ ...inSpec, criterionSource: "stated", quotationLineId: null }],
    });
    expect(check.ok).toBe(true);
    expect(check.warnings.join(" ")).toMatch(/only as good as the criteria it is given/);
  });

  it("warns when a criterion was set in the same act as its reading", () => {
    const check = checkTcRecord({
      ...base,
      functionalTests: [{ ...inSpec, criterionSetAt: inSpec.measuredAt }],
    });
    expect(check.ok).toBe(true);
    expect(check.warnings.join(" ")).toMatch(/a limit written after the measurement proves less/);
  });

  it("warns when a numeric reading names no instrument", () => {
    const check = checkTcRecord({ ...base, calibrationAssetsUsed: [] });
    expect(check.warnings.join(" ")).toMatch(/No instruments recorded/);
  });

  it("warns about a critical punch item with no owner", () => {
    const check = checkTcRecord({
      ...base,
      result: "accepted_with_punch",
      punchItems: [{ description: "Earth bond missing", severity: "critical" }],
    });
    expect(check.warnings.join(" ")).toMatch(/blocks close-out and belongs to nobody/);
  });
});

describe("§10's punch list", () => {
  /** §10: "Critical punch items block project close-out." */
  it("blocks close-out on open critical items only", () => {
    const items: PunchItem[] = [
      { description: "Earth bond missing", severity: "critical" },
      { description: "Already fixed", severity: "critical", status: "closed" },
      { description: "Touch-up paint", severity: "minor" },
    ];
    const blockers = closeoutBlockers(items);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.description).toBe("Earth bond missing");
  });
});

describe("§10's outcome", () => {
  it("loops a rejection back to the crew, as §9's does", () => {
    const outcome = tcOutcome({ result: "rejected", punchItems: [] });
    expect(outcome.ticketStatus).toBe("in_progress");
  });

  it("sends an acceptance to close-out", () => {
    expect(tcOutcome({ result: "accepted", punchItems: [] }).ticketStatus).toBe("for_closeout");
  });

  it("says close-out stays blocked when a critical item is open", () => {
    const outcome = tcOutcome({
      result: "accepted_with_punch",
      punchItems: [{ description: "Earth bond missing", severity: "critical" }],
    });
    expect(outcome.ticketStatus).toBe("for_closeout");
    expect(outcome.message).toMatch(/close-out stays blocked/);
  });

  it("says so when the punch list does not block anything", () => {
    const outcome = tcOutcome({
      result: "accepted_with_punch",
      punchItems: [{ description: "Touch-up paint", severity: "minor" }],
    });
    expect(outcome.message).toMatch(/close-out is not blocked/);
  });
});

describe("§10's suggestion", () => {
  /** Offered, never written on anybody's behalf — the engineer signs the certificate. */
  it("proposes a punch list when something is out of spec", () => {
    const suggestion = suggestedResult([{ ...inSpec, measured: 25 }], []);
    expect(suggestion.result).toBe("accepted_with_punch");
    expect(suggestion.because).toMatch(/out of spec/);
  });

  it("proposes a clean acceptance when everything is in spec", () => {
    expect(suggestedResult([inSpec], []).result).toBe("accepted");
  });

  it("does not propose a clean acceptance over an unresolved test", () => {
    expect(suggestedResult([{ ...inSpec, measured: null, measuredAt: null }], []).result).toBe(
      "accepted_with_punch",
    );
  });
});
