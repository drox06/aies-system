import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  deleteContactService,
  listContactsService,
  upsertContactService,
} from "@/server/core/crm/contact-service";

/**
 * Several contacts per customer, and per plant — the company's request: *"this is needed when
 * handling multiple plant locations of 1 client."*
 *
 * The model has supported this since session 2. What follows is mostly about the one invariant that
 * is easy to break with a second writer: exactly one primary contact per account.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `cont-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "EM" };

const accountIds: string[] = [];
const siteIds: string[] = [];
const contactIds: string[] = [];

async function makeAccount() {
  const account = await db.customerAccount.create({
    data: { code: `CT-${randomUUID().slice(0, 12)}`, name: `Contact Co ${suffix}`, ownerId: OWNER },
  });
  accountIds.push(account.id);
  return account;
}

async function makeSite(accountId: string, name: string) {
  const site = await db.site.create({ data: { accountId, name } });
  siteIds.push(site.id);
  return site;
}

async function add(accountId: string, firstName: string, extra: Record<string, unknown> = {}) {
  const contact = await upsertContactService(actor, {
    accountId,
    firstName,
    lastName: "Reyes",
    ...extra,
  });
  contactIds.push(contact.id);
  return contact;
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityId: { in: [...contactIds, ...accountIds] } } });
  await db.contact.deleteMany({ where: { id: { in: contactIds } } });
  await db.site.deleteMany({ where: { id: { in: siteIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("several contacts on one customer", () => {
  it("keeps every one of them", async () => {
    const account = await makeAccount();
    await add(account.id, "Ana");
    await add(account.id, "Ben");
    await add(account.id, "Carlo");

    const contacts = await listContactsService(account.id);
    expect(contacts).toHaveLength(3);
  }, 60_000);

  it("attaches a contact to the plant they run", async () => {
    const account = await makeAccount();
    const plantTwo = await makeSite(account.id, "Plant 2");
    const contact = await add(account.id, "Dina", { siteId: plantTwo.id });

    expect(contact.siteId).toBe(plantTwo.id);
    const listed = await listContactsService(account.id);
    expect(listed.find((c) => c.id === contact.id)!.site!.name).toBe("Plant 2");
  }, 60_000);

  it("refuses a plant belonging to a different customer", async () => {
    // Only shows up when somebody rings the wrong site, which is far too late.
    const account = await makeAccount();
    const other = await makeAccount();
    const theirPlant = await makeSite(other.id, "Their Plant");

    await expect(
      upsertContactService(actor, {
        accountId: account.id,
        firstName: "Elena",
        lastName: "Reyes",
        siteId: theirPlant.id,
      }),
    ).rejects.toThrow(/does not belong to this customer/i);
  }, 60_000);
});

describe("the primary contact", () => {
  it("makes the first person primary without being asked", async () => {
    // An account whose only contact is not its primary contact reads as an oversight everywhere it
    // appears, starting with the accounts list.
    const account = await makeAccount();
    const first = await add(account.id, "Ana");

    expect(first.isPrimary).toBe(true);
  }, 60_000);

  it("does not make the second person primary as well", async () => {
    const account = await makeAccount();
    await add(account.id, "Ana");
    const second = await add(account.id, "Ben");

    expect(second.isPrimary).toBe(false);
  }, 60_000);

  it("demotes the incumbent when somebody else is promoted", async () => {
    const account = await makeAccount();
    const ana = await add(account.id, "Ana");
    const ben = await add(account.id, "Ben");

    await upsertContactService(actor, {
      accountId: account.id,
      contactId: ben.id,
      firstName: "Ben",
      lastName: "Reyes",
      isPrimary: true,
    });

    const contacts = await listContactsService(account.id);
    expect(contacts.filter((c) => c.isPrimary)).toHaveLength(1);
    expect(contacts.find((c) => c.id === ben.id)!.isPrimary).toBe(true);
    expect(contacts.find((c) => c.id === ana.id)!.isPrimary).toBe(false);
  }, 60_000);

  it("leaves the account with no primary when the primary is removed", async () => {
    // Rather than promoting somebody at random. Which of four plant engineers speaks for the
    // company is not a question software should answer alphabetically.
    const account = await makeAccount();
    const ana = await add(account.id, "Ana");
    await add(account.id, "Ben");

    const result = await deleteContactService(actor, { contactId: ana.id });

    expect(result.wasPrimary).toBe(true);
    const contacts = await listContactsService(account.id);
    expect(contacts).toHaveLength(1);
    expect(contacts.every((c) => !c.isPrimary)).toBe(true);
  }, 60_000);

  it("removes softly, so a quotation naming that person still resolves", async () => {
    const account = await makeAccount();
    const ana = await add(account.id, "Ana");

    await deleteContactService(actor, { contactId: ana.id, reason: "Left the company." });

    const row = await db.contact.findUniqueOrThrow({ where: { id: ana.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedBy).toBe(OWNER);
  }, 60_000);
});
