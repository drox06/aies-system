import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { registry } from "@/server/core/manifests";

/**
 * Every screen is reachable, and every menu item goes somewhere.
 *
 * ## Why this test exists
 *
 * Three times in two days a finished, tested feature shipped with no way in (docs/DECISIONS.md #94):
 *
 *  - `/field` was built shell-free and left out of the navigation, so the only route in was typing
 *    the URL. The company reported "I don't see the /field screen", correctly.
 *  - §15's eleven checklists were reachable only through a dropdown on a ticket, and became invisible
 *    the moment the last ticket was deleted.
 *  - §17's scheduling had a tested procedure and no screen that called it — found only because
 *    somebody asked how a reminder would reach the person booking.
 *
 * Every one was invisible to the whole suite, because a route that exists and a route somebody can
 * *find* are different facts and nothing was checking the second. This checks it.
 *
 * ## What it deliberately allows
 *
 * Detail pages (`[id]`) are reached from their list, which is correct — a menu item per record would
 * be absurd. The sign-in flow is reached by being signed out. `/` is where a bookmark lands. Those
 * are listed by name below so that adding to the list is a decision somebody makes on purpose rather
 * than a silent exemption.
 */

/** Routes reachable without a menu entry, each for a stated reason. */
const REACHED_ANOTHER_WAY: Record<string, string> = {
  "/": "Where a bookmark and the post-login redirect land. No nav entry by decision (#78).",
  "/login": "Reached by being signed out.",
  "/enroll-totp": "Reached by the first-login gate.",
  "/change-password": "Reached by the forced-change gate.",
  "/notifications": "Reached from the bell in the top bar.",
};

/** Every .tsx under a directory, with its contents, for link checking. */
function sourceFiles(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith(".tsx")) {
      out.push({ path: full.split(sep).join("/"), text: readFileSync(full, "utf8") });
    }
  }
  return out;
}

function servedRoutes(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    // `api` serves routes rather than pages; `_` prefixes are Next's private folders.
    if (entry.startsWith("_") || entry === "api") continue;

    const href = `${prefix}/${entry}`;
    if (existsSync(join(full, "page.tsx"))) out.push(href);
    out.push(...servedRoutes(full, href));
  }
  return out;
}

describe("every screen has a door", () => {
  const served = servedRoutes("src/app");
  const navHrefs = new Set(registry.nav.map((entry) => entry.href));

  it("finds the app's screens at all, so an empty result cannot pass this file", () => {
    expect(served.length).toBeGreaterThan(20);
    expect(navHrefs.size).toBeGreaterThan(10);
  });

  /**
   * The failure that produced this test three times over. A screen nobody can navigate to is
   * finished work that does not exist as far as the company is concerned.
   */
  it("has no top-level screen that only a typed URL can reach", () => {
    const orphans = served.filter(
      (href) =>
        !navHrefs.has(href) &&
        // Detail pages are reached from their list.
        !href.includes("[") &&
        !(href in REACHED_ANOTHER_WAY),
    );

    expect(
      orphans,
      `These screens exist and nothing offers them. Either add a nav entry to the module manifest, ` +
        `or add the route to REACHED_ANOTHER_WAY with the reason somebody reaches it: ` +
        `${orphans.join(", ")}`,
    ).toEqual([]);
  });

  /** The same mistake pointing the other way: a menu item that opens onto a 404. */
  it("has no menu item pointing at a screen that does not exist", () => {
    const broken = [...navHrefs].filter((href) => !served.includes(href));
    expect(
      broken,
      `The navigation offers these and there is no page behind them: ${broken.join(", ")}`,
    ).toEqual([]);
  });

  /**
   * A detail page nothing links to is the same problem one level down.
   *
   * **Linked from somewhere, not "has a list at its parent path."** The first version of this test
   * asserted the second and failed on two routes that are perfectly reachable:
   * `/material-requests/[id]` is linked from `/store`, and `/procurement/receipts/[id]` from
   * `/procurement`. A list does not have to sit at the parent URL — what matters is whether anything
   * a person can reach offers the link.
   */
  it("gives every detail page something that links to it", () => {
    const sources = sourceFiles("src/app");
    const unlinked = served
      .filter((href) => href.endsWith("]"))
      .filter((href) => {
        // `/material-requests/[id]` is linked as `/material-requests/${...}`.
        const stem = href.slice(0, href.lastIndexOf("/"));
        const detailPage = ["src/app", ...href.split("/").filter(Boolean), "page.tsx"].join("/");
        return !sources.some((file) => file.path !== detailPage && file.text.includes(`${stem}/$`));
      });

    expect(
      unlinked,
      `Nothing in the app links to these, so only a typed URL reaches them: ${unlinked.join(", ")}`,
    ).toEqual([]);
  });
});
