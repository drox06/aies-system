import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { logActivityService } from "@/server/core/crm/activity-service";
import { createInquiryService, transitionInquiryService } from "@/server/core/crm/inquiry-service";
import {
  findStaleAccounts,
  getMyDayService,
  getPipelineService,
  sweepFollowUps,
} from "@/server/core/crm/pipeline-service";
import { STALE_ACCOUNT_DAYS } from "@/server/core/crm/pipeline-rules";

/**
 * specs/01-crm-inquiry.md §6's pipeline views.
 *
 * §1 sets the bar these have to clear: "A salesperson's real question is 'who haven't I talked to
 * in 60 days, and what's stuck?'" Both halves are tested against the real database, because both
 * depend on a query being right rather than on a pure function.
 */

const DAY_MS = 86_400_000;
const suffix = randomUUID().slice(0, 8);
const ME = `me-${suffix}`;
const THEM = `them-${suffix}`;
const actor = { actorId: ME, actorLabel: "Me Test" };

const inquiryIds: string[] = [];
const accountIds: string[] = [];

const scoped = (id: string, extra: string[] = []) => ({ id, permissions: new Set(extra) });

async function makeInquiry(options: { ownerId?: string; followUpDaysAgo?: number | null } = {}) {
  const inquiry = await createInquiryService(
    { ...actor, actorId: options.ownerId ?? ME },
    { subject: `Pipeline test ${randomUUID().slice(0, 6)}`, ownerId: options.ownerId ?? ME },
  );
  inquiryIds.push(inquiry.id);

  if (options.followUpDaysAgo !== undefined && options.followUpDaysAgo !== null) {
    await db.inquiry.update({
      where: { id: inquiry.id },
      data: { nextFollowUpAt: new Date(Date.now() - options.followUpDaysAgo * DAY_MS) },
    });
  }
  return inquiry;
}

async function makeAccount(options: { createdDaysAgo: number; contactDaysAgo?: number }) {
  const account = await db.customerAccount.create({
    data: {
      code: `PIP-${randomUUID().slice(0, 12)}`,
      name: `Pipeline Co ${randomUUID().slice(0, 6)}`,
      ownerId: ME,
      status: "active",
      createdAt: new Date(Date.now() - options.createdDaysAgo * DAY_MS),
    },
  });
  accountIds.push(account.id);

  if (options.contactDaysAgo !== undefined) {
    await logActivityService(actor, {
      entityType: "CustomerAccount",
      entityId: account.id,
      type: "call",
      subject: "Check-in",
      occurredAt: new Date(Date.now() - options.contactDaysAgo * DAY_MS),
    });
  }
  return account;
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityId: { in: [...inquiryIds, ...accountIds] } } });
  await db.notification.deleteMany({ where: { recipientId: { in: [ME, THEM] } } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: inquiryIds } } });
  await db.eventOutbox.deleteMany({ where: { actorId: { in: [ME, THEM] } } });
  await db.activity.deleteMany({ where: { entityId: { in: accountIds } } });
  await db.inquiryItem.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await db.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("getPipelineService", () => {
  it("shows live inquiries and drops the terminal ones off the board", async () => {
    const live = await makeInquiry();
    const dead = await makeInquiry();
    for (const to of ["acknowledged", "evaluating", "disqualified"]) {
      await transitionInquiryService(actor, { inquiryId: dead.id, to });
    }

    const board = await getPipelineService(scoped(ME));
    const ids = board.cards.map((card) => card.id);
    expect(ids).toContain(live.id);
    // Won, lost and disqualified are history. A column of them grows forever and tells a
    // salesperson nothing about what to do next.
    expect(ids).not.toContain(dead.id);
  });

  it("carries the card fields §6 asks for", async () => {
    const inquiry = await makeInquiry();
    const board = await getPipelineService(scoped(ME));
    const card = board.cards.find((c) => c.id === inquiry.id);

    // §6: "card shows account, value, owner, age, and a red flag if the SLA is breached."
    expect(card).toBeDefined();
    expect(card).toHaveProperty("ownerLabel");
    expect(card).toHaveProperty("ageDays");
    expect(card!.sla).toHaveProperty("breached");
  });

  it("respects record scoping", async () => {
    const theirs = await makeInquiry({ ownerId: THEM });
    const mine = await getPipelineService(scoped(ME));
    expect(mine.cards.map((c) => c.id)).not.toContain(theirs.id);

    const everything = await getPipelineService(scoped(ME, ["crm.view_all"]));
    expect(everything.cards.map((c) => c.id)).toContain(theirs.id);
  });
});

