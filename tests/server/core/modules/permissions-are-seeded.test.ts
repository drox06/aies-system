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
      for (const roleKey of permission.defaultRoles) {
        if (!held.has(`${roleKey}:${permission.key}`)) {
          ungranted.push(`${roleKey} lacks ${permission.key}`);
        }
      }
    }

    expect(ungranted.sort(), "Run `npx prisma db seed`").toEqual([]);
  });
});
