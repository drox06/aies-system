import { describe, expect, it } from "vitest";
import { visibleNavFor } from "@/server/core/nav";
import type { NavEntry } from "@/server/core/module-registry";

/**
 * specs/00-foundation.md §11 requires an end-to-end check that a user "sees only their permitted
 * nav". This covers the half that actually decides — the server-side filter. The client renders
 * whatever this returns and makes no permission judgements of its own.
 */

const NAV: NavEntry[] = [
  { label: "Home", href: "/", order: 0 },
  { label: "Approvals", href: "/approvals", order: 90 },
  { label: "Users", href: "/admin/users", permission: "admin.manage_users", order: 100 },
  { label: "Cost analysis", href: "/reports/cost", permission: "finance.view_cost", order: 110 },
];

const navFor = (permissions: string[]) => visibleNavFor(new Set(permissions), { nav: NAV });

describe("visibleNavFor", () => {
  it("includes entries that carry no permission requirement", () => {
    const hrefs = navFor([]).map((e) => e.href);
    // Everyone reaches their own approval inbox; it is simply empty when nothing awaits them.
    expect(hrefs).toEqual(["/", "/approvals"]);
  });

  it("hides an entry whose permission the user lacks", () => {
    expect(navFor([]).map((e) => e.href)).not.toContain("/admin/users");
  });

  it("shows that same entry once the permission is granted", () => {
    expect(navFor(["admin.manage_users"]).map((e) => e.href)).toContain("/admin/users");
  });

  it("grants each permission independently rather than all-or-nothing", () => {
    const hrefs = navFor(["admin.manage_users"]).map((e) => e.href);
    expect(hrefs).toContain("/admin/users");
    expect(hrefs).not.toContain("/reports/cost");
  });

  it("never leaks the label of an entry the user cannot reach", () => {
    // The label is itself a disclosure: "Cost analysis" tells an unprivileged user the feature
    // exists, which is exactly what Spec.md §4.3's cost stripping is meant to prevent. The whole
    // entry must be dropped, not returned with a disabled flag for the client to honour.
    const serialised = JSON.stringify(navFor([]));
    expect(serialised).not.toContain("Cost analysis");
    expect(serialised).not.toContain("finance.view_cost");
  });

  it("never exposes the permission key even on entries it does return", () => {
    expect(JSON.stringify(navFor(["admin.manage_users"]))).not.toContain("admin.manage_users");
  });

  it("reads the real registry when no fake is supplied", () => {
    // Guards the default parameter — a wiring mistake here would silently return an empty sidebar.
    expect(visibleNavFor(new Set(["admin.manage_users"])).length).toBeGreaterThan(0);
  });
});
