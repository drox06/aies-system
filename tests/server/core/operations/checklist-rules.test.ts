import { describe, expect, it } from "vitest";
import {
  ITEM_TYPES,
  allowsNotApplicable,
  checkResponse,
  isAnswered,
  isFailure,
  readAnswers,
  readSections,
  summarise,
  type ChecklistSection,
} from "@/server/core/operations/checklist-rules";

/**
 * specs/04-operations-projects.md §15, as pure functions.
 *
 * §15 replaces "the undocumented, verbal way work is currently confirmed", and the cases below are
 * the ways a digital checklist can quietly go back to being that: an item skipped without anybody
 * noticing, an N/A used as an escape hatch, a failure recorded with no cause, a tolerance rendered
 * as a text box that accepts anything.
 */

const section = (items: ChecklistSection["items"]): ChecklistSection[] => [
  { key: "s1", title: "Section", items },
];

describe("§15's item types", () => {
  it("is the nine the spec names", () => {
    expect([...ITEM_TYPES]).toEqual([
      "pass_fail",
      "pass_fail_na",
      "numeric",
      "text",
      "select_single",
      "select_multi",
      "photo",
      "signature",
      "instrument_reading",
    ]);
  });

  /**
   * The distinction the section rests on. §15 lists `pass/fail` and `pass/fail/NA` as *separate*
   * types, which only means something if N/A is unavailable on the first.
   */
  it("offers not-applicable on exactly one type", () => {
    expect(allowsNotApplicable("pass_fail_na")).toBe(true);
    expect(allowsNotApplicable("pass_fail")).toBe(false);
    expect(allowsNotApplicable("numeric")).toBe(false);
    expect(allowsNotApplicable("photo")).toBe(false);
  });
});

describe("reading a template without trusting it", () => {
  /**
   * Rendering an unknown type as text would turn a tolerance into a box that accepts anything —
   * the exact failure §15 exists to prevent, arriving silently through a template written by a
   * newer version of the app.
   */
  it("drops an item whose type it does not know, rather than guessing", () => {
    const parsed = readSections([
      {
        key: "s1",
        title: "Section",
        items: [
          { key: "a", label: "Known", type: "pass_fail" },
          { key: "b", label: "From the future", type: "holographic_scan" },
        ],
      },
    ]);
    expect(parsed[0]!.items.map((item) => item.key)).toEqual(["a"]);
  });

  it("keeps the rest of a section when one item is malformed", () => {
    const parsed = readSections([
      {
        key: "s1",
        title: "Section",
        items: [{ key: "a", label: "Fine", type: "text" }, { label: "No key", type: "text" }, null],
      },
    ]);
    expect(parsed[0]!.items).toHaveLength(1);
  });

  it("survives rubbish instead of throwing", () => {
    expect(readSections(null)).toEqual([]);
    expect(readSections("nope")).toEqual([]);
    expect(readAnswers(null)).toEqual({});
    expect(readAnswers([1, 2])).toEqual({});
  });

  it("defaults an item to required, so a missing flag cannot quietly make it optional", () => {
    const parsed = readSections([
      { key: "s1", title: "S", items: [{ key: "a", label: "A", type: "pass_fail" }] },
    ]);
    expect(parsed[0]!.items[0]!.required).toBe(true);
  });
});

describe("what counts as answered", () => {
  const item = (type: (typeof ITEM_TYPES)[number]) => ({ key: "a", label: "A", type });

  it("does not treat an absent answer as anything", () => {
    expect(isAnswered(item("pass_fail"), undefined)).toBe(false);
    expect(isAnswered(item("text"), { value: "" })).toBe(false);
    expect(isAnswered(item("text"), { value: "   " })).toBe(false);
  });

  it("counts a photo only when there is a photo", () => {
    expect(isAnswered(item("photo"), { photoFileIds: [] })).toBe(false);
    expect(isAnswered(item("photo"), { photoFileIds: ["f1"] })).toBe(true);
  });

  it("counts zero as a reading, because zero is a reading", () => {
    expect(isAnswered(item("numeric"), { value: 0 })).toBe(true);
  });

  it("counts a recorded not-applicable as answered", () => {
    expect(isAnswered(item("pass_fail_na"), { na: true })).toBe(true);
  });
});

describe("what counts as a failure", () => {
  const numeric = { key: "a", label: "Loop", type: "instrument_reading" as const, unit: "mA" };

  it("fails a reading below its minimum and above its maximum", () => {
    expect(isFailure({ ...numeric, min: 4, max: 20 }, { value: 3.2 })).toBe(true);
    expect(isFailure({ ...numeric, min: 4, max: 20 }, { value: 21 })).toBe(true);
    expect(isFailure({ ...numeric, min: 4, max: 20 }, { value: 12 })).toBe(false);
  });

  /** An item with no limits is a record, not a judgement. Treating it as always-failing is nonsense. */
  it("cannot fail a reading that has no limits to fail against", () => {
    expect(isFailure(numeric, { value: -999 })).toBe(false);
  });

  it("does not fail an item answered not-applicable", () => {
    expect(isFailure({ key: "a", label: "A", type: "pass_fail_na" }, { na: true })).toBe(false);
  });
});

