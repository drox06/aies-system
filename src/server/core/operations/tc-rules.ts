/**
 * Testing and commissioning rules (specs/04-operations-projects.md §10).
 *
 * Pure — no Prisma, no node builtins — so the screen shows exactly what the server enforces. On
 * `UI_SAFE_SERVER_MODULES` in eslint.config.mjs.
 *
 * §10's load-bearing sentence: "Test results are compared against the **specification from the
 * accepted quotation**, not against a value typed in by the technician. Out-of-spec results are
 * flagged automatically."
 *
 * Module 02 stores what was promised as prose — `description`, `longDescription`, `modelNumber` —
 * so there is no number anywhere for this file to read. A comparison engine that invents the
 * criterion at test time and then congratulates itself for checking against it is theatre: the
 * person whose work is being judged supplies both halves.
 *
 * What is enforced instead is **provenance**. Every criterion says where it came from and when it
 * was fixed, a criterion that cannot name a promised line is marked as merely stated, and one fixed
 * in the same act as its own measurement is called out. The automatic flag is then worth exactly
 * what its criteria are worth, and the record says what they are worth. docs/DECISIONS.md #69.
 */

export const TC_ENTITY_TYPE = "TestingCommissioning";
export const TC_DOCUMENT_TYPE = "testing_commissioning";

/** §19: `tc.signoff`. */
export const TC_SIGNOFF_PERMISSION = "tc.signoff";

/** §10's three outcomes. */
export const TC_RESULTS = ["accepted", "accepted_with_punch", "rejected"] as const;
export type TcResult = (typeof TC_RESULTS)[number];

export const TC_RESULT_LABELS: Record<TcResult, string> = {
  accepted: "Accepted",
  accepted_with_punch: "Accepted with punch list",
  rejected: "Rejected",
};

/** §10's punch list severities. Critical blocks close-out. */
export const PUNCH_SEVERITIES = ["minor", "major", "critical"] as const;
export type PunchSeverity = (typeof PUNCH_SEVERITIES)[number];

export const PUNCH_SEVERITY_LABELS: Record<PunchSeverity, string> = {
  minor: "Minor",
  major: "Major",
  critical: "Critical — blocks close-out",
};

export const LOOP_RESULTS = ["pass", "fail", "not_tested"] as const;
export type LoopResult = (typeof LOOP_RESULTS)[number];

// ---- §10's criterion ----------------------------------------------------------------------------

/**
 * Where a criterion came from.
 *
 * `quotation` means it is pinned to a specific line of the accepted quotation — the answer to "what
 * did we actually promise?" — and carries that line's text alongside it. `stated` means nobody could
 * point at a promised line, which is allowed and counted rather than hidden, because §10's automatic
 * flag means nothing if every criterion was made up on the day.
 */
export const CRITERION_SOURCES = ["quotation", "stated"] as const;
export type CriterionSource = (typeof CRITERION_SOURCES)[number];

export type Criterion =
  | { kind: "min"; min: number }
  | { kind: "max"; max: number }
  | { kind: "range"; min: number; max: number }
  | {
      kind: "nominal";
      nominal: number;
      tolerance: number;
      toleranceKind: "absolute" | "percent";
    }
  | { kind: "qualitative"; expected: string };

export interface FunctionalTest {
  test: string;
  criterion?: Criterion | null;
  criterionSource?: CriterionSource;
  /** The promised line this criterion was read from, when there is one. */
  quotationLineId?: string | null;
  /** What that line actually says, copied at citation time so a later revision cannot rewrite it. */
  promiseText?: string | null;
  criterionSetAt?: string | null;
  criterionSetById?: string | null;
  measured?: string | number | null;
  unit?: string | null;
  measuredAt?: string | null;
  measuredById?: string | null;
  remarks?: string | null;
}

/** What a measurement did against its criterion. */
export type Verdict = "pass" | "fail" | "indeterminate";

export interface Evaluation {
  verdict: Verdict;
  /** Said in words, because a bare "fail" on a certificate invites an argument. */
  reason: string;
}

