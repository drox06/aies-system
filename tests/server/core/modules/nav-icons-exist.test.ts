import { describe, expect, it } from "vitest";
import { registry } from "@/server/core/manifests";
import { NAV_ICON_NAMES, isNavIconName } from "@/components/shell/nav-icons";

/**
 * Every icon a module asks for is one the shell can actually draw.
 *
 * ## Why this test exists
 *
 * Four times now a nav entry has shipped naming an icon nothing maps, and rendered a small grey dot:
 * `truck` with module 03's supplier entry, then `receipt` and `phone` with module 05's finance
 * entries — the last two found by the company on 2026-08-19, looking at their own sidebar.
 *
 * Every one survived review for the same reason. The fallback is deliberately quiet, because an
 * entry with genuinely no icon should not shout — so a *missing* icon and a *misspelt* one look
 * identical, and the second is invisible to anybody who is not comparing the manifest against the
 * map by eye. The comment above `truck` in AppShell.tsx has warned about exactly this since session
 * 1 of module 03, and warned about it twice more while two further instances shipped. A comment is
 * not a control.
 *
 * ## What holds it now
 *
 * Two things, and this is the second:
 *
 *  - `ICONS` in AppShell is typed `Record<NavIconName, LucideIcon>`, so a name in the list with no
 *    picture beside it fails the build.
 *  - This test walks every registered manifest and asserts the reverse — that a name a manifest asks
 *    for is one the list knows. Between them the vocabulary and the pictures cannot drift.
 *
 * Neither replaces looking at the sidebar. What they do is make the failure loud instead of grey.
 */
describe("nav icons", () => {
  const entries = registry.modules.flatMap((module) =>
    (module.nav ?? []).map((entry) => ({ module: module.key, ...entry })),
  );

  it("has nav entries to check, so a broken registry cannot pass this vacuously", () => {
    // Without this, a registry that loaded nothing would sail through every assertion below by
    // having nothing to assert about — the shape of green that means the test stopped working.
    expect(entries.length).toBeGreaterThan(10);
  });

  it("names only icons the shell can draw", () => {
    const unknown = entries
      .filter((entry) => entry.icon && !isNavIconName(entry.icon))
      .map((entry) => `${entry.module}: "${entry.label}" asks for "${entry.icon}"`);

    expect(
      unknown,
      `These render a placeholder dot rather than an icon. Add the name to NAV_ICON_NAMES in ` +
        `src/components/shell/nav-icons.ts and the picture to ICONS in AppShell.tsx.\n` +
        unknown.join("\n"),
    ).toEqual([]);
  });

  /**
   * The other direction. A name nobody uses is not a defect, but a long tail of them means the list
   * has stopped describing the app — and the next person adding an entry reads the list to find out
   * what is available.
   */
  it("has no icon names left over from entries that no longer exist", () => {
    const used = new Set(entries.map((entry) => entry.icon).filter(Boolean));
    const unused = NAV_ICON_NAMES.filter((name) => !used.has(name));

    expect(
      unused,
      `Named in nav-icons.ts but asked for by no manifest. Remove them, or the list stops being a ` +
        `description of what the sidebar can show.\n${unused.join(", ")}`,
    ).toEqual([]);
  });
});
