import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { computePermissionSet } from "@/server/core/rbac/permissions";

/**
 * Integration test against the real seeded dev database (prisma/seed.ts) rather than mocks —
 * specs/00-foundation.md §11 explicitly calls for a permission matrix across the nine seeded
 * roles, with explicit assertions that admin_manager, operations_manager, and marketing_manager
 * cannot see cost/margin data. No cost-bearing entity exists yet (that's module 02+), so this
 * checks the permission itself — the input stripFieldsUnlessPermitted (tested separately in
 * field-gating.test.ts) is gated on.
 */

/**
 * The permissions a role grants, read from the role itself.
 *
 * This deliberately does NOT go via a user who happens to hold the role. Spec.md §4.2 is explicit
 * that "users hold multiple roles — at AIES one person is often sales and operations", so any
 * user's permission set is the union of all their roles and tells you nothing about one role in
 * isolation. The earlier version picked a holder and read their permissions, which passed only for
 * as long as every seeded user happened to hold exactly one role; the moment an admin assigned
 * `viewer` to the vice-president during manual testing, this suite reported that `viewer` grants
 * `finance.view_cost`. That is a false alarm about the single most sensitive permission in the
 * system (§4.3), and a false alarm there is worse than no test.
 */
async function permissionsForRole(roleKey: string): Promise<Set<string>> {
  const role = await db.role.findUniqueOrThrow({
    where: { key: roleKey },
    include: { permissions: { include: { permission: true } } },
  });

  // No per-user overrides: those are a property of a user, not of a role.
  return computePermissionSet([role.permissions.map((rp) => rp.permission)], []);
}

describe("permission matrix (against seeded data)", () => {
  it("only president and vice_president can view cost/margin", async () => {
    const roleGrantsCost: Record<string, boolean> = {
      president: true,
      vice_president: true,
      admin_manager: false,
      operations_manager: false,
      marketing_manager: false,
      technician: false,
      sales: false,
      finance_officer: false,
      viewer: false,
    };

    for (const [roleKey, shouldHaveAccess] of Object.entries(roleGrantsCost)) {
      const permissions = await permissionsForRole(roleKey);
      expect(permissions.has("finance.view_cost"), `finance.view_cost for role "${roleKey}"`).toBe(
        shouldHaveAccess,
      );
      expect(permissions.has("project.view_pl"), `project.view_pl for role "${roleKey}"`).toBe(
        shouldHaveAccess,
      );
    }
  }, 30_000);

  it("only president and vice_president can approve quotations and cash advances", async () => {
    for (const roleKey of ["president", "vice_president"]) {
      const permissions = await permissionsForRole(roleKey);
      expect(permissions.has("quotation.approve")).toBe(true);
      expect(permissions.has("cash_advance.approve")).toBe(true);
      expect(permissions.has("cash_advance.approve_extension")).toBe(true);
    }

    for (const roleKey of ["admin_manager", "operations_manager", "marketing_manager", "sales"]) {
      const permissions = await permissionsForRole(roleKey);
      expect(permissions.has("quotation.approve")).toBe(false);
      expect(permissions.has("cash_advance.approve")).toBe(false);
    }
  }, 30_000);

  it("only president can manage users and roles", async () => {
    const roleKeys = [
      "president",
      "vice_president",
      "admin_manager",
      "operations_manager",
      "marketing_manager",
      "technician",
      "sales",
      "finance_officer",
      "viewer",
    ];

    for (const roleKey of roleKeys) {
      const permissions = await permissionsForRole(roleKey);
      const expected = roleKey === "president";
      expect(permissions.has("admin.manage_users"), `admin.manage_users for "${roleKey}"`).toBe(
        expected,
      );
      expect(permissions.has("admin.manage_roles"), `admin.manage_roles for "${roleKey}"`).toBe(
        expected,
      );
    }
  }, 30_000);
});