/**
 * Parses the shorthand an engineer actually writes into a criterion.
 *
 * Returns `null` with a reason rather than guessing. The refusal that matters is the bare number:
 * "230" does not say whether 229.8 passes, and silently treating it as exact equality would fail
 * almost every real measurement, while silently allowing anything close would pass almost all of
 * them. Either way the number on the certificate would not mean what the reader thinks.
 */
export function parseCriterion(raw: string): { criterion: Criterion | null; error?: string } {
  const text = raw.trim();
  if (!text) return { criterion: null, error: "No criterion given." };

  const normalised = text
    .replace(/≥/g, ">=")
    .replace(/≤/g, "<=")
    .replace(/±/g, "+/-")
    .replace(/\s+/g, " ");

  const num = "(-?\\d+(?:\\.\\d+)?)";

  const nominalPct = new RegExp(`^${num} ?\\+/- ?${num} ?%$`).exec(normalised);
  if (nominalPct) {
    return {
      criterion: {
        kind: "nominal",
        nominal: Number(nominalPct[1]),
        tolerance: Number(nominalPct[2]),
        toleranceKind: "percent",
      },
    };
  }

  const nominalAbs = new RegExp(`^${num} ?\\+/- ?${num}$`).exec(normalised);
  if (nominalAbs) {
    return {
      criterion: {
        kind: "nominal",
        nominal: Number(nominalAbs[1]),
        tolerance: Number(nominalAbs[2]),
        toleranceKind: "absolute",
      },
    };
  }

  const range = new RegExp(`^${num} ?(?:-|to|\\.\\.) ?${num}$`, "i").exec(normalised);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    if (min > max) {
      return { criterion: null, error: `"${text}" runs backwards — the low value comes first.` };
    }
    return { criterion: { kind: "range", min, max } };
  }

  const min = new RegExp(`^(?:>=|min\\.?) ?${num}$`, "i").exec(normalised);
  if (min) return { criterion: { kind: "min", min: Number(min[1]) } };

  const max = new RegExp(`^(?:<=|max\\.?) ?${num}$`, "i").exec(normalised);
  if (max) return { criterion: { kind: "max", max: Number(max[1]) } };

  if (new RegExp(`^${num}$`).test(normalised)) {
    return {
      criterion: null,
      error:
        `"${text}" is a value, not a criterion — it does not say how close is close enough. ` +
        `Write it as "${text} +/- 2", "${text} +/- 1%", ">= ${text}" or a range.`,
    };
  }

  // Anything else is a qualitative check: "no leaks", "no visible arcing", "alarm annunciates".
  return { criterion: { kind: "qualitative", expected: text } };
}

/** The criterion in words, for the screen and the certificate. */
export function describeCriterion(criterion: Criterion): string {
  switch (criterion.kind) {
    case "min":
      return `≥ ${criterion.min}`;
    case "max":
      return `≤ ${criterion.max}`;
    case "range":
      return `${criterion.min} to ${criterion.max}`;
    case "nominal":
      return criterion.toleranceKind === "percent"
        ? `${criterion.nominal} ± ${criterion.tolerance}%`
        : `${criterion.nominal} ± ${criterion.tolerance}`;
    case "qualitative":
      return criterion.expected;
  }
}

/** The numeric window a criterion allows, where it has one. */
export function criterionBounds(criterion: Criterion): { min?: number; max?: number } | null {
  switch (criterion.kind) {
    case "min":
      return { min: criterion.min };
    case "max":
      return { max: criterion.max };
    case "range":
      return { min: criterion.min, max: criterion.max };
    case "nominal": {
      const spread =
        criterion.toleranceKind === "percent"
          ? Math.abs(criterion.nominal * criterion.tolerance) / 100
          : Math.abs(criterion.tolerance);
      return { min: criterion.nominal - spread, max: criterion.nominal + spread };
    }
    case "qualitative":
      return null;
  }
}

