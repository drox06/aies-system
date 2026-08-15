import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  ARCHIVE_AFTER_PO_DAYS,
  QUOTATION_ARCHIVE_PERMISSION,
  sweepQuotationsToArchive,
  unarchiveQuotationService,
} from "@/server/core/quotation/archive-service";
import {
  createQuotationService,
  listQuotationsService,
} from "@/server/core/quotation/quotation-service";

/**
 * The company's archive rule: a quotation whose purchase order arrived fourteen days ago comes off
 * the working list, and only the president and vice-president can look at what has come off it.
 *
 * The assertions are mostly about what does *not* happen — the sweep is a nightly job that changes
 * what everybody sees on their main screen, so the failure modes worth pinning are the ones where
 * it takes too much.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `arch-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "EA (president)" };

const DAY_MS = 86_400_000;

const accountIds: string[] = [];
const quotationIds: string[] = [];
const poIds: string[] = [];

/** A caller who can see everything, including the archive. */
const officer = {
  id: OWNER,
  permissions: new Set([
    "quotation.view",
    "quotation.view_all",
    QUOTATION_ARCHIVE_PERMISSION,
  ]) as ReadonlySet<string>,
};

/** A salesperson: sees their own quotations, has no idea an archive exists. */
const salesperson = {
  id: OWNER,
  permissions: new Set(["quotation.view", "quotation.view_all"]) as ReadonlySet<string>,
};

async function makeAccount() {
  const account = await db.customerAccount.create({
    data: { code: `AR-${randomUUID().slice(0, 12)}`, name: `Arch Co ${suffix}`, ownerId: OWNER },
  });
  accountIds.push(account.id);
  return account;
}

