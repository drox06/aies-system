import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  isRestrictedForRenewal,
  RENEWAL_NOTIFICATION_TYPE,
  RENEWAL_THRESHOLD_DAYS,
  acknowledgeRenewalService,
  completesRenewal,
  sweepAccreditationRenewals,
  sweepStalledRenewals,
} from "@/server/core/crm/accreditation-renewal";
import { getNotificationType } from "@/server/core/notify/registry";

/**
 * The company's rules, in their words:
 *   "30 days before this expires, notification is sent to PD to prepare for renewal of
 *    accreditation to said client. if client is blocked or dormant, renewal is to be approved by
 *    EA prior to commencement"
 *
 * Both are tested against the real database, because both hinge on things a mock would fake away:
 * the day arithmetic, and whether module 00's approvals engine actually resolves a conditional step.
 */

const DAY_MS = 86_400_000;
const suffix = randomUUID().slice(0, 8);
const PD = `pd-${suffix}`;
const actor = { actorId: PD, actorLabel: "PD Test" };

const accountIds: string[] = [];
const accreditationIds: string[] = [];
// Escalation notifications go to the real seeded leadership accounts, so they are cleaned up by
// entity id rather than by recipient.
const escalationNotificationIds: string[] = [];

async function makeAccreditation(opts: {
  accountStatus?: string;
  daysUntilExpiry?: number | null;
  status?: string;
}) {
  const account = await db.customerAccount.create({
    data: {
      code: `TST-${randomUUID().slice(0, 12)}`,
      name: `Renewal Test ${randomUUID().slice(0, 6)}`,
      ownerId: PD,
      status: opts.accountStatus ?? "active",
    },
  });
  accountIds.push(account.id);

  const record = await db.accreditationRecord.create({
    data: {
      accountId: account.id,
      status: opts.status ?? "accredited",
      ownerId: PD,
      certificateFileId: "file_cert",
      expiresAt:
        opts.daysUntilExpiry === null || opts.daysUntilExpiry === undefined
          ? null
          : new Date(Date.now() + opts.daysUntilExpiry * DAY_MS),
    },
  });
  accreditationIds.push(record.id);
  return { account, record };
}

beforeEach(async () => {
  // Each test asserts on notifications it caused, so start from none. A previous run that died
  // mid-way would otherwise make the counts look wrong.
  await db.notification.deleteMany({ where: { recipientId: PD } });
});