/**
 * Compares one measurement against one criterion.
 *
 * The third verdict is the one that earns its place. A test with no measurement, or a numeric
 * criterion against a measurement nobody can read as a number, is **indeterminate** — not a pass.
 * The same distinction §7's undecided material gate and §9's waived client inspection turn on: a
 * question nobody answered must not be stored as an answer.
 */
export function evaluateMeasurement(
  criterion: Criterion | null | undefined,
  measured: string | number | null | undefined,
): Evaluation {
  const raw = typeof measured === "number" ? String(measured) : (measured ?? "").trim();

  if (!criterion) {
    return {
      verdict: "indeterminate",
      reason: "No criterion, so there is nothing to judge this against.",
    };
  }
  if (!raw) {
    return { verdict: "indeterminate", reason: "Not measured." };
  }

  if (criterion.kind === "qualitative") {
    const expected = criterion.expected.trim().toLowerCase();
    const actual = raw.toLowerCase();
    if (actual === expected || actual === "pass" || actual === "ok") {
      return { verdict: "pass", reason: `Observed "${raw}" against "${criterion.expected}".` };
    }
    if (actual === "fail") {
      return { verdict: "fail", reason: `Recorded as failed against "${criterion.expected}".` };
    }
    // A qualitative answer that is neither the expected words nor a plain pass/fail is a note, and
    // reading it either way would be the software deciding something it cannot.
    return {
      verdict: "indeterminate",
      reason: `"${raw}" is neither "${criterion.expected}" nor a plain pass or fail — a person has to read it.`,
    };
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return {
      verdict: "indeterminate",
      reason: `"${raw}" is not a number, and ${describeCriterion(criterion)} is a numeric limit.`,
    };
  }

  const bounds = criterionBounds(criterion);
  if (!bounds) {
    return { verdict: "indeterminate", reason: "This criterion has no numeric window." };
  }

  const belowMin = bounds.min !== undefined && value < bounds.min;
  const aboveMax = bounds.max !== undefined && value > bounds.max;

  if (belowMin || aboveMax) {
    return {
      verdict: "fail",
      reason: `${value} is outside ${describeCriterion(criterion)}.`,
    };
  }
  return { verdict: "pass", reason: `${value} is within ${describeCriterion(criterion)}.` };
}

// ---- §10's provenance ---------------------------------------------------------------------------

export interface TestEvaluation extends Evaluation {
  test: string;
  source: CriterionSource;
  /** The criterion was fixed in the same act that recorded its measurement. */
  criterionSetAtMeasurement: boolean;
}

/**
 * Whether the criterion was fixed before the measurement or alongside it.
 *
 * §10 wants results judged against something the technician did not supply. Where the criterion is
 * pinned to a promised line that is settled. Where it is merely stated, the next best thing is that
 * it was written down **before** the reading was taken, so it could not be adjusted to fit. Missing
 * either timestamp counts as "at measurement", because an unprovable claim of prior intent is not
 * worth more than no claim.
 */
export function criterionFixedAtMeasurement(test: FunctionalTest): boolean {
  if (!test.measuredAt) return false; // nothing measured yet, so nothing to have been fitted to
  if (!test.criterionSetAt) return true;
  return new Date(test.criterionSetAt).getTime() >= new Date(test.measuredAt).getTime();
}

export function evaluateTests(tests: readonly FunctionalTest[]): {
  evaluations: TestEvaluation[];
  failed: TestEvaluation[];
  indeterminate: TestEvaluation[];
  /** Criteria with no promised line behind them — §10's automatic flag is worth only what these are. */
  stated: TestEvaluation[];
  fittedToResult: TestEvaluation[];
} {
  const evaluations = tests.map<TestEvaluation>((test) => {
    const evaluation = evaluateMeasurement(test.criterion, test.measured);
    return {
      test: test.test,
      source: test.criterionSource ?? "stated",
      criterionSetAtMeasurement: criterionFixedAtMeasurement(test),
      ...evaluation,
    };
  });

  return {
    evaluations,
    failed: evaluations.filter((e) => e.verdict === "fail"),
    indeterminate: evaluations.filter((e) => e.verdict === "indeterminate"),
    stated: evaluations.filter((e) => e.source === "stated"),
    fittedToResult: evaluations.filter((e) => e.criterionSetAtMeasurement),
  };
}

