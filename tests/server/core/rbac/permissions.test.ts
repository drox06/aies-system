import { describe, expect, it } from "vitest";
import { computePermissionSet } from "@/server/core/rbac/permissions";

describe("computePermissionSet", () => {
  it("unions permissions across multiple roles", () => {
    const result = computePermissionSet(
      [
        [{ key: "quotation.view" }],
        [{ key: "quotation.approve" }, { key: "cash_advance.approve" }],
      ],
      [],
    );
    expect([...result].sort()).toEqual(
      ["cash_advance.approve", "quotation.approve", "quotation.view"].sort(),
    );
  });

  it("a granted override adds a permission not present in any role", () => {
    const result = computePermissionSet(
      [[{ key: "quotation.view" }]],
      [{ key: "finance.view_cost", granted: true }],
    );
    expect(result.has("finance.view_cost")).toBe(true);
  });

  it("a revoked override removes a permission granted by a role", () => {
    const result = computePermissionSet(
      [[{ key: "quotation.view" }, { key: "quotation.approve" }]],
      [{ key: "quotation.approve", granted: false }],
    );
    expect(result.has("quotation.approve")).toBe(false);
    expect(result.has("quotation.view")).toBe(true);
  });

  it("with no roles and no overrides, produces an empty set", () => {
    expect(computePermissionSet([], []).size).toBe(0);
  });
});
