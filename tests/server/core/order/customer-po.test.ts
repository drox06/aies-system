import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createInquiryService, transitionInquiryService } from "@/server/core/crm/inquiry-service";
import { humanStatus } from "@/server/core/crm/inquiry-lifecycle";
import {
  CUSTOMER_PO_ENTITY_TYPE,
  hasCustomerPo,
  recordCustomerPoService,
} from "@/server/core/order/customer-po-service";
import { acceptQuotationOnCustomerPo } from "@/server/core/quotation/quotation-service";

/**
 * The pipeline's "Sent" and "Received PO" columns, as the company asked for them:
 *
 *   "after the quote is ticked as sent to the customer, can you auto-transfer the sent quoted to
 *    the Sent column, then for this to move to the next column a PO should be uploaded in the Sent
 *    column."
 *
 * Two claims worth testing, and one of them is a gate: a card cannot reach "Received PO" without a
 * customer purchase order **and its scan**. specs/03-order-procurement.md §2 says the same thing —
 * "scanned PO is mandatory" — so the document is the evidence for the status change rather than an
 * attachment to it.
 *
 * Against the real database, because the gate is only real if the row it looks for is really there.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `po-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "PO Test" };

const inquiryIds: string[] = [];
const accountIds: string[] = [];
const fileIds: string[] = [];
const quotationIds: string[] = [];

/** An inquiry walked to `quoted` — where a PO can arrive. */
async function makeQuotedInquiry() {
  const account = await db.customerAccount.create({
    data: {
      code: `PO-${randomUUID().slice(0, 12)}`,
      name: `PO Water District ${suffix}`,
      ownerId: OWNER,
    },
  });
  accountIds.push(account.id);

  // No line items, so no service type, so §4's requirements checklist has nothing to demand. That
  // gate is module 01's own test; this file is about what happens after the quotation goes out.
  const inquiry = await createInquiryService(actor, {
    subject: `PO test ${randomUUID().slice(0, 6)}`,
    accountId: account.id,
    ownerId: OWNER,
  });
  inquiryIds.push(inquiry.id);

  await transitionInquiryService(actor, { inquiryId: inquiry.id, to: "acknowledged" });
  await transitionInquiryService(actor, { inquiryId: inquiry.id, to: "evaluating" });
  await transitionInquiryService(actor, { inquiryId: inquiry.id, to: "quoting" });
  // What `quotation.sent` does — the auto-transfer the company is describing.
  await transitionInquiryService(actor, {
    inquiryId: inquiry.id,
    to: "quoted",
    bySystem: true,
  });

  return { inquiry, account };
}

/** A stored upload, as `POST /api/files` would have produced. */
async function makeUpload(inquiryId: string, filename = "customer-po.pdf") {
  const file = await db.fileObject.create({
    data: {
      entityType: CUSTOMER_PO_ENTITY_TYPE,
      entityId: inquiryId,
      storageKey: `CustomerPO/2026/08/${inquiryId}/${randomUUID()}-${filename}`,
      filename,
      mimeType: "application/pdf",
      size: 12_345,
      sha256: randomUUID().replace(/-/g, ""),
      uploaderId: OWNER,
    },
  });
  fileIds.push(file.id);
  return file;
}