// ---- §10's punch list ---------------------------------------------------------------------------

export interface PunchItem {
  description: string;
  severity: PunchSeverity;
  ownerId?: string | null;
  dueAt?: string | null;
  status?: string;
  raisedAt?: string | null;
}

export const isOpen = (item: PunchItem): boolean => (item.status ?? "open") !== "closed";

/**
 * §10: "Critical punch items block project close-out."
 *
 * Returned as the items themselves rather than a boolean, because the person who is blocked needs to
 * know by what — §12 shows this list.
 */
export function closeoutBlockers(items: readonly PunchItem[]): PunchItem[] {
  return items.filter((item) => item.severity === "critical" && isOpen(item));
}

// ---- §10's record -------------------------------------------------------------------------------

export interface TcCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Whether a commissioning record can be completed as given.
 *
 * The rule worth defending: **a clean `accepted` is refused while any test failed or was never
 * resolved.** §10 flags out-of-spec results automatically, and a flag that a person can accept over
 * without saying so is a flag that does nothing. Accepting real work with a real exception is
 * legitimate and common — that is what `accepted_with_punch` is for, and it carries the exception
 * onto a list somebody owns rather than burying it.
 */
export function checkTcRecord(input: {
  result: TcResult;
  functionalTests: readonly FunctionalTest[];
  performanceVerification?: readonly FunctionalTest[];
  punchItems: readonly PunchItem[];
  witnessedByCustomer: boolean;
  calibrationAssetsUsed?: readonly string[];
  remarks?: string | null;
}): TcCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  const all = [...input.functionalTests, ...(input.performanceVerification ?? [])];
  const summary = evaluateTests(all);

  if (all.length === 0) {
    errors.push(
      "Commissioning with no tests recorded is a signature on an empty page. Record what was tested.",
    );
  }

  for (const test of all) {
    if (!test.test?.trim()) errors.push("Every test needs a name.");
    if (test.criterionSource === "quotation" && !test.quotationLineId) {
      errors.push(
        `"${test.test}" claims its criterion came from the quotation but names no line. ` +
          "Cite the line or mark the criterion as stated.",
      );
    }
  }

  if (input.result === "accepted") {
    if (summary.failed.length > 0) {
      errors.push(
        `${summary.failed.length} test(s) are out of spec, so this cannot be recorded as a clean ` +
          "acceptance. Use 'accepted with punch list' and carry them, or record it as rejected.",
      );
    }
    if (summary.indeterminate.length > 0) {
      errors.push(
        `${summary.indeterminate.length} test(s) have no usable result. An unmeasured test is not a ` +
          "passed one — measure it, or carry it on the punch list.",
      );
    }
  }

  if (input.result === "accepted_with_punch" && input.punchItems.length === 0) {
    errors.push("'Accepted with punch list' needs at least one item on the list.");
  }

  if (input.result === "rejected" && summary.failed.length === 0 && input.punchItems.length === 0) {
    errors.push(
      "A rejection needs a failed test or a punch item behind it — otherwise nobody knows what to " +
        "put right.",
    );
  }

  /**
   * §10's certificate is signed by the customer's witness. Where there was no witness, that is
   * recorded and explained rather than left blank — the same rule §9 applies to a client who did not
   * inspect, for the same reason: a skipped step and a waived one must not look identical.
   */
  if (!input.witnessedByCustomer && !input.remarks?.trim()) {
    errors.push(
      "Say why the customer did not witness commissioning. An unwitnessed test nobody explains is " +
        "indistinguishable from one nobody ran.",
    );
  }

  for (const item of input.punchItems) {
    if (!item.description?.trim()) errors.push("Every punch item needs a description.");
    if (!PUNCH_SEVERITIES.includes(item.severity)) {
      errors.push(`"${item.severity}" is not a punch item severity.`);
    }
  }

  const criticals = closeoutBlockers(input.punchItems);
  if (criticals.length > 0) {
    warnings.push(
      `${criticals.length} critical punch item(s) will block project close-out until they are closed.`,
    );
  }

  if (summary.stated.length > 0) {
    warnings.push(
      `${summary.stated.length} of ${all.length} criteria are not tied to a quoted line. The ` +
        "out-of-spec check is only as good as the criteria it is given.",
    );
  }

  if (summary.fittedToResult.length > 0) {
    warnings.push(
      `${summary.fittedToResult.length} criterion/criteria were set in the same act as the reading ` +
        "they judge. Recorded, not refused — but a limit written after the measurement proves less.",
    );
  }

  const numeric = all.filter((test) => test.criterion && test.criterion.kind !== "qualitative");
  if (numeric.length > 0 && (input.calibrationAssetsUsed?.length ?? 0) === 0) {
    warnings.push(
      "No instruments recorded against numeric readings. §10 wants them for traceability, and a " +
        "reading whose instrument nobody can name is hard to defend later.",
    );
  }

  const unownedCriticals = criticals.filter((item) => !item.ownerId);
  if (unownedCriticals.length > 0) {
    warnings.push(
      `${unownedCriticals.length} critical punch item(s) have no owner. An item that blocks ` +
        "close-out and belongs to nobody blocks it indefinitely.",
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * What §10 suggests the result should be, from the readings alone.
 *
 * Offered to the screen as a suggestion and never written on anybody's behalf: the engineer signs
 * the certificate, so the engineer chooses the word. Its value is that a proposed `accepted` in
 * front of two failed tests is an obvious question.
 */
export function suggestedResult(
  tests: readonly FunctionalTest[],
  punchItems: readonly PunchItem[],
): { result: TcResult; because: string } {
  const summary = evaluateTests(tests);

  if (summary.failed.length > 0) {
    return {
      result: "accepted_with_punch",
      because: `${summary.failed.length} test(s) out of spec — accept with a punch list, or reject.`,
    };
  }
  if (summary.indeterminate.length > 0) {
    return {
      result: "accepted_with_punch",
      because: `${summary.indeterminate.length} test(s) unresolved. They are not passes.`,
    };
  }
  if (punchItems.some(isOpen)) {
    return {
      result: "accepted_with_punch",
      because: "Everything in spec, punch items still open.",
    };
  }
  return { result: "accepted", because: "Every test in spec and no punch items open." };
}

// ---- §10's outcome ------------------------------------------------------------------------------

export interface TcOutcome {
  ticketStatus: "for_closeout" | "in_progress";
  message: string;
}

/**
 * Where the ticket goes when commissioning is completed.
 *
 * A rejection returns it to `in_progress`, exactly as §9's QA failure does — the flowchart loops
 * both diamonds back to Project Execution and §9 says to implement that literally.
 *
 * Acceptance moves it to `for_closeout`. §11's warranty gate belongs between the two and does not
 * exist yet; when it lands it inserts itself on this transition rather than changing where
 * commissioning leaves the ticket.
 */
export function tcOutcome(input: {
  result: TcResult;
  punchItems: readonly PunchItem[];
}): TcOutcome {
  if (input.result === "rejected") {
    return {
      ticketStatus: "in_progress",
      message: "Commissioning rejected — back to the crew, as the flowchart loops it.",
    };
  }

  const blockers = closeoutBlockers(input.punchItems);
  const open = input.punchItems.filter(isOpen).length;

  return {
    ticketStatus: "for_closeout",
    message:
      input.result === "accepted"
        ? "Accepted. On to close-out."
        : `Accepted with ${open} open punch item(s)` +
          (blockers.length > 0
            ? `, ${blockers.length} of them critical — close-out stays blocked until those are closed.`
            : ". None of them critical, so close-out is not blocked."),
  };
}