describe("getMyDayService", () => {
  it("lists an overdue follow-up but not a future one", async () => {
    const overdue = await makeInquiry({ followUpDaysAgo: 3 });
    const future = await makeInquiry({ followUpDaysAgo: -7 });

    const myDay = await getMyDayService({ id: ME });
    const ids = myDay.overdueFollowUps.map((row) => row.id);
    expect(ids).toContain(overdue.id);
    expect(ids).not.toContain(future.id);
  });

  it("puts an inquiry with no next step in its own list", async () => {
    // §6: "Nothing is allowed to sit with no next step."
    const drifting = await makeInquiry();
    const myDay = await getMyDayService({ id: ME });
    expect(myDay.needsNextStep.map((row) => row.id)).toContain(drifting.id);
  });

  it("is always the caller's own work, even with crm.view_all", async () => {
    // A president with global visibility opening My Day wants their own list, not all five people's.
    const theirs = await makeInquiry({ ownerId: THEM, followUpDaysAgo: 5 });
    const myDay = await getMyDayService({ id: ME });
    expect(myDay.overdueFollowUps.map((row) => row.id)).not.toContain(theirs.id);
  });
});

describe("findStaleAccounts", () => {
  it("counts logged contact, not record edits", async () => {
    // The distinction §6 turns on: editing a customer's address is not talking to them, and a CRM
    // that counts it as contact reports everything fine until the customer goes elsewhere.
    const recent = await makeAccount({
      createdDaysAgo: STALE_ACCOUNT_DAYS + 30,
      contactDaysAgo: 5,
    });
    const stale = await makeAccount({
      createdDaysAgo: STALE_ACCOUNT_DAYS + 30,
      contactDaysAgo: STALE_ACCOUNT_DAYS + 10,
    });

    // Touching the record must not rescue it from the list.
    await db.customerAccount.update({
      where: { id: stale.id },
      data: { industry: "Water utility" },
    });

    const rows = await findStaleAccounts(ME);
    const ids = rows.map((row) => row.id);
    expect(ids).toContain(stale.id);
    expect(ids).not.toContain(recent.id);
  });

  it("includes an account nobody has ever logged contact against", async () => {
    // Otherwise the accounts nobody has called would be the only ones never mentioned.
    const never = await makeAccount({ createdDaysAgo: STALE_ACCOUNT_DAYS + 5 });
    const rows = await findStaleAccounts(ME);
    const row = rows.find((r) => r.id === never.id);
    expect(row).toBeDefined();
    expect(row!.lastContactAt).toBeNull();
  });

  it("leaves a brand-new account alone", async () => {
    const fresh = await makeAccount({ createdDaysAgo: 2 });
    const rows = await findStaleAccounts(ME);
    expect(rows.map((r) => r.id)).not.toContain(fresh.id);
  });
});

describe("sweepFollowUps", () => {
  it("sends one notification per owner, not one per inquiry", async () => {
    // A person with eleven overdue follow-ups needs one prompt to open My Day, not eleven badges.
    await makeInquiry({ followUpDaysAgo: 2 });
    await makeInquiry({ followUpDaysAgo: 4 });
    await makeInquiry({ followUpDaysAgo: 6 });

    await db.notification.deleteMany({ where: { recipientId: ME } });
    const result = await sweepFollowUps();

    const mine = result.notified.filter((row) => row.ownerId === ME);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.dueCount).toBeGreaterThanOrEqual(3);

    const notifications = await db.notification.findMany({ where: { recipientId: ME } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.title).toContain("follow-up");
  });
});
