import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { homeSummaryService } from "@/server/core/home/home-service";
import type { AuthedUser } from "@/server/core/rbac/types";

/**
 * `/`'s content: what needs this person, across every module.
 *
 * ## Why the assertions are relative rather than absolute
 *
 * Most tiles count a *global* queue — every open warranty claim, every unapproved service report —
 * not rows belonging to this test's fixtures. Asserting `count === 1` would pass alone and fail in
 * the full suite the moment another file leaves an open claim behind, which is exactly the coupling
 * docs/DECISIONS.md #64 was written about. So each count is read before and after, and the *change*
 * is what gets asserted.
 */

const accountIds: string[] = [];
const claimIds: string[] = [];
const userIds: string[] = [];

async function makeUser(permissions: string[]): Promise<AuthedUser> {
  const role = await db.role.findUniqueOrThrow({ where: { key: "operations_manager" } });
  const user = await db.user.create({
    data: {
      email: `home-${randomUUID().slice(0, 8)}@test.local`,
      name: `Home tester ${randomUUID().slice(0, 4)}`,
      passwordHash: "x",
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  userIds.push(user.id);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    roleKeys: ["operations_manager"],
    permissions: new Set(permissions),
  };
}

const tileFor = (summary: { tiles: { key: string; count: number }[] }, key: string) =>
  summary.tiles.find((tile) => tile.key === key);

afterAll(async () => {
  await db.warrantyClaim.deleteMany({ where: { id: { in: claimIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: [...claimIds, ...accountIds] } } });
  await db.eventOutbox.deleteMany({ where: { actorId: { in: userIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("which tiles exist at all", () => {
  /**
   * The rule the page rests on. A count of a queue you cannot open is noise dressed as information,
   * and worse, a tile reading 0 says "nothing is waiting" to somebody who would never have been told
   * either way. Absent and zero must not look the same — the distinction that runs through every gate
   * in this platform.
   */
  it("omits a tile the person holds no permission for, rather than showing it at zero", async () => {
    const bare = await makeUser([]);
    const summary = await homeSummaryService(bare);

    expect(tileFor(summary, "warrantyClaims")).toBeUndefined();
    expect(tileFor(summary, "quotationApprovals")).toBeUndefined();
    expect(tileFor(summary, "closeOut")).toBeUndefined();
    expect(summary.hiddenForPermissions).toBeGreaterThan(0);
  });

  /** Everyone reaches their own approval inbox, so that one is never gated. */
  it("always offers the approval inbox", async () => {
    const bare = await makeUser([]);
    const summary = await homeSummaryService(bare);
    expect(tileFor(summary, "approvals")).toBeDefined();
  });

  it("adds each tile as its permission is granted", async () => {
    const officer = await makeUser([
      "quotation.approve",
      "ticket.view",
      "ticket.execute",
      "cash_advance.review_liquidation",
      "warranty.determine",
      "project.view",
    ]);
    const summary = await homeSummaryService(officer);

    for (const key of [
      "approvals",
      "quotationApprovals",
      "myTickets",
      "blockedTickets",
      "openInspections",
      "liquidations",
      "warrantyClaims",
      "closeOut",
    ]) {
      expect(tileFor(summary, key), `${key} should be present`).toBeDefined();
    }
    expect(summary.hiddenForPermissions).toBe(0);
  });
});

describe("what the tiles count", () => {
  it("counts an unanswered warranty claim when one appears", async () => {
    const officer = await makeUser(["warranty.determine"]);

    const before = tileFor(await homeSummaryService(officer), "warrantyClaims")!.count;

    const account = await db.customerAccount.create({
      data: {
        code: `HOME-${randomUUID().slice(0, 12)}`,
        name: `Home Co ${randomUUID().slice(0, 6)}`,
        ownerId: officer.id,
      },
    });
    accountIds.push(account.id);

    const claim = await db.warrantyClaim.create({
      data: {
        number: `AIESWC-HOME${randomUUID().slice(0, 5)}`,
        accountId: account.id,
        reportedById: officer.id,
        faultDescription: "Reads zero on start-up",
        coverage: "unknown",
        billable: false,
        status: "open",
      },
    });
    claimIds.push(claim.id);

    const after = tileFor(await homeSummaryService(officer), "warrantyClaims")!.count;
    expect(after).toBe(before + 1);
  });

  /**
   * `allClear` is what the screen shows instead of an empty page, so it has to mean what it says. A
   * blank page and "nothing is waiting on you" are the same pixels and opposite messages.
   */
  it("is not all clear while something is waiting", async () => {
    const officer = await makeUser(["warranty.determine"]);
    const summary = await homeSummaryService(officer);

    // The claim from the previous case is still open, so this cannot be clear.
    expect(summary.tiles.some((tile) => tile.count > 0)).toBe(true);
    expect(summary.allClear).toBe(false);
  });

  it("reports all clear for somebody with nothing in front of them", async () => {
    // Only the approval inbox, which is empty for a brand-new user nobody has routed anything to.
    const bare = await makeUser([]);
    const summary = await homeSummaryService(bare);

    expect(summary.tiles).toHaveLength(1);
    expect(summary.tiles[0]!.count).toBe(0);
    expect(summary.allClear).toBe(true);
  });

  it("gives every tile a destination and a word for zero", async () => {
    const officer = await makeUser([
      "quotation.approve",
      "ticket.view",
      "ticket.execute",
      "cash_advance.review_liquidation",
      "warranty.determine",
      "project.view",
    ]);
    const summary = await homeSummaryService(officer);

    for (const tile of summary.tiles) {
      expect(tile.href.startsWith("/"), `${tile.key} needs a destination`).toBe(true);
      expect(tile.clear.length, `${tile.key} needs something to say at zero`).toBeGreaterThan(0);
      expect(tile.detail.length, `${tile.key} needs to say what the number means`).toBeGreaterThan(
        0,
      );
    }
  });
});
