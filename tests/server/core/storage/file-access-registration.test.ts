import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every module that registers a file-access checker must be listed in register-checkers.ts.
 *
 * ## What went wrong, and why a test rather than a comment
 *
 * `access.ts` keeps its checkers in module-level `Map`s, filled as a side effect of importing the
 * module that owns each entity type. Nothing guaranteed those imports had happened by the time
 * `/api/files/[id]` served a download — the route imports `canAccessFile` and nothing else.
 *
 * On one long-lived Node process it worked by accident: the tRPC route loads every router and
 * therefore every service, so the maps were full by the time anyone clicked a photograph. Next.js
 * bundles each route separately, so in production that route is its own function with an empty map,
 * and `canAccessFile` falls back to `file.uploaderId === user.id` — every file readable only by
 * whoever uploaded it, across all nine entity types.
 *
 * The failure is silent, it is invisible on localhost, and it looks like a permissions bug rather
 * than a bundling one. So this asserts the list is complete by **reading the source**, which is the
 * only way to catch a module that registers a checker and never gets imported: importing the modules
 * here would register them and make any assertion about the registry pass trivially.
 */

const CORE = path.join(process.cwd(), "src", "server", "core");
const BARREL = path.join(CORE, "storage", "register-checkers.ts");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

/** Modules that *call* a registrar — excluding access.ts, which defines them. */
function registrarModules(): string[] {
  return walk(CORE)
    .filter((file) => !file.endsWith(path.join("storage", "access.ts")))
    .filter((file) => {
      const source = readFileSync(file, "utf8");
      return (
        /registerFileAccessChecker\s*\(/.test(source) ||
        /registerFileManageChecker\s*\(/.test(source)
      );
    })
    .map((file) => path.relative(CORE, file).replace(/\\/g, "/").replace(/\.ts$/, ""));
}

describe("file access checker registration", () => {
  it("finds the registrar modules at all, so the scan cannot pass vacuously", () => {
    // A self-check: if the matcher silently stopped matching, every other assertion here would
    // pass against an empty list and prove nothing.
    const modules = registrarModules();
    expect(modules.length).toBeGreaterThanOrEqual(8);
    expect(modules).toContain("crm/accreditation-access");
    expect(modules).toContain("operations/site-inspection-service");
  });

  it("lists every one of them in register-checkers.ts", () => {
    const barrel = readFileSync(BARREL, "utf8");
    const missing = registrarModules().filter(
      (module) => !barrel.includes(`@/server/core/${module}`),
    );

    expect(
      missing,
      "These modules register a file-access checker and are not imported by " +
        "src/server/core/storage/register-checkers.ts. On Vercel the files route is its own bundle, " +
        "so their checkers never register and every file of that entity type becomes downloadable " +
        "only by whoever uploaded it — silently, and invisibly on localhost. Add an import.",
    ).toEqual([]);
  });

  it("is imported by the route that actually answers download requests", () => {
    const route = readFileSync(
      path.join(process.cwd(), "src", "app", "api", "files", "[id]", "route.ts"),
      "utf8",
    );
    expect(route).toContain("register-checkers");
    // Referenced, not merely imported — a bare side-effect import is the line a tidy-up removes.
    expect(route).toContain("FILE_CHECKERS_REGISTERED");
  });
});
