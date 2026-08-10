import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createInquiryService, transitionInquiryService } from "@/server/core/crm/inquiry-service";
import { registry } from "@/server/core/manifests";
import { createQuotationService } from "@/server/core/quotation/quotation-service";
import { reviseQuotationService } from "@/server/core/quotation/revision-service";
import {
  confirmQuotationSentService,
  recordQuotationDownloadService,
  sweepUnsentDownloads,
  UNSENT_REMINDER_DAYS,
} from "@/server/core/quotation/send-service";

/**
 * §7's issuance, as AIES actually works it: download the PDF, attach it to an external mail client,
 * then confirm it went.
 *
 * The chain this proves end to end is the one the company asked about — inquiry reaches `quoting`,
 * a quotation is prepared, and confirming it sent moves the inquiry to `quoted` without anybody
 * touching the pipeline.
 */

const DAY_MS = 86_400_000;
const suffix = randomUUID().slice(0, 8);
const OWNER = `send-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "Send Test" };

const accountIds: string[] = [];
const inquiryIds: string[] = [];

async function makeApprovedQuotation(withInquiry = true) {
  const account = await db.customerAccount.create({
    data: { code: `SN-${randomUUID().slice(0, 12)}`, name: `Send Co ${suffix}`, ownerId: OWNER },
  });
  accountIds.push(account.id);

  let inquiryId: string | null = null;
  if (withInquiry) {
    const inquiry = await createInquiryService(actor, {
      subject: `Send test ${randomUUID().slice(0, 6)}`,
      accountId: account.id,
      ownerId: OWNER,
      items: [],
    });
    inquiryIds.push(inquiry.id);
    for (const to of ["acknowledged", "evaluating", "quoting"]) {
      await transitionInquiryService(actor, { inquiryId: inquiry.id, to });
    }
    inquiryId = inquiry.id;
  }

  const quotation = await createQuotationService(actor, {
    accountId: account.id,
    inquiryId,
    title: "Send flow",
  });
  // §6's approval is session 3's own work; this test is about issuance, so it starts from approved.
  await db.quotation.update({ where: { id: quotation.id }, data: { status: "approved" } });
  return { quotation, inquiryId, accountId: account.id };
}

afterAll(async () => {
  const qs = await db.quotation.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true },
  });
  const ids = qs.map((q) => q.id);
  await db.notification.deleteMany({ where: { entityId: { in: ids } } });
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...ids, ...inquiryIds, ...accountIds] } },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: { in: [OWNER, "system"] } } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: inquiryIds } } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: ids } } });
  await db.quotation.deleteMany({ where: { parentQuotationId: { in: ids } } });
  await db.quotation.deleteMany({ where: { id: { in: ids } } });
  await db.inquiryItem.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await db.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("downloading is recorded but changes nothing", () => {
  it("stamps who and when, and leaves the status alone", async () => {
    // A quotation is routinely printed just to check it reads properly. Treating that as issuance
    // would tell the customer's pipeline column something that never happened.
    const { quotation } = await makeApprovedQuotation(false);

    const result = await recordQuotationDownloadService(actor, { quotationId: quotation.id });
    expect(result.downloadCount).toBe(1);

    const stored = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(stored.status).toBe("approved");
    expect(stored.downloadedBy).toBe(OWNER);
    expect(stored.sentAt).toBeNull();
  });

  it("counts repeat downloads rather than replacing them", async () => {
    // Downloaded three times and still not sent is the signal worth having.
    const { quotation } = await makeApprovedQuotation(false);
    for (let i = 0; i < 3; i += 1) {
      await recordQuotationDownloadService(actor, { quotationId: quotation.id });
    }
    const stored = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(stored.downloadCount).toBe(3);
  });

  it("writes a download log entry that the activity feed will show", async () => {
    const { quotation } = await makeApprovedQuotation(false);
    await recordQuotationDownloadService(actor, { quotationId: quotation.id });

    const rows = await db.auditLog.findMany({
      where: { entityType: "Quotation", entityId: quotation.id, action: "downloaded" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorLabel).toBe("Send Test");
    expect(rows[0]!.summary).toContain("ready for sending");
  });

  it("does not treat the internal costing sheet as ready for sending", async () => {
    // §7's internal sheet is a management report; nobody emails it to a customer.
    const { quotation } = await makeApprovedQuotation(false);
    await recordQuotationDownloadService(actor, {
      quotationId: quotation.id,
      variant: "internal",
    });

    const stored = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(stored.downloadCount).toBe(0);
    expect(stored.downloadedAt).toBeNull();
  });
});

describe("confirming it was sent", () => {
  it("refuses when nobody has produced the document", async () => {
    const { quotation } = await makeApprovedQuotation(false);
    await expect(confirmQuotationSentService(actor, { quotationId: quotation.id })).rejects.toThrow(
      /Nobody has downloaded/,
    );
  });

  it("refuses an unapproved quotation, per §6", async () => {
    const { quotation } = await makeApprovedQuotation(false);
    await db.quotation.update({ where: { id: quotation.id }, data: { status: "draft" } });
    await recordQuotationDownloadService(actor, { quotationId: quotation.id });

    await expect(confirmQuotationSentService(actor, { quotationId: quotation.id })).rejects.toThrow(
      /requires approval/,
    );
  });

  it("records the date it actually went, not the date it was ticked", async () => {
    // People send on Friday and confirm on Monday; the customer's clock runs from the former.
    const { quotation } = await makeApprovedQuotation(false);
    await recordQuotationDownloadService(actor, { quotationId: quotation.id });

    const actuallySent = new Date(Date.now() - 3 * DAY_MS);
    await confirmQuotationSentService(actor, {
      quotationId: quotation.id,
      sentAt: actuallySent,
    });

    const stored = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(stored.status).toBe("sent");
    expect(stored.sentAt!.toISOString().slice(0, 10)).toBe(actuallySent.toISOString().slice(0, 10));
    // The confirmation is its own timestamp, so the gap between doing and recording is visible.
    expect(stored.sentConfirmedAt).not.toBeNull();
    expect(stored.sentConfirmedBy).toBe(OWNER);
  });

  it("refuses a send date in the future", async () => {
    const { quotation } = await makeApprovedQuotation(false);
    await recordQuotationDownloadService(actor, { quotationId: quotation.id });
    await expect(
      confirmQuotationSentService(actor, {
        quotationId: quotation.id,
        sentAt: new Date(Date.now() + 10 * DAY_MS),
      }),
    ).rejects.toThrow(/sent in the future/);
  });

  it("supersedes earlier revisions at the moment this one is sent (§5)", async () => {
    const { quotation } = await makeApprovedQuotation(false);
    await recordQuotationDownloadService(actor, { quotationId: quotation.id });
    await confirmQuotationSentService(actor, { quotationId: quotation.id });

    const r1 = await reviseQuotationService(actor, {
      quotationId: quotation.id,
      revisionReason: "price_negotiation",
    });
    // Creating the revision must not retire what the customer is holding.
    let root = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(root.status).toBe("sent");

    await db.quotation.update({ where: { id: r1.quotationId }, data: { status: "approved" } });
    await recordQuotationDownloadService(actor, { quotationId: r1.quotationId });
    const result = await confirmQuotationSentService(actor, { quotationId: r1.quotationId });

    expect(result.supersededCount).toBe(1);
    root = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(root.status).toBe("superseded");
  });

  it("will not confirm the same quotation twice", async () => {
    const { quotation } = await makeApprovedQuotation(false);
    await recordQuotationDownloadService(actor, { quotationId: quotation.id });
    await confirmQuotationSentService(actor, { quotationId: quotation.id });

    await expect(confirmQuotationSentService(actor, { quotationId: quotation.id })).rejects.toThrow(
      /already recorded as sent/,
    );
  });
});

describe("the whole chain: quoting → quoted", () => {
  it("moves the inquiry to quoted when the quotation is confirmed sent", async () => {
    const { quotation, inquiryId } = await makeApprovedQuotation(true);

    const before = await db.inquiry.findUniqueOrThrow({ where: { id: inquiryId! } });
    expect(before.status).toBe("quoting");

    await recordQuotationDownloadService(actor, { quotationId: quotation.id });
    await confirmQuotationSentService(actor, { quotationId: quotation.id });

    // The event carries it. Run the subscriber the way the job handler would, rather than
    // reimplementing the transition here — that would test a copy of the logic, not the wiring.
    const subscribers = registry.eventSubscribers.get("quotation.sent") ?? [];
    expect(subscribers.length).toBeGreaterThan(0);
    for (const subscriber of subscribers) {
      await subscriber.handler(
        { inquiryId, quotationId: quotation.id },
        { event: "quotation.sent", attempt: 1 },
      );
    }

    const after = await db.inquiry.findUniqueOrThrow({ where: { id: inquiryId! } });
    expect(after.status).toBe("quoted");
  });

  it("does not throw when the inquiry has already moved on", async () => {
    // A second revision sent after the inquiry reached `quoted` must not dead-letter a job whose
    // real work is already done.
    const { quotation, inquiryId } = await makeApprovedQuotation(true);
    await db.inquiry.update({ where: { id: inquiryId! }, data: { status: "disqualified" } });

    const subscribers = registry.eventSubscribers.get("quotation.sent") ?? [];
    for (const subscriber of subscribers) {
      await expect(
        subscriber.handler(
          { inquiryId, quotationId: quotation.id },
          { event: "quotation.sent", attempt: 1 },
        ),
      ).resolves.not.toThrow();
    }
  });
});

describe("the sweep that makes a human assertion trustworthy", () => {
  it("chases a download that was never confirmed sent", async () => {
    const { quotation } = await makeApprovedQuotation(false);
    await recordQuotationDownloadService(actor, { quotationId: quotation.id });
    await db.quotation.update({
      where: { id: quotation.id },
      data: { downloadedAt: new Date(Date.now() - UNSENT_REMINDER_DAYS[0] * DAY_MS) },
    });

    const result = await sweepUnsentDownloads();
    expect(result.reminded.map((r) => r.quotationId)).toContain(quotation.id);

    const notifications = await db.notification.findMany({
      where: { entityType: "Quotation", entityId: quotation.id },
    });
    expect(notifications).toHaveLength(1);
    // Chases whoever downloaded it — the more specific signal about who was about to send.
    expect(notifications[0]!.recipientId).toBe(OWNER);
  });

  it("leaves a confirmed quotation alone", async () => {
    const { quotation } = await makeApprovedQuotation(false);
    await recordQuotationDownloadService(actor, { quotationId: quotation.id });
    await confirmQuotationSentService(actor, { quotationId: quotation.id });
    await db.quotation.update({
      where: { id: quotation.id },
      data: { downloadedAt: new Date(Date.now() - UNSENT_REMINDER_DAYS[0] * DAY_MS) },
    });

    const result = await sweepUnsentDownloads();
    expect(result.reminded.map((r) => r.quotationId)).not.toContain(quotation.id);
  });

  it("fires on the threshold day and not the day between", async () => {
    const { quotation } = await makeApprovedQuotation(false);
    await recordQuotationDownloadService(actor, { quotationId: quotation.id });

    // A day that is not a threshold produces nothing — daily repeats are how a reminder becomes
    // background noise.
    const between = UNSENT_REMINDER_DAYS[0] + 1;
    await db.quotation.update({
      where: { id: quotation.id },
      data: { downloadedAt: new Date(Date.now() - between * DAY_MS) },
    });
    const quiet = await sweepUnsentDownloads();
    expect(quiet.reminded.map((r) => r.quotationId)).not.toContain(quotation.id);
  });
});
