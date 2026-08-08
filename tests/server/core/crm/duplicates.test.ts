import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { emailDomain, findDuplicateAccounts } from "@/server/core/crm/duplicates";

/**
 * specs/01-crm-inquiry.md §7. These run against the real database because the whole mechanism is
 * `pg_trgm` similarity and a correlated subquery — mocking it would only test the mock.
 */

const suffix = randomUUID().slice(0, 8);
const ownerId = "test-owner";
const ids: string[] = [];

async function makeAccount(name: string, tin?: string | null) {
  const account = await db.customerAccount.create({
    data: { code: `TST-${randomUUID().slice(0, 12)}`, name, tin: tin ?? null, ownerId },
  });
  ids.push(account.id);
  return account;
}

beforeAll(async () => {
  const maynilad = await makeAccount(`Maynilad Water Services ${suffix}`, "123-456-789-000");
  await db.contact.create({
    data: {
      accountId: maynilad.id,
      firstName: "Test",
      lastName: "Engineer",
      email: `eng@maynilad-${suffix}.com.ph`,
    },
  });
  // A genuinely unrelated company whose name shares no trigrams.
  await makeAccount(`Zamboanga Sugar Milling ${suffix}`, "999-888-777-000");
}, 60_000);

afterAll(async () => {
  await db.contact.deleteMany({ where: { accountId: { in: ids } } });
  await db.customerAccount.deleteMany({ where: { id: { in: ids } } });
});

describe("emailDomain", () => {
  it("extracts the domain", () => {
    expect(emailDomain("jose@maynilad.com.ph")).toBe("maynilad.com.ph");
  });

  it("ignores free public mailboxes", () => {
    // Otherwise every account with a gmail contact would look like a duplicate of every other one.
    expect(emailDomain("jose@gmail.com")).toBeNull();
    expect(emailDomain("jose@yahoo.com.ph")).toBeNull();
  });

  it("returns null for junk rather than throwing", () => {
    expect(emailDomain(null)).toBeNull();
    expect(emailDomain("not-an-email")).toBeNull();
    expect(emailDomain("trailing@")).toBeNull();
  });
});

describe("findDuplicateAccounts", () => {
  it("catches the spelling drift §7 warns about, via name similarity", async () => {
    const hits = await findDuplicateAccounts({ name: `Maynilad Water Svcs ${suffix}` });
    const match = hits.find((h) => h.name.startsWith("Maynilad"));
    expect(match, "expected the near-name match to be found").toBeDefined();
    expect(match?.reasons).toContain("name");
  }, 30_000);

  it("catches a renamed record by TIN, ignoring punctuation", async () => {
    // Same legal entity entered under a trading name — no name overlap at all.
    const hits = await findDuplicateAccounts({
      name: `Completely Different Holdings ${suffix}`,
      tin: "123456789000",
    });
    const match = hits.find((h) => h.reasons.includes("tin"));
    expect(match, "TIN should match regardless of dashes").toBeDefined();
    expect(match?.name).toContain("Maynilad");
  }, 30_000);

  it("catches a renamed record by contact email domain", async () => {
    const hits = await findDuplicateAccounts({
      name: `Another Unrelated Name ${suffix}`,
      email: `procurement@maynilad-${suffix}.com.ph`,
    });
    expect(hits.some((h) => h.reasons.includes("email_domain"))).toBe(true);
  }, 30_000);

  it("does not flag an unrelated company", async () => {
    const hits = await findDuplicateAccounts({ name: `Bataan Steel Fabrication ${suffix}` });
    expect(hits.some((h) => h.name.includes("Zamboanga"))).toBe(false);
  }, 30_000);

  it("excludes the account being edited, so it cannot match itself", async () => {
    const self = await db.customerAccount.findFirstOrThrow({
      where: { name: `Maynilad Water Services ${suffix}` },
    });
    const hits = await findDuplicateAccounts({
      name: self.name,
      tin: self.tin,
      excludeAccountId: self.id,
    });
    expect(hits.some((h) => h.id === self.id)).toBe(false);
  }, 30_000);

  it("returns nothing for an empty name without touching the database", async () => {
    expect(await findDuplicateAccounts({ name: "   " })).toEqual([]);
  });

  it("ranks a TIN match above a merely similar name", async () => {
    const hits = await findDuplicateAccounts({
      name: `Maynilad Water Services ${suffix}`,
      tin: "999888777000",
    });
    // Zamboanga shares no name trigrams but holds that TIN, so it must come first.
    expect(hits[0]?.reasons).toContain("tin");
  }, 30_000);
});