afterEach(async () => {
  await db.notification.deleteMany({ where: { recipientId: PD } });
  if (escalationNotificationIds.length > 0) {
    await db.notification.deleteMany({ where: { entityId: { in: escalationNotificationIds } } });
    escalationNotificationIds.length = 0;
  }
  await db.approvalAction.deleteMany({
    where: { request: { entityId: { in: accreditationIds } } },
  });
  await db.approvalRequest.deleteMany({ where: { entityId: { in: accreditationIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: accreditationIds } } });
  await db.accreditationRecord.deleteMany({ where: { id: { in: accreditationIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  accreditationIds.length = 0;
  accountIds.length = 0;
});

describe("isRestrictedForRenewal", () => {
  it("treats blacklisted and dormant as needing approval, active as routine", () => {
    expect(isRestrictedForRenewal("blacklisted")).toBe(true);
    expect(isRestrictedForRenewal("dormant")).toBe(true);
    expect(isRestrictedForRenewal("active")).toBe(false);
  });
});

describe("sweepAccreditationRenewals", () => {
  it("notifies PD exactly 30 days out — the company's stated trigger", async () => {
    const { record } = await makeAccreditation({ daysUntilExpiry: 30 });

    const result = await sweepAccreditationRenewals();

    expect(result.notified.some((n) => n.accreditationId === record.id)).toBe(true);
    const sent = await db.notification.findMany({
      where: { recipientId: PD, type: RENEWAL_NOTIFICATION_TYPE, entityId: record.id },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.title).toContain("Prepare renewal");
    expect(sent[0]?.title).toContain("30 days");
  }, 40_000);

  it("does not notify on a day between thresholds", async () => {
    // 45 days out is inside the 90-day window but is not itself a threshold. Firing every day is
    // how a notification becomes noise people filter.
    const { record } = await makeAccreditation({ daysUntilExpiry: 45 });
    const result = await sweepAccreditationRenewals();
    expect(result.notified.some((n) => n.accreditationId === record.id)).toBe(false);
  }, 40_000);

  it("fires at each threshold in the ladder", async () => {
    for (const days of RENEWAL_THRESHOLD_DAYS) {
      const { record } = await makeAccreditation({ daysUntilExpiry: days });
      const result = await sweepAccreditationRenewals();
      expect(
        result.notified.some((n) => n.accreditationId === record.id),
        `expected a notification at ${days} days`,
      ).toBe(true);
    }
  }, 60_000);

  it("tells PD about the approval dependency when the account is blacklisted", async () => {
    // Learning at reminder time that EA has to approve is the difference between a 30-day runway
    // and a 30-day runway minus however long an approval takes.
    const { record } = await makeAccreditation({
      daysUntilExpiry: 30,
      accountStatus: "blacklisted",
    });

    await sweepAccreditationRenewals();

    const sent = await db.notification.findFirst({
      where: { recipientId: PD, entityId: record.id },
    });
    expect(sent?.body).toContain("president must approve");
  }, 40_000);

  it("ignores records with no expiry date, rather than throwing", async () => {
    await makeAccreditation({ daysUntilExpiry: null });
    await expect(sweepAccreditationRenewals()).resolves.toBeDefined();
  }, 40_000);

  it("does not chase a rejected accreditation", async () => {
    // Rejected is a decision, not an oversight; a reminder to renew it is not actionable.
    const { record } = await makeAccreditation({ daysUntilExpiry: 30, status: "rejected" });
    const result = await sweepAccreditationRenewals();
    expect(result.notified.some((n) => n.accreditationId === record.id)).toBe(false);
  }, 40_000);
});

describe("acknowledgeRenewalService", () => {
  it("commences immediately for an active customer", async () => {
    const { record } = await makeAccreditation({ daysUntilExpiry: 30, accountStatus: "active" });

    const result = await acknowledgeRenewalService(actor, { accreditationId: record.id });

    expect(result.acknowledged).toBe(true);
    expect(result.approvalRequestId).toBeUndefined();
    const after = await db.accreditationRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(after.status).toBe("preparing");
  }, 40_000);

  it("blocks commencement and raises an approval when the customer is blacklisted", async () => {
    const { record } = await makeAccreditation({
      daysUntilExpiry: 30,
      accountStatus: "blacklisted",
    });

    const result = await acknowledgeRenewalService(actor, { accreditationId: record.id });

    expect(result.acknowledged).toBe(false);
    expect(result.approvalRequestId).toBeDefined();
    // Crucially the record has NOT moved — "prior to commencement" means the work does not start.
    const after = await db.accreditationRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(after.status).toBe("accredited");

    const request = await db.approvalRequest.findUniqueOrThrow({
      where: { id: result.approvalRequestId! },
    });
    expect(request.status).toBe("pending");
  }, 40_000);

  it("also requires approval when the customer is dormant", async () => {
    const { record } = await makeAccreditation({ daysUntilExpiry: 30, accountStatus: "dormant" });
    const result = await acknowledgeRenewalService(actor, { accreditationId: record.id });
    expect(result.acknowledged).toBe(false);
  }, 40_000);

  it("records the account status in the approval snapshot, so EA sees why they were asked", async () => {
    const { record } = await makeAccreditation({
      daysUntilExpiry: 30,
      accountStatus: "blacklisted",
    });
    const result = await acknowledgeRenewalService(actor, { accreditationId: record.id });
    const request = await db.approvalRequest.findUniqueOrThrow({
      where: { id: result.approvalRequestId! },
    });
    const snapshot = request.entitySnapshot as Record<string, unknown>;
    expect(snapshot.accountStatus).toBe("blacklisted");
    // The numeric mirror the engine's condition actually tests.
    expect(snapshot.accountRestricted).toBe(1);
  }, 40_000);

  it("writes an audit row either way, naming the reason when approval is needed", async () => {
    const { record } = await makeAccreditation({
      daysUntilExpiry: 30,
      accountStatus: "blacklisted",
    });
    await acknowledgeRenewalService(actor, { accreditationId: record.id });

    const rows = await db.auditLog.findMany({ where: { entityId: record.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("renewal_approval_requested");
    expect(rows[0]?.summary).toContain("blacklisted");
  }, 40_000);
});

describe("renewal notification channels", () => {
  it("is in-app only — the renewal is done on the customer's portal, not from here", () => {
    // Pinned deliberately. Turning email on would enqueue a notify_email job per reminder onto a
    // queue with no handler (docs/DECISIONS.md #10), so each one dead-letters: the dead-letter
    // queue fills with work nobody wants, and the failures that do matter get buried in it.
    const def = getNotificationType(RENEWAL_NOTIFICATION_TYPE);
    expect(def, "the type must be registered").toBeDefined();
    expect(def?.defaultChannels.inApp).toBe(true);
    expect(def?.defaultChannels.email).toBe(false);
    expect(def?.defaultChannels.digest).toBe(false);
  });

  it("writes no email job when the sweep notifies", async () => {
    const { record } = await makeAccreditation({ daysUntilExpiry: 30 });
    const before = await db.job.count({ where: { queue: "notify_email" } });

    await sweepAccreditationRenewals();

    const after = await db.job.count({ where: { queue: "notify_email" } });
    expect(after).toBe(before);
    // ...and the in-app notification did land, so this is not passing by doing nothing at all.
    const sent = await db.notification.count({ where: { recipientId: PD, entityId: record.id } });
    expect(sent).toBe(1);
  }, 40_000);
});

describe("completesRenewal", () => {
  const ack = new Date("2026-06-01T00:00:00.000Z");
  const now = new Date("2026-07-01T00:00:00.000Z");

  it("is not complete just because an old certificate is still attached", () => {
    // The certificate from the *previous* cycle is still on the record the moment PD acknowledges.
    // Treating its presence as completion would mark every renewal done the instant it started.
    expect(
      completesRenewal(
        {
          renewalAcknowledgedAt: ack,
          certificateUploadedAt: new Date("2025-01-01T00:00:00.000Z"),
          expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        },
        now,
      ),
    ).toBe(false);
  });

  it("is complete once a new certificate is uploaded after the acknowledgement", () => {
    expect(
      completesRenewal(
        {
          renewalAcknowledgedAt: ack,
          certificateUploadedAt: new Date("2026-06-20T00:00:00.000Z"),
          expiresAt: new Date("2027-06-01T00:00:00.000Z"),
        },
        now,
      ),
    ).toBe(true);
  });

  it("is not complete if the new expiry is already in the past", () => {
    expect(
      completesRenewal(
        {
          renewalAcknowledgedAt: ack,
          certificateUploadedAt: new Date("2026-06-20T00:00:00.000Z"),
          expiresAt: new Date("2026-06-25T00:00:00.000Z"),
        },
        now,
      ),
    ).toBe(false);
  });

  it("is not applicable when nothing was acknowledged", () => {
    expect(
      completesRenewal(
        { renewalAcknowledgedAt: null, certificateUploadedAt: new Date(), expiresAt: new Date() },
        now,
      ),
    ).toBe(false);
  });
});

describe("sweepStalledRenewals", () => {
  async function acknowledgeDaysAgo(recordId: string, days: number) {
    await db.accreditationRecord.update({
      where: { id: recordId },
      data: {
        renewalAcknowledgedAt: new Date(Date.now() - days * DAY_MS),
        renewalAcknowledgedBy: PD,
      },
    });
  }

  it("escalates to president and vice-president 30 days after acknowledgement", async () => {
    const { record } = await makeAccreditation({ daysUntilExpiry: 10 });
    await acknowledgeDaysAgo(record.id, 30);

    const result = await sweepStalledRenewals();

    expect(result.escalated.some((e) => e.accreditationId === record.id)).toBe(true);

    // Sent to the role-holders, not to PD — the point is that someone above them now knows.
    const leaders = await db.user.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        roles: { some: { role: { key: { in: ["president", "vice_president"] } } } },
      },
      select: { id: true },
    });
    expect(leaders.length).toBeGreaterThan(0);
    const sent = await db.notification.count({
      where: { entityId: record.id, recipientId: { in: leaders.map((l) => l.id) } },
    });
    expect(sent).toBe(leaders.length);
    escalationNotificationIds.push(record.id);
  }, 60_000);

  it("does not escalate between thresholds", async () => {
    const { record } = await makeAccreditation({ daysUntilExpiry: 10 });
    await acknowledgeDaysAgo(record.id, 37);
    const result = await sweepStalledRenewals();
    expect(result.escalated.some((e) => e.accreditationId === record.id)).toBe(false);
  }, 60_000);

  it("escalates again at 45 and 60 days", async () => {
    for (const days of [45, 60]) {
      const { record } = await makeAccreditation({ daysUntilExpiry: 10 });
      await acknowledgeDaysAgo(record.id, days);
      const result = await sweepStalledRenewals();
      expect(
        result.escalated.some((e) => e.accreditationId === record.id),
        `expected an escalation at ${days} days`,
      ).toBe(true);
      escalationNotificationIds.push(record.id);
    }
  }, 90_000);

  it("clears the acknowledgement once the renewal is genuinely completed", async () => {
    const { record } = await makeAccreditation({ daysUntilExpiry: 300 });
    await acknowledgeDaysAgo(record.id, 30);
    // A new certificate arrives after the acknowledgement — the tick is the certificate itself,
    // so nobody has to remember to mark the task done.
    await db.accreditationRecord.update({
      where: { id: record.id },
      data: { certificateUploadedAt: new Date() },
    });

    const result = await sweepStalledRenewals();

    expect(result.cleared).toContain(record.id);
    expect(result.escalated.some((e) => e.accreditationId === record.id)).toBe(false);
    const after = await db.accreditationRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(after.renewalAcknowledgedAt).toBeNull();
  }, 60_000);

  it("ignores records nobody has acknowledged", async () => {
    const { record } = await makeAccreditation({ daysUntilExpiry: 10 });
    const result = await sweepStalledRenewals();
    expect(result.escalated.some((e) => e.accreditationId === record.id)).toBe(false);
    expect(result.cleared).not.toContain(record.id);
  }, 60_000);
});
