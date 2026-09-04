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
  it("only president and vice_president can see project.view_pl", async () => {
    // Dead and unenforced (grep confirms zero `p("project.view_pl")` gates anywhere in src/) —
    // kept narrow regardless, since nothing has ever asked to widen the dead key itself, only the
    // real one below.
    const roleGrantsPl: Record<string, boolean> = {
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

    for (const [roleKey, shouldHaveAccess] of Object.entries(roleGrantsPl)) {
      const permissions = await permissionsForRole(roleKey);
      expect(permissions.has("project.view_pl"), `project.view_pl for role "${roleKey}"`).toBe(
        shouldHaveAccess,
      );
    }
  }, 30_000);

  it("gates finance.view_cost — the real cost/margin signal, wider since #151/#175", async () => {
    // Used to move in lockstep with project.view_pl (the dead key above), true only until #151 gave
    // PD (admin_manager) explicit P&L access and #175 gave DJ (operations_manager) the same —
    // docs/DECISIONS.md #151, #175. The two permissions are unrelated keys with unrelated
    // enforcement; pinning them to one shared map was what let this go stale for a day.
    const roleGrantsCost: Record<string, boolean> = {
      president: true,
      vice_president: true,
      admin_manager: true,
      operations_manager: true,
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
    // Unaffected by #175 — #151 never named quotation.view_all for PD, only for DJ (see below).
    expect(permissions.has("quotation.view_all")).toBe(false);
  }, 30_000);

  it("gives the admin manager supplier accreditation, full finance, and CRM deletion (docs/DECISIONS.md #175)", async () => {
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
      // Explicitly confirmed against #151's own apparent contradiction ("P&L" granted, "cannot see
      // cost or margin" stated generally) — the named grant controls.
      "pnl.view",
      // #175, EA's own correction to #151: "cannot see cost or margin" is lifted, an outright
      // grant — PD's title became Admin Manager *and* Purchaser for exactly this.
      "finance.view_cost",
      // #175: "cannot approve a material request" is lifted, a full and final grant — material
      // requests are operational stock movement, not finance, so no endorsement tier applies.
      "material_request.approve",
      // #175: "cannot delete or merge CRM records" is lifted, an outright grant.
      "crm.delete",
      "crm.merge",
    ]) {
      expect(permissions.has(key), key).toBe(true);
    }
  }, 30_000);

  it("gives the admin manager and operations manager an endorsement, not final approval, on cash advances and supplier POs (docs/DECISIONS.md #175)", async () => {
    const admin = await permissionsForRole("admin_manager");
    const ops = await permissionsForRole("operations_manager");

    // "PD and DJ approval are more akin to endorsement to KJ" — EA's own words. Endorsing is a real
    // grant, but the final decision — and the permission that names it — stays with the Vice
    // President and President alone, unchanged from before #175.
    expect(admin.has("cash_advance.approve")).toBe(false);
    expect(ops.has("cash_advance.approve")).toBe(false);
    expect(admin.has("cash_advance.endorse")).toBe(true);
    expect(ops.has("cash_advance.endorse")).toBe(true);

    expect(admin.has("supplier_po.approve")).toBe(false);
    expect(admin.has("supplier_po.endorse")).toBe(true);
    // DJ is deliberately absent here — #151's DJ paragraph never named supplier PO approval at
    // all, only cash advance approval. Endorsement follows the same line PD's own grant does.
    expect(ops.has("supplier_po.endorse")).toBe(false);
  }, 30_000);

  it("gives the operations manager full quotation authorship, procurement, and cost visibility (docs/DECISIONS.md #175)", async () => {
    const permissions = await permissionsForRole("operations_manager");
    for (const key of [
      "quotation.create",
      "quotation.edit",
      "quotation.revise",
      "quotation.send",
      "quotation.delete",
      "quotation.view_archive",
      // #175: "cannot view... quotations beyond his own" is lifted, an outright grant.
      "quotation.view_all",
      // #175: "cannot record a goods receipt, raise a supplier PO" is lifted — restored the same
      // day #151 withdrew it, EA's own correction.
      "goods_receipt.create",
      "supplier_po.create",
      // #175: "cannot see cost, margin or project P&L" is lifted, an outright grant.
      "finance.view_cost",
      "pnl.view",
    ]) {
      expect(permissions.has(key), key).toBe(true);
    }
    // Confirmed against #151's own apparent contradiction ("views all... sales orders" granted,
    // "not... beyond his own" stated generally) — the named grant controls, and this one is also
    // DJ's pre-existing, unchanged access.
    expect(permissions.has("sales_order.view_all")).toBe(true);
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
