import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registry } from "@/server/core/manifests";

/**
 * Every declared permission must actually gate something.
 *
 * ## Why this test exists
 *
 * Modules 03 and 04 declared their permissions on opposite principles — module 03 listed its whole
 * §10 up front so that "a permission that appears later means a role assignment that has to be
 * redone", module 04 declared seven of §19's thirty so that no permission would sit in the role
 * screen granting access to nothing. The company asked which was right before the difference could
 * cause trouble, and the answer turned out to be **neither, as stated**:
 *
 * - Module 03's justification does not hold. `prisma/seed.ts` upserts a permission *and* its
 *   `defaultRoles` on every run, so a permission added in a later session is granted automatically
 *   at the next seed. There is no re-work to avoid.
 * - Module 04's principle is right but it did not follow it either — it declared `ticket.cancel`,
 *   `project.manage` and `project.view` with nothing behind them.
 *
 * So the rule is now one rule, the same one `emits` already follows: **declare a permission in the
 * change that uses it.** This test is what makes that real rather than a note somebody remembers.
 *
 * A dead permission is not harmless. It appears in the admin role screen, somebody grants it,
 * expects an approval queue or a delete button, and finds nothing — which teaches people that the
 * permissions in this system do not mean anything. That lesson is expensive to unteach.
 */

const SRC = join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

/** Every permission string the app actually consults, however it consults it. */
function referencedPermissions(): Set<string> {
  const found = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    // `p("x")` — the tRPC gate. `permissions.has("x")` / `includes("x")` — the in-service and
    // in-component checks. And a bare constant, for the keys hoisted into a rules file.
    for (const pattern of [
      /\bp\(\s*"([a-z_]+\.[a-z_]+)"\s*\)/g,
      /permissions\.has\(\s*"([a-z_]+\.[a-z_]+)"\s*\)/g,
      /permissions\s*\)\.includes\(\s*"([a-z_]+\.[a-z_]+)"\s*\)/g,
      /includes\(\s*"([a-z_]+\.[a-z_]+)"\s*\)/g,
      /=\s*"([a-z_]+\.[a-z_]+)"\s*;/g,
    ]) {
      for (const match of text.matchAll(pattern)) found.add(match[1]!);
    }
  }
  return found;
}

/**
 * Permissions that may be declared without a gate, each with the reason.
 *
 * Keep this list short and each entry justified. "We will need it soon" is not a reason — that is
 * precisely the argument this test exists to refuse.
 */
const DECLARED_WITHOUT_A_GATE: Record<string, string> = {
  // Module 00 seeds these directly rather than through a manifest, and modules 04/05 gate on them
  // when their sessions land. They are in prisma/seed.ts's own PERMISSIONS list, not a manifest, so
  // they never reach this test — listed here only so the reader is not left wondering.
};

describe("every declared permission gates something", () => {
  it("has no permission in a manifest that nothing consults", () => {
    const referenced = referencedPermissions();
    const dead = registry.permissions
      .map((permission) => permission.key)
      .filter((key) => !referenced.has(key) && !(key in DECLARED_WITHOUT_A_GATE));

    expect(
      dead,
      `These permissions are declared in a module manifest and nothing in src/ consults them. ` +
        `They will appear in the admin role screen granting access to nothing. Either gate ` +
        `something with them, or move the declaration into the session that does — the same rule ` +
        `\`emits\` follows. If one genuinely must be declared ahead of use, add it to ` +
        `DECLARED_WITHOUT_A_GATE with the reason.`,
    ).toEqual([]);
  });

  it("finds the permissions it should, so an empty result never means a broken scan", () => {
    // A regex that stopped matching would make the test above pass vacuously — which is the failure
    // mode of every "assert nothing is wrong" test.
    const referenced = referencedPermissions();
    expect(referenced.has("crm.view")).toBe(true);
    expect(referenced.has("supplier.approve")).toBe(true);
    expect(referenced.has("ticket.generate")).toBe(true);
    // Read via `permissions.has(...)` in a service rather than `p(...)` in the router.
    expect(referenced.has("project.view_cost")).toBe(true);
  });
});
