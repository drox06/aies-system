import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { logActivityService } from "@/server/core/crm/activity-service";
import { createInquiryService } from "@/server/core/crm/inquiry-service";
import { mergeAccountsService, previewMergeService } from "@/server/core/crm/merge-service";

/**
 * specs/01-crm-inquiry.md §7's merge, against the real database.
 *
 * §10 states the test: "Merge repoints inquiries, contacts, sites, and activities with no orphans."
 * The last three words are the whole assertion — a merge that moves four of five tables looks like
 * it worked and leaves records pointing at a closed account nobody will ever open again.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `merge-owner-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "Merge Test" };

const accountIds: string[] = [];
const inquiryIds: string[] = [];

async function makeAccount(name: string) {
  const account = await db.customerAccount.create({
    data: {
      code: `MRG-${randomUUID().slice(0, 12)}`,
      name,
      ownerId: OWNER,
      status: "active",
    },
  });
  accountIds.push(account.id);
  return account;
}

/** An account with one of everything the merge has to move. */
async function makePopulatedAccount(name: string) {
  const account = await makeAccount(name);

  await db.site.create({ data: { accountId: account.id, name: "Plant 1" } });
  await db.contact.create({
    data: { accountId: account.id, firstName: "Ana", lastName: "Cruz", isPrimary: true },
  });

  const inquiry = await createInquiryService(actor, {
    subject: `Inquiry for ${name}`,
    accountId: account.id,
    ownerId: OWNER,
  });
  inquiryIds.push(inquiry.id);

  await logActivityService(actor, {
    entityType: "CustomerAccount",
    entityId: account.id,
    type: "call",
    subject: "Introductory call",
  });

  await db.accreditationRecord.create({
    data: { accountId: account.id, ownerId: OWNER, status: "accredited" },
  });

  const child = await makeAccount(`${name} — Subsidiary`);
  await db.customerAccount.update({
    where: { id: child.id },
    data: { parentAccountId: account.id },
  });

  return account;
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityId: { in: [...accountIds, ...inquiryIds] } } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: inquiryIds } } });
  await db.eventOutbox.deleteMany({ where: { actorId: OWNER } });
  await db.activity.deleteMany({ where: { entityId: { in: accountIds } } });
  await db.inquiryItem.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await db.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await db.accreditationRecord.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.contact.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.site.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.customerAccount.updateMany({
    where: { id: { in: accountIds } },
    data: { parentAccountId: null },
  });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("mergeAccountsService", () => {
  it("repoints every child record and leaves no orphans", async () => {
    // §10, verbatim. Each count is checked on both sides: nothing left behind, everything arrived.
    const survivor = await makeAccount(`Maynilad ${suffix}`);
    const duplicate = await makePopulatedAccount(`Maynilad Water Svcs ${suffix}`);

    const result = await mergeAccountsService(actor, {
      survivorId: survivor.id,
      mergedId: duplicate.id,
      reason: "Same TIN, three spellings.",
    });

    expect(result.moved.sites).toBe(1);
    expect(result.moved.contacts).toBe(1);
    expect(result.moved.inquiries).toBe(1);
    expect(result.moved.activities).toBe(1);
    expect(result.moved["sub-accounts"]).toBe(1);

    const orphans = await Promise.all([
      db.site.count({ where: { accountId: duplicate.id } }),
      db.contact.count({ where: { accountId: duplicate.id } }),
      db.inquiry.count({ where: { accountId: duplicate.id } }),
      db.activity.count({ where: { entityType: "CustomerAccount", entityId: duplicate.id } }),
      // The duplicate itself is reparented onto the survivor, so it is the only child left.
      db.customerAccount.count({
        where: { parentAccountId: duplicate.id, deletedAt: null },
      }),
    ]);
    expect(orphans).toEqual([0, 0, 0, 0, 0]);

    const arrived = await Promise.all([
      db.site.count({ where: { accountId: survivor.id } }),
      db.contact.count({ where: { accountId: survivor.id } }),
      db.inquiry.count({ where: { accountId: survivor.id } }),
      db.activity.count({ where: { entityType: "CustomerAccount", entityId: survivor.id } }),
    ]);
    expect(arrived).toEqual([1, 1, 1, 1]);
  });

  it("soft-deletes the duplicate rather than destroying its history", async () => {
    // Spec.md §10: "nothing is hard-deleted". The duplicate's audit trail is evidence of what was
    // merged, and tidying it away would be exactly the wrong trade for an ISO 9001 system.
    const survivor = await makeAccount(`Survivor ${suffix}-b`);
    const duplicate = await makePopulatedAccount(`Duplicate ${suffix}-b`);

    await mergeAccountsService(actor, { survivorId: survivor.id, mergedId: duplicate.id });

    const row = await db.customerAccount.findUnique({ where: { id: duplicate.id } });
    expect(row).not.toBeNull();
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.deletedBy).toBe(OWNER);
    // Findable from the loser afterwards, without having to read the audit prose.
    expect(row?.parentAccountId).toBe(survivor.id);
  });

  it("retires the duplicate's accreditation instead of moving it", async () => {
    // AccreditationRecord is unique per account, so moving one onto an account that already has one
    // would violate the constraint — and "are we accredited with this customer?" has one answer.
    const survivor = await makePopulatedAccount(`Keep ${suffix}-c`);
    const duplicate = await makePopulatedAccount(`Drop ${suffix}-c`);

    const result = await mergeAccountsService(actor, {
      survivorId: survivor.id,
      mergedId: duplicate.id,
    });
    expect(result.moved["accreditations retired"]).toBe(1);

    const retired = await db.accreditationRecord.findFirst({
      where: { accountId: duplicate.id },
    });
    expect(retired?.deletedAt).not.toBeNull();

    const kept = await db.accreditationRecord.findFirst({
      where: { accountId: survivor.id, deletedAt: null },
    });
    expect(kept).not.toBeNull();
  });

  it("writes the merge to both accounts' audit trails", async () => {
    // A single row on the survivor leaves the duplicate's page silent about where everything went.
    const survivor = await makeAccount(`Audit A ${suffix}`);
    const duplicate = await makeAccount(`Audit B ${suffix}`);

    await mergeAccountsService(actor, {
      survivorId: survivor.id,
      mergedId: duplicate.id,
      reason: "Duplicate from a trade show list.",
    });

    for (const id of [survivor.id, duplicate.id]) {
      const audit = await db.auditLog.findFirst({
        where: { entityType: "CustomerAccount", entityId: id, action: "merge" },
      });
      expect(audit, `no merge audit row on ${id}`).not.toBeNull();
      expect(audit?.summary).toContain("trade show");
    }
  });

  it("refuses to merge an account into itself", async () => {
    const account = await makeAccount(`Self ${suffix}`);
    await expect(
      mergeAccountsService(actor, { survivorId: account.id, mergedId: account.id }),
    ).rejects.toThrow(/cannot be merged into itself/);
  });

  it("refuses when either account is already gone", async () => {
    const survivor = await makeAccount(`Live ${suffix}`);
    await expect(
      mergeAccountsService(actor, { survivorId: survivor.id, mergedId: "does-not-exist" }),
    ).rejects.toThrow(/no longer exists/);
  });

  it("handles the duplicate already being a child of the survivor", async () => {
    // Otherwise repointing the hierarchy would make the survivor its own parent.
    const survivor = await makeAccount(`Parent ${suffix}`);
    const duplicate = await makeAccount(`Child ${suffix}`);
    await db.customerAccount.update({
      where: { id: duplicate.id },
      data: { parentAccountId: survivor.id },
    });

    await expect(
      mergeAccountsService(actor, { survivorId: survivor.id, mergedId: duplicate.id }),
    ).resolves.toBeTruthy();

    const row = await db.customerAccount.findUnique({ where: { id: survivor.id } });
    expect(row?.parentAccountId).toBeNull();
  });
});

describe("previewMergeService", () => {
  it("counts what would move, without moving it", async () => {
    // §7's merge cannot be undone from the UI, so the confirmation has to state the real numbers.
    const survivor = await makeAccount(`Preview keep ${suffix}`);
    const duplicate = await makePopulatedAccount(`Preview drop ${suffix}`);

    const preview = await previewMergeService({
      survivorId: survivor.id,
      mergedId: duplicate.id,
    });

    expect(preview.counts.inquiries).toBe(1);
    expect(preview.counts.contacts).toBe(1);
    expect(preview.counts.sites).toBe(1);
    expect(preview.counts.activities).toBe(1);
    expect(preview.accreditationsRetired).toBe(1);

    // Nothing moved.
    const stillThere = await db.inquiry.count({ where: { accountId: duplicate.id } });
    expect(stillThere).toBe(1);
  });
});
