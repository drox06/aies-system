import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createInquiryService } from "@/server/core/crm/inquiry-service";
import { getPipelineService } from "@/server/core/crm/pipeline-service";

/**
 * What figure a pipeline card shows for money, and where it comes from.
 *
 * The company found this: a card that had reached "Received PO" was still showing the 10,000
 * somebody guessed when the phone rang. `estimatedValue` is exactly that guess, typed before
 * anything had been costed, and it should stop being the answer the moment a better one exists.
 *
 * So the card reports the **best-known** figure and names which it is: a purchase order beats a
 * quotation, a quotation beats the estimate. Saying which matters as much as the number — the
 * difference between "we think" and "they have ordered" is most of what a pipeline is for.
 */

const suffix = randomUUID().slice(0, 8);
const ME = `pv-${suffix}`;
const actor = { actorId: ME, actorLabel: "Me Test" };

const accountIds: string[] = [];
const inquiryIds: string[] = [];
const quotationIds: string[] = [];
const poIds: string[] = [];
const fileIds: string[] = [];

const scoped = { id: ME, permissions: new Set<string>() };

async function makeAccount() {
  const account = await db.customerAccount.create({
    data: { code: `PV-${randomUUID().slice(0, 12)}`, name: `Value Co ${suffix}`, ownerId: ME },
  });
  accountIds.push(account.id);
  return account;
}

/** An inquiry carrying the intake guess, which is all a fresh one ever has. */
async function makeInquiry(accountId: string, estimatedValue: string) {
  const inquiry = await createInquiryService(actor, {
    subject: `Test sale ${randomUUID().slice(0, 6)}`,
    accountId,
    estimatedValue,
    ownerId: ME,
  });
  inquiryIds.push(inquiry.id);
  return inquiry;
}

async function addQuotation(accountId: string, inquiryId: string, total: string, status: string) {
  const quotation = await db.quotation.create({
    data: {
      number: `AIESLQ-PV-${randomUUID().slice(0, 8)}`,
      accountId,
      inquiryId,
      title: "Quoted work",
      scopeOfWork: "As discussed",
      status,
      total,
      validUntil: new Date(Date.now() + 30 * 86_400_000),
      preparedById: ME,
    },
  });
  quotationIds.push(quotation.id);
  return quotation;
}

async function addCustomerPo(accountId: string, inquiryId: string, amount: string) {
  const file = await db.fileObject.create({
    data: {
      entityType: "CustomerPO",
      entityId: inquiryId,
      storageKey: `CustomerPO/${randomUUID()}-po.pdf`,
      filename: "po.pdf",
      mimeType: "application/pdf",
      size: 10,
      sha256: randomUUID().replace(/-/g, ""),
      uploaderId: ME,
    },
  });
  fileIds.push(file.id);

  const po = await db.customerPO.create({
    data: {
      accountId,
      inquiryId,
      poNumber: `PO-${randomUUID().slice(0, 8)}`,
      poDate: new Date(),
      amount,
      fileId: file.id,
      receivedById: ME,
    },
  });
  poIds.push(po.id);
  return po;
}

async function cardFor(inquiryId: string) {
  const board = await getPipelineService(scoped);
  return board.cards.find((card) => card.id === inquiryId);
}

afterAll(async () => {
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...inquiryIds, ...accountIds, ...quotationIds] } },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: ME } });
  await db.searchIndex.deleteMany({
    where: { entityId: { in: [...inquiryIds, ...quotationIds] } },
  });
  await db.customerPO.deleteMany({ where: { id: { in: poIds } } });
  await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.inquiryItem.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await db.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("the figure on a pipeline card", () => {
  it("is the intake estimate while that is all anybody has", async () => {
    const account = await makeAccount();
    const inquiry = await makeInquiry(account.id, "10000");

    const card = await cardFor(inquiry.id);
    expect(card!.value.amount).toBe("10000");
    expect(card!.value.basis).toBe("estimate");
  }, 60_000);

  it("becomes the quoted total once a quotation goes out", async () => {
    const account = await makeAccount();
    const inquiry = await makeInquiry(account.id, "10000");
    await addQuotation(account.id, inquiry.id, "48500.00", "sent");

    const card = await cardFor(inquiry.id);
    expect(card!.value.amount).toBe("48500");
    expect(card!.value.basis).toBe("quoted");
  }, 60_000);

  it("keeps showing the quoted total after the customer accepts", async () => {
    // The gap the company hit: `accepted` is set the moment a PO is recorded, and the old query
    // only looked at `sent`/`under_negotiation` — so the card fell back to the intake guess at
    // exactly the point it knew most.
    const account = await makeAccount();
    const inquiry = await makeInquiry(account.id, "10000");
    await addQuotation(account.id, inquiry.id, "48500.00", "accepted");

    const card = await cardFor(inquiry.id);
    expect(card!.value.basis).toBe("quoted");
    expect(card!.value.amount).toBe("48500");
  }, 60_000);

  it("becomes the purchase order amount once one arrives", async () => {
    const account = await makeAccount();
    const inquiry = await makeInquiry(account.id, "10000");
    await addQuotation(account.id, inquiry.id, "48500.00", "accepted");
    // Customers order a different number from the one quoted all the time — a line dropped, a
    // quantity changed. What they actually ordered is the truth from here on.
    await addCustomerPo(account.id, inquiry.id, "45000.00");

    const card = await cardFor(inquiry.id);
    expect(card!.value.amount).toBe("45000");
    expect(card!.value.basis).toBe("purchase order");
  }, 60_000);

  it("reports nothing rather than zero when there is no estimate at all", async () => {
    const account = await makeAccount();
    const inquiry = await createInquiryService(actor, {
      subject: `No value ${randomUUID().slice(0, 6)}`,
      accountId: account.id,
      ownerId: ME,
    });
    inquiryIds.push(inquiry.id);

    const card = await cardFor(inquiry.id);
    // A card showing "0" reads as a job worth nothing; blank reads as nobody has said yet.
    expect(card!.value.amount).toBeNull();
  }, 60_000);
});