afterAll(async () => {
  await db.customerPO.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: [...inquiryIds, ...accountIds] } } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: inquiryIds } } });
  await db.eventOutbox.deleteMany({ where: { actorId: OWNER } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.inquiryItem.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await db.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("the columns are labelled the way the company says them", () => {
  it("calls `quoted` Sent and `po_received` Received PO", () => {
    // The stored keys stay §3's, because every audit row and report already contains them. Only the
    // label moves — "Quoted" next to a column called "Quoting" reads as *we wrote a quotation*,
    // which is what the previous column already means.
    expect(humanStatus("quoted")).toBe("Sent");
    expect(humanStatus("po_received")).toBe("Received PO");
    // Everything else still falls through to the plain reading.
    expect(humanStatus("inspection_required")).toBe("inspection required");
  });
});

describe("a card cannot leave Sent without the customer's PO", () => {
  it("refuses the transition outright when nothing has been recorded", async () => {
    const { inquiry } = await makeQuotedInquiry();

    await expect(
      transitionInquiryService(actor, { inquiryId: inquiry.id, to: "po_received" }),
    ).rejects.toThrow(/purchase order recorded first/);

    const stored = await db.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } });
    expect(stored.status).toBe("quoted");
  }, 60_000);

  it("moves it once a PO with its scan is recorded", async () => {
    const { inquiry } = await makeQuotedInquiry();
    const file = await makeUpload(inquiry.id);

    const result = await recordCustomerPoService(actor, {
      inquiryId: inquiry.id,
      poNumber: "PO-2026-0142",
      poDate: new Date("2026-08-11"),
      amount: "1250000.00",
      fileId: file.id,
    });

    expect(result.status).toBe("po_received");
    const stored = await db.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } });
    expect(stored.status).toBe("po_received");

    const po = await db.customerPO.findFirstOrThrow({ where: { inquiryId: inquiry.id } });
    expect(po.poNumber).toBe("PO-2026-0142");
    expect(po.fileId).toBe(file.id);
    expect(po.amount.toString()).toBe("1250000");
    expect(po.status).toBe("received");
  }, 60_000);

  it("refuses a file that was uploaded against something else", async () => {
    // An id in a request body proves nothing. Without this check a caller could point at any
    // upload in the system and satisfy a gate whose whole purpose is the document.
    const { inquiry } = await makeQuotedInquiry();
    const other = await makeQuotedInquiry();
    const strayFile = await makeUpload(other.inquiry.id);

    await expect(
      recordCustomerPoService(actor, {
        inquiryId: inquiry.id,
        poNumber: "PO-2026-0143",
        poDate: new Date("2026-08-11"),
        amount: "1000.00",
        fileId: strayFile.id,
      }),
      // "record" rather than "inquiry": a PO can now be recorded against a quotation that has no
      // inquiry behind it, so the message names whichever record the upload should have belonged to.
    ).rejects.toThrow(/not uploaded as this record's purchase order/);

    expect(await hasCustomerPo(inquiry.id)).toBe(false);
  }, 60_000);

  it("refuses a file id that points at nothing", async () => {
    const { inquiry } = await makeQuotedInquiry();

    await expect(
      recordCustomerPoService(actor, {
        inquiryId: inquiry.id,
        poNumber: "PO-2026-0144",
        poDate: new Date("2026-08-11"),
        amount: "1000.00",
        fileId: "clx0000000000000000000000",
      }),
    ).rejects.toThrow(/no longer there/);
  }, 60_000);

  it("refuses an amount that is not a plain number", async () => {
    const { inquiry } = await makeQuotedInquiry();
    const file = await makeUpload(inquiry.id);

    await expect(
      recordCustomerPoService(actor, {
        inquiryId: inquiry.id,
        poNumber: "PO-2026-0145",
        poDate: new Date("2026-08-11"),
        amount: "PHP 1,250,000",
        fileId: file.id,
      }),
    ).rejects.toThrow(/plain number/);
  }, 60_000);

  it("will not record a PO against an inquiry that has not been quoted yet", async () => {
    const account = await db.customerAccount.create({
      data: { code: `PE-${randomUUID().slice(0, 12)}`, name: `Early ${suffix}`, ownerId: OWNER },
    });
    accountIds.push(account.id);
    const inquiry = await createInquiryService(actor, {
      subject: `Too early ${randomUUID().slice(0, 6)}`,
      accountId: account.id,
      ownerId: OWNER,
    });
    inquiryIds.push(inquiry.id);
    const file = await makeUpload(inquiry.id);

    await expect(
      recordCustomerPoService(actor, {
        inquiryId: inquiry.id,
        poNumber: "PO-2026-0146",
        poDate: new Date("2026-08-11"),
        amount: "1000.00",
        fileId: file.id,
      }),
    ).rejects.toThrow(/quotation has been sent/);
  }, 60_000);

  it("records who received it, in the feed on the card people are looking at", async () => {
    const { inquiry } = await makeQuotedInquiry();
    const file = await makeUpload(inquiry.id, "maynilad-po.pdf");

    await recordCustomerPoService(actor, {
      inquiryId: inquiry.id,
      poNumber: "PO-2026-0147",
      poDate: new Date("2026-08-11"),
      amount: "500000.00",
      fileId: file.id,
    });

    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: inquiry.id, action: "customer_po_received" },
    });
    expect(audit.actorId).toBe(OWNER);
    expect(audit.summary).toContain("PO-2026-0147");
    expect(audit.summary).toContain("maynilad-po.pdf");
  }, 60_000);

  it("emits customer_po.received, which is what module 02 subscribes to", async () => {
    const { inquiry } = await makeQuotedInquiry();
    const file = await makeUpload(inquiry.id);

    await recordCustomerPoService(actor, {
      inquiryId: inquiry.id,
      poNumber: "PO-2026-0148",
      poDate: new Date("2026-08-11"),
      amount: "750000.00",
      fileId: file.id,
    });

    const event = await db.eventOutbox.findFirst({
      where: { event: "customer_po.received", actorId: OWNER },
      orderBy: { createdAt: "desc" },
    });
    expect(event).not.toBeNull();
    expect(JSON.stringify(event!.payload)).toContain("PO-2026-0148");
  }, 60_000);
});

describe("the quotation stops being a live offer", () => {
  it("is marked accepted, so the nightly sweep cannot expire a won deal", async () => {
    // specs/02-quotation.md §10: "`customer_po.received` (module 03 → sets `accepted`)". The
    // practical consequence is the reason to wire it now rather than later — left `sent`, §7's
    // auto-expire would tell the owner a deal they had won had lapsed.
    const { account } = await makeQuotedInquiry();
    const quotation = await db.quotation.create({
      data: {
        number: `AIESLQ26${randomUUID().slice(0, 4)}`,
        accountId: account.id,
        title: "Supply of flow meters",
        scopeOfWork: "Supply and install.",
        status: "sent",
        validUntil: new Date(Date.now() + 30 * 86_400_000),
        preparedById: OWNER,
      },
    });
    quotationIds.push(quotation.id);

    await acceptQuotationOnCustomerPo(quotation.id);

    const stored = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(stored.status).toBe("accepted");
    expect(stored.decisionAt).toBeTruthy();
  }, 60_000);

  it("leaves a quotation that is not live alone, rather than throwing", async () => {
    // A PO can arrive against a revision that was superseded. The PO is recorded either way, and
    // throwing here would dead-letter a job whose real work is done.
    const { account } = await makeQuotedInquiry();
    const quotation = await db.quotation.create({
      data: {
        number: `AIESLQ26${randomUUID().slice(0, 4)}`,
        accountId: account.id,
        title: "Superseded revision",
        scopeOfWork: "Supply.",
        status: "superseded",
        validUntil: new Date(Date.now() + 30 * 86_400_000),
        preparedById: OWNER,
      },
    });
    quotationIds.push(quotation.id);

    await expect(acceptQuotationOnCustomerPo(quotation.id)).resolves.toBeUndefined();
    const stored = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(stored.status).toBe("superseded");
  }, 60_000);
});
