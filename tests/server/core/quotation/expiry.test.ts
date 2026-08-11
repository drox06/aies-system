import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  EXPIRY_WARNING_DAYS,
  sweepQuotationExpiries,
} from "@/server/core/quotation/expiry-service";
import { createQuotationService } from "@/server/core/quotation/quotation-service";

/**
 * specs/02-quotation.md §7: "a job flips `sent` quotes past `validUntil` to `expired` and notifies
 * the owner seven days before."
 *
 * Against the real database, because the interesting part is the query: which rows the sweep
 * *selects*. A test with a fake repository would assert that the code I wrote does what I wrote,
 * and would not have caught an off-by-one on the warning day or a status filter that quietly
 * expired a live negotiation.
 */

const suffix = randomUUID().slice(0, 8);
const DAY_MS = 86_400_000;

const accountIds: string[] = [];
const quotationIds: string[] = [];
const userIds: string[] = [];

async function makeOwner() {
  const user = await db.user.create({
    data: {
      email: `expiry-${randomUUID().slice(0, 8)}@test.local`,
      name: `Expiry Owner ${randomUUID().slice(0, 4)}`,
      passwordHash: "x",
      isActive: true,
    },
  });
  userIds.push(user.id);
  return user;
}

async function makeQuotation(ownerId: string, options: { status: string; validUntil: Date }) {
  const account = await db.customerAccount.create({
    data: {
      code: `EX-${randomUUID().slice(0, 12)}`,
      name: `Expiry Water District ${suffix}`,
      ownerId,
    },
  });
  accountIds.push(account.id);

  const quotation = await createQuotationService(
    { actorId: ownerId, actorLabel: "Expiry Test" },
    { accountId: account.id, title: "Supply of a level transmitter" },
  );
  quotationIds.push(quotation.id);

  await db.quotation.update({
    where: { id: quotation.id },
    data: { status: options.status, validUntil: options.validUntil },
  });
  return quotation;
}

afterAll(async () => {
  await db.notification.deleteMany({ where: { entityId: { in: quotationIds } } });
  await db.notification.deleteMany({ where: { recipientId: { in: userIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: [...quotationIds, ...accountIds] } } });
  await db.eventOutbox.deleteMany({ where: { actorId: { in: userIds } } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("expiring a lapsed quotation", () => {
  it("flips a sent quotation past its validity, and says so in the audit trail", async () => {
    const owner = await makeOwner();
    const quotation = await makeQuotation(owner.id, {
      status: "sent",
      validUntil: new Date(Date.now() - 2 * DAY_MS),
    });

    const result = await sweepQuotationExpiries();
    expect(result.expired.map((row) => row.quotationId)).toContain(quotation.id);

    const stored = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(stored.status).toBe("expired");

    // Nobody did this, and the audit row should say so rather than blaming whoever ran the cron.
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: quotation.id, action: "expired" },
    });
    expect(audit.actorId).toBeNull();
    expect(audit.actorLabel).toBe("System");

    // §10's event, for anything downstream that wants to react.
    const event = await db.eventOutbox.findFirst({
      where: { event: "quotation.expired" },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.stringify(event?.payload)).toContain(quotation.id);
  }, 60_000);

  it("leaves a quotation that is still inside its validity alone", async () => {
    const owner = await makeOwner();
    const quotation = await makeQuotation(owner.id, {
      status: "sent",
      validUntil: new Date(Date.now() + 3 * DAY_MS),
    });

    await sweepQuotationExpiries();

    const stored = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(stored.status).toBe("sent");
  }, 60_000);

  it("does not expire a live negotiation", async () => {
    // §7 names `sent`, and that is taken literally. Flipping a quotation to `expired` underneath
    // two people who are mid-conversation would show the pipeline a deal as lost that nobody lost.
    const owner = await makeOwner();
    const quotation = await makeQuotation(owner.id, {
      status: "under_negotiation",
      validUntil: new Date(Date.now() - 2 * DAY_MS),
    });

    await sweepQuotationExpiries();

    const stored = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(stored.status).toBe("under_negotiation");
  }, 60_000);

  it("is safe to run twice — the second pass finds nothing to do", async () => {
    const owner = await makeOwner();
    const quotation = await makeQuotation(owner.id, {
      status: "sent",
      validUntil: new Date(Date.now() - DAY_MS),
    });

    await sweepQuotationExpiries();
    const second = await sweepQuotationExpiries();

    expect(second.expired.map((row) => row.quotationId)).not.toContain(quotation.id);
    const audits = await db.auditLog.count({
      where: { entityId: quotation.id, action: "expired" },
    });
    expect(audits).toBe(1);
  }, 60_000);

  it("does not touch a draft or an approved quotation whose date has passed", async () => {
    // A draft with a stale validity date is a normal thing — somebody started it a month ago. It
    // was never issued, so there is nothing to expire.
    const owner = await makeOwner();
    const draft = await makeQuotation(owner.id, {
      status: "draft",
      validUntil: new Date(Date.now() - 10 * DAY_MS),
    });
    const approved = await makeQuotation(owner.id, {
      status: "approved",
      validUntil: new Date(Date.now() - 10 * DAY_MS),
    });

    await sweepQuotationExpiries();

    expect((await db.quotation.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe(
      "draft",
    );
    expect((await db.quotation.findUniqueOrThrow({ where: { id: approved.id } })).status).toBe(
      "approved",
    );
  }, 60_000);
});

describe("the seven-day warning", () => {
  it("warns the owner on the day the threshold is crossed", async () => {
    const owner = await makeOwner();
    // Mid-day, so the sweep's whole-day comparison is not sitting on a boundary.
    const validUntil = new Date(Date.now() + EXPIRY_WARNING_DAYS * DAY_MS);
    validUntil.setUTCHours(12, 0, 0, 0);
    const quotation = await makeQuotation(owner.id, { status: "sent", validUntil });

    const result = await sweepQuotationExpiries();
    expect(result.warned.map((row) => row.quotationId)).toContain(quotation.id);

    const notifications = await db.notification.findMany({
      where: { recipientId: owner.id },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.title).toContain("expires in 7 days");
    // Still live — the warning is a warning, not an early expiry.
    expect((await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } })).status).toBe(
      "sent",
    );
  }, 60_000);

  it("does not warn on the days either side of it", async () => {
    // Fires on the exact day, like every other sweep here. A reminder that repeats daily for a week
    // is one people learn to dismiss without reading.
    const owner = await makeOwner();
    for (const days of [EXPIRY_WARNING_DAYS - 1, EXPIRY_WARNING_DAYS + 1]) {
      const validUntil = new Date(Date.now() + days * DAY_MS);
      validUntil.setUTCHours(12, 0, 0, 0);
      await makeQuotation(owner.id, { status: "sent", validUntil });
    }

    await sweepQuotationExpiries();

    expect(await db.notification.count({ where: { recipientId: owner.id } })).toBe(0);
  }, 60_000);

  it("warns about a live negotiation, which is the point of not expiring it", async () => {
    // The sweep leaves `under_negotiation` alone, so the warning is the only thing standing between
    // a negotiation and a price that quietly outlives its own validity. §5's `validity_extension`
    // revision reason is the intended fix.
    const owner = await makeOwner();
    const validUntil = new Date(Date.now() + EXPIRY_WARNING_DAYS * DAY_MS);
    validUntil.setUTCHours(12, 0, 0, 0);
    const quotation = await makeQuotation(owner.id, { status: "under_negotiation", validUntil });

    const result = await sweepQuotationExpiries();

    expect(result.warned.map((row) => row.quotationId)).toContain(quotation.id);
  }, 60_000);
});