describe("§15's conditional logic", () => {
  const sections = section([
    { key: "a", label: "Earth continuity", type: "pass_fail" },
    { key: "b", label: "Site tidy", type: "pass_fail_na" },
  ]);

  /** "A `fail` reveals mandatory cause and action fields." */
  it("will not complete a failure with no cause and no action", () => {
    const check = checkResponse(sections, { a: { value: "fail" }, b: { value: "pass" } });

    expect(check.ok).toBe(false);
    expect(check.failures).toHaveLength(1);
    expect(check.incompleteFailures[0]!.reason).toMatch(/cause and action/);
  });

  it("names whichever half is missing, rather than both regardless", () => {
    const check = checkResponse(sections, {
      a: { value: "fail", cause: "Terminal corroded" },
      b: { value: "pass" },
    });
    expect(check.incompleteFailures[0]!.reason).toMatch(/its action/);
    expect(check.incompleteFailures[0]!.reason).not.toMatch(/cause/);
  });

  it("completes once the failure is explained", () => {
    const check = checkResponse(sections, {
      a: { value: "fail", cause: "Terminal corroded", action: "Replaced and retested" },
      b: { value: "pass" },
    });
    expect(check.ok).toBe(true);
    // Still a failure — explained, not erased. The record has to keep saying so.
    expect(check.failures).toHaveLength(1);
  });

  /**
   * A cause and action are mandatory *because* something failed, so they cannot be `required` on the
   * item. A passing item must not demand them.
   */
  it("does not ask for a cause on an item that passed", () => {
    const check = checkResponse(sections, { a: { value: "pass" }, b: { value: "pass" } });
    expect(check.ok).toBe(true);
    expect(check.incompleteFailures).toHaveLength(0);
  });
});

describe("not-applicable is an answer, not an escape hatch", () => {
  /**
   * The case this whole design exists for. If N/A were universally available, every awkward item
   * would get one and the document would say nothing — which is the verbal status quo §15 replaces,
   * with more steps.
   */
  it("refuses a not-applicable on an item that never offered it", () => {
    const check = checkResponse(
      section([{ key: "a", label: "Earth continuity", type: "pass_fail" }]),
      {
        a: { na: true },
      },
    );

    expect(check.ok).toBe(false);
    expect(check.invalidNotApplicable).toHaveLength(1);
    expect(check.invalidNotApplicable[0]!.reason).toMatch(/does not offer "not applicable"/);
  });

  it("accepts it where the template said it was available", () => {
    const check = checkResponse(section([{ key: "a", label: "Site tidy", type: "pass_fail_na" }]), {
      a: { na: true },
    });
    expect(check.ok).toBe(true);
  });

  /** An unanswered item and one marked N/A are reported separately, because they are different facts. */
  it("keeps unanswered and not-applicable apart", () => {
    const sections = section([
      { key: "a", label: "One", type: "pass_fail_na" },
      { key: "b", label: "Two", type: "pass_fail_na" },
    ]);
    const check = checkResponse(sections, { a: { na: true } });

    expect(check.unanswered.map((problem) => problem.itemKey)).toEqual(["b"]);
    expect(check.invalidNotApplicable).toHaveLength(0);
    expect(check.answeredCount).toBe(1);
  });
});

describe("completeness", () => {
  it("lets an optional item go unanswered", () => {
    const check = checkResponse(
      section([
        { key: "a", label: "Required", type: "pass_fail" },
        { key: "b", label: "Optional note", type: "text", required: false },
      ]),
      { a: { value: "pass" } },
    );
    expect(check.ok).toBe(true);
    expect(check.requiredCount).toBe(1);
  });

  it("blocks on a required photograph that was never taken", () => {
    const check = checkResponse(section([{ key: "a", label: "Nameplate", type: "photo" }]), {});
    expect(check.ok).toBe(false);
    expect(check.unanswered[0]!.label).toBe("Nameplate");
  });

  it("says what a reading was and what it should have been", () => {
    const check = checkResponse(
      section([
        { key: "a", label: "Loop", type: "instrument_reading", unit: "mA", min: 4, max: 20 },
      ]),
      { a: { value: 2.5, cause: "Transmitter fault", action: "Swapped unit" } },
    );
    expect(check.failures[0]!.reason).toBe("Read 2.5 mA, outside 4 to 20 mA.");
  });
});

describe("the one line a list shows", () => {
  const sections = section([
    { key: "a", label: "One", type: "pass_fail" },
    { key: "b", label: "Two", type: "pass_fail" },
  ]);

  it("leads with failures, because that is what somebody scanning needs", () => {
    const check = checkResponse(sections, {
      a: { value: "fail", cause: "c", action: "a" },
      b: { value: "pass" },
    });
    expect(summarise(check)).toBe("1 failed of 2");
  });

  it("shows progress while it is unfinished", () => {
    expect(summarise(checkResponse(sections, { a: { value: "pass" } }))).toBe("1 of 2 answered");
  });

  it("says so when everything passed", () => {
    const check = checkResponse(sections, { a: { value: "pass" }, b: { value: "pass" } });
    expect(summarise(check)).toBe("All 2 passed");
  });
});
