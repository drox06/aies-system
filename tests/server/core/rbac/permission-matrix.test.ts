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

/**
 * EA's rebuild duties table (docs/DECISIONS.md #151, 2026-08-31, applied 2026-09-04), pinned per
 * role rather than left to the general assertions above — each of these is a specific, deliberate
 * grant or withholding the company named by hand, not an inference from a broader rule.
 */
describe("the rebuild's duties table, applied (docs/DECISIONS.md #151)", () => {
  it("gives the vice-president everything except administering people", async () => {
    const permissions = await permissionsForRole("vice_president");
    // "Nothing else is withheld" — admin.manage_custom_fields is not "administering people".
    expect(permissions.has("admin.manage_custom_fields")).toBe(true);
    expect(permissions.has("admin.manage_users")).toBe(false);
    expect(permissions.has("admin.manage_roles")).toBe(false);
  }, 30_000);

  it("gives the admin manager full quotation authorship, never approval", async () => {
    const permissions = await permissionsForRole("admin_manager");
    for (const key of [
      "quotation.view",
      "quotation.create",
      "quotation.edit",
      "quotation.revise",
      "quotation.send",
      "quotation.delete",
      "quotation.view_archive",
    ]) {
      expect(permissions.has(key), key).toBe(true);
    }
    expect(permissions.has("quotation.approve")).toBe(false);
    expect(permissions.has("quotation.view_all")).toBe(false);
  }, 30_000);

  it("gives the admin manager supplier accreditation and partial finance, but not cost", async () => {
    const permissions = await permissionsForRole("admin_manager");
    for (const key of [
      "supplier.approve",
      "ar.view",
      "billing_statement.create",
      "billing_statement.issue",
      "payment.record",
      "invoice.cancel",
      "accounting.export",
      "payables.manage",
      // Explicitly confirmed against the source's own apparent contradiction ("P&L" granted,
      // "cannot see cost or margin" stated generally) — the named grant controls.
      "pnl.view",
    ]) {
      expect(permissions.has(key), key).toBe(true);
    }
    // "Cannot ... see cost or margin" still holds for the one other cost signal in the system.
    expect(permissions.has("finance.view_cost")).toBe(false);
    expect(permissions.has("material_request.approve")).toBe(false);
    expect(permissions.has("cash_advance.approve")).toBe(false);
    expect(permissions.has("supplier_po.approve")).toBe(false);
  }, 30_000);

  it("gives the operations manager full quotation authorship, but not procurement", async () => {
    const permissions = await permissionsForRole("operations_manager");
    for (const key of [
      "quotation.create",
      "quotation.edit",
      "quotation.revise",
      "quotation.send",
      "quotation.delete",
      "quotation.view_archive",
    ]) {
      expect(permissions.has(key), key).toBe(true);
    }
    // "Cannot: record a goods receipt, raise a supplier PO" — named explicitly, withdrawn from what
    // operations_manager held before this change.
    expect(permissions.has("goods_receipt.create")).toBe(false);
    expect(permissions.has("supplier_po.create")).toBe(false);
    // Confirmed against the source's own apparent contradiction ("views all... sales orders"
    // granted, "not... beyond his own" stated generally) — the named grant controls, and this one
    // is also DJ's pre-existing, unchanged access.
    expect(permissions.has("sales_order.view_all")).toBe(true);
    expect(permissions.has("finance.view_cost")).toBe(false);
    expect(permissions.has("pnl.view")).toBe(false);
  }, 30_000);

  it("gives the sales and marketing manager delete and archive, completing the lifecycle he already had", async () => {
    const permissions = await permissionsForRole("marketing_manager");
    expect(permissions.has("quotation.delete")).toBe(true);
    expect(permissions.has("quotation.view_archive")).toBe(true);
    expect(permissions.has("quotation.approve")).toBe(false);
    expect(permissions.has("finance.view")).toBe(false);
  }, 30_000);

  it("holds each of the four named users to exactly the one role their job now carries", async () => {
    const users = await db.user.findMany({
      where: {
        email: {
          in: [
            "kj@aieselectromech.com",
            "pd@aieselectromech.com",
            "dj@aieselectromech.com",
            "em@aieselectromech.com",
          ],
        },
      },
      select: { email: true, roles: { select: { role: { select: { key: true } } } } },
    });
    expect(users).toHaveLength(4);
    for (const user of users) {
      const roleKeys = user.roles.map((r) => r.role.key);
      // The 2026-08-21 practice grant that gave every named user the president bundle is gone —
      // each holds only their own role, so access is defined by the rebuild table alone.
      expect(roleKeys, user.email).not.toContain("president");
      expect(roleKeys, user.email).toHaveLength(1);
    }
  }, 30_000);
});
