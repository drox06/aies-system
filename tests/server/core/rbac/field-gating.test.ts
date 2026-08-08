import { describe, expect, it } from "vitest";
import {
  stripFieldsFromListUnlessPermitted,
  stripFieldsUnlessPermitted,
} from "@/server/core/rbac/field-gating";

describe("stripFieldsUnlessPermitted", () => {
  const quote = { id: "q1", title: "Flow meter package", cost: 100_000, marginPct: 22 };

  it("strips the given fields when the caller lacks permission", () => {
    const result = stripFieldsUnlessPermitted(quote, ["cost", "marginPct"], false);
    expect(result).toEqual({ id: "q1", title: "Flow meter package" });
    expect("cost" in result).toBe(false);
    expect("marginPct" in result).toBe(false);
  });

  it("leaves the record untouched when the caller has permission", () => {
    const result = stripFieldsUnlessPermitted(quote, ["cost", "marginPct"], true);
    expect(result).toEqual(quote);
  });

  it("does not mutate the original record", () => {
    stripFieldsUnlessPermitted(quote, ["cost"], false);
    expect(quote.cost).toBe(100_000);
  });
});

describe("stripFieldsFromListUnlessPermitted", () => {
  const quotes = [
    { id: "q1", cost: 100 },
    { id: "q2", cost: 200 },
  ];

  it("strips fields from every record in the list when unauthorised", () => {
    const result = stripFieldsFromListUnlessPermitted(quotes, ["cost"], false);
    expect(result).toEqual([{ id: "q1" }, { id: "q2" }]);
  });

  it("returns the list unchanged when authorised", () => {
    expect(stripFieldsFromListUnlessPermitted(quotes, ["cost"], true)).toEqual(quotes);
  });
});
