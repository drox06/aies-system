import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { upsertContactService } from "@/server/core/crm/contact-service";
import {
  deleteSiteService,
  listSitesService,
  upsertSiteService,
} from "@/server/core/crm/site-service";

/**
 * A customer's plants (specs/01-crm-inquiry.md §1-2), which the company asked to be able to add.
 *
 * `Site` was modelled properly in session 2 and then had no way in — inquiries, quotations and
 * inspection requests all point at one, and every picker was empty because nothing could create one.
 *
 * Most of what is worth pinning is the removal rule: a plant named on a record somebody has already
 * sent must not quietly stop existing underneath it.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `site-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "EM" };

const accountIds: string[] = [];
const siteIds: string[] = [];
const contactIds: string[] = [];
const inquiryIds: string[] = [];

async function makeAccount() {
  const account = await db.customerAccount.create({
    data: { code: `ST-${randomUUID().slice(0, 12)}`, name: `Site Co ${suffix}`, ownerId: OWNER },
  });
  accountIds.push(account.id);
  return account;
}

async function addSite(accountId: string, name: string, accessNotes?: string) {
  const site = await upsertSiteService(actor, { accountId, name, accessNotes });
  siteIds.push(site.id);
  return site;
}

afterAll(async () => {
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...siteIds, ...accountIds, ...contactIds, ...inquiryIds] } },
  });
  await db.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await db.contact.deleteMany({ where: { id: { in: contactIds } } });
  await db.site.deleteMany({ where: { id: { in: siteIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("recording a customer's plants", () => {
  it("adds several to one customer", async () => {
    const account = await makeAccount();
    await addSite(account.id, "Balibago Treatment Plant");
    await addSite(account.id, "Santa Rosa Pumping Station");

    const sites = await listSitesService(account.id);
    expect(sites.map((s) => s.name)).toEqual([
      "Balibago Treatment Plant",
      "Santa Rosa Pumping Station",
    ]);
  }, 60_000);

  it("keeps the access notes, which are the point of the record", async () => {
    // §2 names gate pass, PPE and induction specifically: the difference between a technician
    // getting on site and losing a day at the gate.
    const account = await makeAccount();
    const site = await addSite(
      account.id,
      "Refinery 2",
      "Gate pass 48h ahead. Full PPE plus H2S monitor.",
    );

    expect(site.accessNotes).toContain("H2S monitor");
  }, 60_000);

  it("refuses a plant with no name", async () => {
    const account = await makeAccount();
    await expect(upsertSiteService(actor, { accountId: account.id, name: "   " })).rejects.toThrow(
      /needs a name/i,
    );
  }, 60_000);

  it("refuses a main contact who belongs to a different customer", async () => {
    const account = await makeAccount();
    const other = await makeAccount();
    const theirContact = await upsertContactService(actor, {
      accountId: other.id,
      firstName: "Ana",
      lastName: "Reyes",
    });
    contactIds.push(theirContact.id);

    await expect(
      upsertSiteService(actor, {
        accountId: account.id,
        name: "Plant 3",
        contactId: theirContact.id,
      }),
    ).rejects.toThrow(/does not belong to this customer/i);
  }, 60_000);
});

describe("removing a plant", () => {
  it("refuses while an inquiry still names it", async () => {
    // The failure this prevents: a delivery address that resolves to nothing, on a document already
    // sent, noticed months later on the one job where it mattered.
    const account = await makeAccount();
    const site = await addSite(account.id, "Plant 4");

    const inquiry = await db.inquiry.create({
      data: {
        number: `INQ-TEST-${randomUUID().slice(0, 8)}`,
        accountId: account.id,
        siteId: site.id,
        subject: "Replace the level transmitter",
        ownerId: OWNER,
      },
    });
    inquiryIds.push(inquiry.id);

    await expect(deleteSiteService(actor, { siteId: site.id })).rejects.toThrow(/named on/i);

    const still = await db.site.findUniqueOrThrow({ where: { id: site.id } });
    expect(still.deletedAt).toBeNull();
  }, 60_000);

  it("removes an unused plant softly and keeps its people", async () => {
    // Contacts belong to the customer, not to the building — a plant closing does not mean the
    // engineer stopped working there.
    const account = await makeAccount();
    const site = await addSite(account.id, "Plant 5");
    const contact = await upsertContactService(actor, {
      accountId: account.id,
      firstName: "Ben",
      lastName: "Cruz",
      siteId: site.id,
    });
    contactIds.push(contact.id);

    const result = await deleteSiteService(actor, { siteId: site.id });
    expect(result.contactsDetached).toBe(1);

    const removed = await db.site.findUniqueOrThrow({ where: { id: site.id } });
    expect(removed.deletedAt).not.toBeNull();

    const kept = await db.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(kept.deletedAt).toBeNull();
    expect(kept.siteId).toBeNull();
  }, 60_000);
});