/** An accepted quotation with a PO recorded `poAgeDays` ago. */
async function makeClosedQuotation(poAgeDays: number, accountId?: string) {
  const account = accountId ? { id: accountId } : await makeAccount();
  const quotation = await createQuotationService(actor, {
    accountId: account.id,
    title: `Supply and install ${randomUUID().slice(0, 6)}`,
  });
  quotationIds.push(quotation.id);

  await db.quotation.update({
    where: { id: quotation.id },
    data: { status: "accepted", sentAt: new Date(Date.now() - 60 * DAY_MS) },
  });

  const file = await db.fileObject.create({
    data: {
      entityType: "CustomerPO",
      entityId: quotation.id,
      storageKey: `CustomerPO/${randomUUID()}-po.pdf`,
      filename: "po.pdf",
      mimeType: "application/pdf",
      size: 10,
      sha256: randomUUID().replace(/-/g, ""),
      uploaderId: OWNER,
    },
  });

  const po = await db.customerPO.create({
    data: {
      accountId: account.id,
      quotationId: quotation.id,
      poNumber: `PO-${randomUUID().slice(0, 8)}`,
      poDate: new Date(Date.now() - poAgeDays * DAY_MS),
      amount: "100000",
      fileId: file.id,
      receivedById: OWNER,
      receivedAt: new Date(Date.now() - poAgeDays * DAY_MS),
    },
  });
  poIds.push(po.id);

  return db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityId: { in: [...quotationIds, ...accountIds] } } });
  await db.eventOutbox.deleteMany({ where: { actorId: OWNER } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: quotationIds } } });
  await db.customerPO.deleteMany({ where: { id: { in: poIds } } });
  await db.fileObject.deleteMany({ where: { entityId: { in: quotationIds } } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("the nightly archive sweep", () => {
  it("archives a quotation whose PO is older than the window", async () => {
    const quotation = await makeClosedQuotation(ARCHIVE_AFTER_PO_DAYS + 1);

    const result = await sweepQuotationsToArchive();

    expect(result.archived.map((row) => row.quotationId)).toContain(quotation.id);
    const after = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(after.archivedAt).not.toBeNull();
    // Archiving is not a status change. The customer still accepted it.
    expect(after.status).toBe("accepted");
    expect(after.deletedAt).toBeNull();
  }, 60_000);

  it("leaves one alone while its PO is still recent", async () => {
    // The reason the delay exists: the fortnight after a PO is when people still open the
    // quotation to check it against what the customer actually ordered.
    const quotation = await makeClosedQuotation(ARCHIVE_AFTER_PO_DAYS - 2);

    await sweepQuotationsToArchive();

    const after = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(after.archivedAt).toBeNull();
  }, 60_000);

  it("does not archive an accepted quotation that has no PO behind it", async () => {
    // `accepted` can be reached without a purchase order — a revision chain, a manual transition.
    // Finished work means the order arrived, not that the status says so.
    const account = await makeAccount();
    const quotation = await createQuotationService(actor, {
      accountId: account.id,
      title: "Accepted, but nothing ordered",
    });
    quotationIds.push(quotation.id);
    await db.quotation.update({ where: { id: quotation.id }, data: { status: "accepted" } });

    await sweepQuotationsToArchive();

    const after = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(after.archivedAt).toBeNull();
  }, 60_000);

  it("writes an audit row attributed to the system, not to a person", async () => {
    const quotation = await makeClosedQuotation(ARCHIVE_AFTER_PO_DAYS + 3);
    await sweepQuotationsToArchive();

    const row = await db.auditLog.findFirst({
      where: { entityId: quotation.id, action: "archived" },
    });
    expect(row).not.toBeNull();
    // Attributing a nightly job to whoever triggered the cron would be a lie on the record.
    expect(row!.actorId).toBeNull();
    expect(row!.actorLabel).toContain("System");
  }, 60_000);
});

describe("who sees the archive", () => {
  it("keeps archived quotations off the working list for everybody", async () => {
    const quotation = await makeClosedQuotation(ARCHIVE_AFTER_PO_DAYS + 1);
    await sweepQuotationsToArchive();

    // Including the officers. Nobody opens Quotations to look at last year's closed business.
    const working = await listQuotationsService(officer, { pageSize: 100 });
    expect(working.rows.map((r) => r.id)).not.toContain(quotation.id);
  }, 60_000);

  it("shows them to someone holding quotation.view_archive who asks", async () => {
    const quotation = await makeClosedQuotation(ARCHIVE_AFTER_PO_DAYS + 1);
    await sweepQuotationsToArchive();

    const archive = await listQuotationsService(officer, { archived: true, pageSize: 100 });
    expect(archive.rows.map((r) => r.id)).toContain(quotation.id);
  }, 60_000);

  it("silently gives a salesperson the working list when they ask for the archive", async () => {
    const quotation = await makeClosedQuotation(ARCHIVE_AFTER_PO_DAYS + 1);
    await sweepQuotationsToArchive();

    // Silently, deliberately: an error would confirm that an archive exists to somebody who is not
    // supposed to know.
    const result = await listQuotationsService(salesperson, { archived: true, pageSize: 100 });
    expect(result.rows.map((r) => r.id)).not.toContain(quotation.id);
  }, 60_000);
});

describe("putting one back", () => {
  it("clears archivedAt, and says the sweep will take it again", async () => {
    const quotation = await makeClosedQuotation(ARCHIVE_AFTER_PO_DAYS + 1);
    await sweepQuotationsToArchive();

    const result = await unarchiveQuotationService(actor, {
      quotationId: quotation.id,
      reason: "The PO was cancelled by the customer.",
    });

    const after = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(after.archivedAt).toBeNull();
    // Honest rather than silently re-archiving overnight with no explanation.
    expect(result.warning).toContain("archived again");
  }, 60_000);

  it("refuses one that is not archived", async () => {
    const quotation = await makeClosedQuotation(1);
    await expect(
      unarchiveQuotationService(actor, { quotationId: quotation.id, reason: "why not" }),
    ).rejects.toThrow(/not archived/i);
  }, 60_000);
});
