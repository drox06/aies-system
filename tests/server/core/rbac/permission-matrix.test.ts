import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { resolveUserPermissions } from "@/server/core/rbac/permissions";

/**
 * Integration test against the real seeded dev database (prisma/seed.ts) rather than mocks —
 * specs/00-foundation.md §11 explicitly calls for a permission matrix across the nine seeded
 * roles, with explicit assertions that admin_manager, operations_manager, and marketing_manager
 * cannot see cost/margin data. No cost-bearing entity exists yet (that's module 02+), so this
 * checks the permission itself — the input stripFieldsUnlessPermitted (tested separately in
 * field-gating.test.ts) is gated on.
 */

async function permissionsForRole(roleKey: string): Promise<Set<string>> {
  const role = await db.role.findUniqueOrThrow({
    where: { key: roleKey },
    include: { users: { include: { user: true } } },
  });

  const user = role.users.find((userRole) => !userRole.user.isDemoUser) ?? role.users[0];
  if (!user) {
    throw new Error(`No seeded user found for role "${roleKey}". Has \`npm run seed\` been run?`);
  }

  return resolveUserPermissions(user.userId);
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
