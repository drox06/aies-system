import { describe, expect, it } from "vitest";
import { evaluateCondition } from "@/server/core/approvals/types";

describe("evaluateCondition", () => {
  it("is true when no condition is given", () => {
    expect(evaluateCondition(undefined, {})).toBe(true);
  });

  it.each([
    [">", 600_000, 500_000, true],
    [">", 400_000, 500_000, false],
    ["<", 400_000, 500_000, true],
    [">=", 500_000, 500_000, true],
    ["<=", 500_000, 500_000, true],
    ["==", 500_000, 500_000, true],
    ["!=", 400_000, 500_000, true],
  ] as const)("total %s threshold: %d vs %d -> %s", (operator, actual, threshold, expected) => {
    expect(
      evaluateCondition({ field: "total", operator, value: threshold }, { total: actual }),
    ).toBe(expected);
  });

  it("is false when the snapshot field is missing or not a number", () => {
    expect(evaluateCondition({ field: "total", operator: ">", value: 1 }, {})).toBe(false);
    expect(evaluateCondition({ field: "total", operator: ">", value: 1 }, { total: "lots" })).toBe(
      false,
    );
  });
});
