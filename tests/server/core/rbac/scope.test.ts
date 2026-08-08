import { afterEach, describe, expect, it } from "vitest";
import { __resetScopeRegistryForTests, registerScope, scopeFor } from "@/server/core/rbac/scope";
import type { AuthedUser } from "@/server/core/rbac/types";

function user(overrides: Partial<AuthedUser> = {}): AuthedUser {
  return {
    id: "u1",
    email: "u1@aies.test",
    name: "Test User",
    roleKeys: ["sales"],
    permissions: new Set<string>(),
    ...overrides,
  };
}

afterEach(() => {
  __resetScopeRegistryForTests();
});

describe("scopeFor", () => {
  it("returns no restriction when no resolver is registered for the entity type", () => {
    expect(scopeFor("account", user())).toEqual({});
  });

  it("returns the registered resolver's where fragment", () => {
    registerScope("account", (u) =>
      u.permissions.has("crm.view_all") ? {} : { OR: [{ ownerId: u.id }] },
    );

    expect(scopeFor("account", user())).toEqual({ OR: [{ ownerId: "u1" }] });
    expect(scopeFor("account", user({ permissions: new Set(["crm.view_all"]) }))).toEqual({});
  });

  it("throws when a second resolver is registered for the same entity type", () => {
    registerScope("account", () => ({}));
    expect(() => registerScope("account", () => ({}))).toThrow(/already registered/);
  });
});
