import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { registry } from "@/server/core/manifests";

/**
 * Every permission a manifest declares must exist in the database, held by the roles it names.
 *
 * ## Why this could not be caught by any other test here
 *
 * The manifests are the source of truth for *intent*; `prisma/seed.ts` is what turns that into
 * `Permission` and `RolePermission` rows, and nothing runs it automatically. Every other permission
 * test in this suite constructs an `AuthedUser` with an explicit `permissions` set — which is right
 * for testing a rule, and means **not one of them reads these tables**. The gap between "declared"
 * and "granted" was invisible from inside the suite by construction.
 *
 * It cost a screen. `delivery.execute` was declared in session 12 and still had no row in session
 * 13, so `/field` returned 403 for everybody, including on the deploy that shipped it. Found by
 * looking at the screen, which is not a repeatable strategy. docs/DECISIONS.md #88.
 *
 * **When this fails, the fix is `npx prisma db seed`** — here, and on every environment the change
 * is deployed to.
 */

describe("the database knows what the manifests declare", () => {
  it("has a row for every declared permission", async () => {
    const declared = registry.permissions.map((permission) => permission.key);

    const rows = await db.permission.findMany({ select: { key: true } });
    const seeded = new Set(rows.map((row) => row.key));

    const missing = declared.filter((key) => !seeded.has(key)).sort();
    expect(missing, `Not seeded — run \`npx prisma db seed\`: ${missing.join(", ")}`).toEqual([]);
  });

  /**
   * A permission nobody holds is the same failure wearing a different hat: the screen exists, the
   * gate exists, and the person the manifest says should pass it cannot.
   */
  it("grants each permission to the roles its manifest names", async () => {
    const granted = await db.rolePermission.findMany({
      select: { role: { select: { key: true } }, permission: { select: { key: true } } },
    });
    const held = new Set(granted.map((row) => `${row.role.key}:${row.permission.key}`));

    const ungranted: string[] = [];
    for (const permission of registry.permissions) {
      // `defaultRoles` is optional, and an empty one is a real answer: a permission nobody holds
      // until an admin grants it by hand. Only what a manifest actually promises is checked.
      for (const roleKey of permission.defaultRoles ?? []) {
        if (!held.has(`${roleKey}:${permission.key}`)) {
          ungranted.push(`${roleKey} lacks ${permission.key}`);
        }
      }
    }

    expect(ungranted.sort(), "Run `npx prisma db seed`").toEqual([]);
  });
});

/**
 * Every role a manifest names must be a role that exists.
 *
 * ## The failure this catches
 *
 * `defaultRoles` is `string[]`. Nothing in TypeScript, in the manifest schema, or in any test stopped
 * a manifest naming `project_engineer` — a plausible-sounding role AIES does not have — and the only
 * symptom was `prisma db seed` dying half-way through with `P2025: No record was found for a query`
 * and a stack trace pointing at `seed.ts:188`, naming neither the manifest nor the role.
 *
 * That happened on 2026-08-20 while adding `expense.submit`. It was found immediately because the
 * seed was run immediately — but a manifest edit whose seed is deferred would leave a permission
 * **partly granted**: every role before the bad one gets its row, the seed aborts, and the roles
 * after it silently get nothing. A half-seeded permission is worse than an unseeded one, because the
 * screen works for whoever tries it first.
 *
 * Reading `Role` rather than a constant, because the roles are seeded data and a list here would be
 * a second copy to drift.
 */
describe("the roles a manifest names", () => {
  it("all exist", async () => {
    const roles = await db.role.findMany({ select: { key: true } });
    const known = new Set(roles.map((role) => role.key));

    const unknown = registry.permissions
      .flatMap((permission) =>
        // Optional in the manifest type: a permission granted to nobody by default is legitimate.
        (permission.defaultRoles ?? []).map((role) => ({ role, permission: permission.key })),
      )
      .filter((named) => !known.has(named.role));

    expect(
      unknown,
      unknown.length === 0
        ? ""
        : `These manifests name roles that do not exist: ` +
            unknown.map((u) => `${u.permission} → "${u.role}"`).join(", ") +
            `. Known roles: ${[...known].sort().join(", ")}.`,
    ).toEqual([]);
  });
});
