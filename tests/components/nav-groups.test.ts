import { describe, expect, it } from "vitest";
import { groupNav } from "@/components/shell/AppShell";
import { registry } from "@/server/core/manifests";

/**
 * The order of the sidebar's groups.
 *
 * ## Why this is worth a test
 *
 * Until 2026-08-21 a group's position was whatever the lowest `order` among its entries happened to
 * be — numbers chosen to sequence entries *inside* a group, never to rank the groups. Finance led
 * the sidebar because "Cash to release" is 1. That meant the shape of the sidebar could change
 * because somebody added a screen with a low number, in a module they were not thinking about, and
 * nothing would have said so.
 *
 * The order is now stated, and this is what stops it drifting back.
 */
describe("the sidebar's groups", () => {
  const groups = groupNav(
    registry.nav.map((entry) => ({
      label: entry.label,
      href: entry.href,
      icon: entry.icon ?? null,
      group: entry.group ?? null,
    })),
  ).map(({ group }) => group);

  it("puts the ungrouped entries at the top", () => {
    // My Work, My day and Approvals: the three things that are about the person rather than a kind
    // of record. They have no heading to fold, so they lead.
    expect(groups[0]).toBeNull();
  });

  it("puts Collaboration before Finance", () => {
    // The company's decision of 2026-08-21: it is where the day starts.
    expect(groups.indexOf("Collaboration")).toBeLessThan(groups.indexOf("Finance"));
  });

  it("keeps Admin at the bottom", () => {
    expect(groups[groups.length - 1]).toBe("Admin");
  });

  it("lists every group exactly once", () => {
    expect(new Set(groups).size).toBe(groups.length);
  });
});
