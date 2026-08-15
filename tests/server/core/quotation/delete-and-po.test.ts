import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  CUSTOMER_PO_ENTITY_TYPE,
  recordCustomerPoService,
} from "@/server/core/order/customer-po-service";
import { saveQuotationLinesService } from "@/server/core/quotation/quotation-line-service";
import {
  createQuotationService,
  deleteQuotationService,
  listQuotationsService,
} from "@/server/core/quotation/quotation-service";

/**
 * Two things the company asked for after using the app.
 *
 * **Deleting a quotation**, for the two officers — and soft, because Spec.md §5 says numbers are
 * never reused and a hard delete would free the number to be handed out twice.
 *
 * **Recording a customer PO against a quotation that has no inquiry.** The pipeline is an *inquiry*
 * board, so a quotation raised straight from the Quotations screen had no card to drag and therefore
 * no way to record a PO at all. `CustomerPO.inquiryId` was optional in the model from the start; the
 * service was the thing insisting on it.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `del-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "EA (president)" };

const accountIds: string[] = [];
const quotationIds: string[] = [];
const fileIds: string[] = [];

async function makeSentQuotation() {
  const account = await db.customerAccount.create({
    data: { code: `DL-${randomUUID().slice(0, 12)}`, name: `Del Co ${suffix}`, ownerId: OWNER },
  });
  accountIds.push(account.id);

  const quotation = await createQuotationService(actor, {
    accountId: account.id,
    title: "Supply of a flowmeter",
  });
  quotationIds.push(quotation.id);

  await saveQuotationLinesService(actor, {
    quotationId: quotation.id,
    version: quotation.version,
    canSeeCost: true,
    lines: [{ description: "Flowmeter", quantity: "1", unitCost: "1000", markupPct: "25" }],
  });

  await db.quotation.update({ where: { id: quotation.id }, data: { status: "sent" } });
  return db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
}

async function makeUpload(entityId: string) {
  const file = await db.fileObject.create({
    data: {
      entityType: CUSTOMER_PO_ENTITY_TYPE,
      entityId,
      storageKey: `CustomerPO/${randomUUID()}-po.pdf`,
      filename: "po.pdf",
      mimeType: "application/pdf",
      size: 1234,
      sha256: randomUUID().replace(/-/g, ""),
      uploaderId: OWNER,
    },
  });
  fileIds.push(file.id);
  return file;
}

afterAll(async () => {
  await db.customerPO.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: [...quotationIds, ...accountIds] } } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: quotationIds } } });
  await db.eventOutbox.deleteMany({ where: { actorId: OWNER } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("deleting a quotation", () => {
  it("takes it off the screens without destroying the record or freeing the number", async () => {
    const quotation = await makeSentQuotation();

    await deleteQuotationService(actor, {
      quotationId: quotation.id,
      reason: "Raised against the wrong customer.",
    });

    // Gone from the list…
    const list = await listQuotationsService(
      { id: OWNER, permissions: new Set(["quotation.view", "quotation.view_all"]) },
      {},
    );
    expect(list.rows.map((row) => row.id)).not.toContain(quotation.id);

    // …but still there, with its number, so Spec.md §5's "never reused" still holds.
    const stored = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(stored.deletedAt).toBeTruthy();
    expect(stored.deletedBy).toBe(OWNER);
    expect(stored.number).toBe(quotation.number);

    // And the reason is in the audit trail, which is the only place it survives.
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: quotation.id, action: "delete" },
    });
    expect(audit.summary).toContain("wrong customer");
  }, 60_000);

  it("insists on a reason", async () => {
    const quotation = await makeSentQuotation();

    await expect(
      deleteQuotationService(actor, { quotationId: quotation.id, reason: "  " }),
    ).rejects.toThrow(/Say why/);
  }, 60_000);

  it("refuses when a customer PO answers it", async () => {
    // That PO is a real document referencing this quotation by number. Deleting the thing it
    // answers would leave module 03 holding an order against nothing.
    const quotation = await makeSentQuotation();
    const file = await makeUpload(quotation.id);
    await recordCustomerPoService(actor, {
      quotationId: quotation.id,
      poNumber: "PO-77",
      poDate: new Date(),
      amount: "1000.00",
      fileId: file.id,
    });

    await expect(
      deleteQuotationService(actor, { quotationId: quotation.id, reason: "Tidying up." }),
    ).rejects.toThrow(/cancel the quotation instead/);
  }, 60_000);

  it("takes it out of search too", async () => {
    // Otherwise it stays findable in Ctrl+K and opens a page that refuses to load.
    const quotation = await makeSentQuotation();
    await db.searchIndex.create({
      data: {
        entityType: "Quotation",
        entityId: quotation.id,
        title: quotation.number,
        body: "",
        href: `/quotations/${quotation.id}`,
      },
    });

    await deleteQuotationService(actor, { quotationId: quotation.id, reason: "Duplicate." });

    const indexed = await db.searchIndex.count({ where: { entityId: quotation.id } });
    expect(indexed).toBe(0);
  }, 60_000);
});

describe("a customer PO on a quotation with no inquiry", () => {
  it("records against the quotation and does not need a card to move", async () => {
    // The gap the company hit: a quotation raised outside the pipeline had no inquiry, so the board
    // had nothing to drag and the PO form lived only on the card.
    const quotation = await makeSentQuotation();
    expect(quotation.inquiryId).toBeNull();

    const file = await makeUpload(quotation.id);
    const result = await recordCustomerPoService(actor, {
      quotationId: quotation.id,
      poNumber: "PO-2026-0451",
      poDate: new Date("2026-08-14"),
      amount: "1250.00",
      fileId: file.id,
    });

    expect(result.inquiryMoved).toBe(false);
    expect(result.status).toBe("recorded");

    const po = await db.customerPO.findFirstOrThrow({ where: { quotationId: quotation.id } });
    expect(po.poNumber).toBe("PO-2026-0451");
    expect(po.inquiryId).toBeNull();
    expect(po.accountId).toBe(quotation.accountId);
  }, 60_000);

  it("still refuses a file uploaded against something else", async () => {
    const quotation = await makeSentQuotation();
    const stray = await makeUpload("some-other-record");

    await expect(
      recordCustomerPoService(actor, {
        quotationId: quotation.id,
        poNumber: "PO-9",
        poDate: new Date(),
        amount: "10.00",
        fileId: stray.id,
      }),
    ).rejects.toThrow(/not uploaded as this record's purchase order/);
  }, 60_000);

  it("refuses a quotation the customer has not been sent", async () => {
    const account = await db.customerAccount.create({
      data: { code: `DR-${randomUUID().slice(0, 12)}`, name: `Draft Co ${suffix}`, ownerId: OWNER },
    });
    accountIds.push(account.id);
    const quotation = await createQuotationService(actor, {
      accountId: account.id,
      title: "Still a draft",
    });
    quotationIds.push(quotation.id);
    const file = await makeUpload(quotation.id);

    await expect(
      recordCustomerPoService(actor, {
        quotationId: quotation.id,
        poNumber: "PO-8",
        poDate: new Date(),
        amount: "10.00",
        fileId: file.id,
      }),
    ).rejects.toThrow(/answers a quotation they have been sent/);
  }, 60_000);

  it("needs one of an inquiry or a quotation", async () => {
    await expect(
      recordCustomerPoService(actor, {
        poNumber: "PO-7",
        poDate: new Date(),
        amount: "10.00",
        fileId: "whatever",
      }),
    ).rejects.toThrow(/against an inquiry or a quotation/);
  }, 60_000);
});
