import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { calendarService } from "@/server/core/collab/calendar-service";
import { createTaskService } from "@/server/core/collab/task-service";

/**
 * §4's calendar against the real database — specifically the three sources added and fixed on
 * 2026-09-02, at the company's own instruction: *"repurpose the calendar to display dates as stated
 * in the raised tasks... the calendar should also display delivery dates and site inspection dates
 * with the location... and the assigned person/s doing the site inspection."*
 *
 * ## What is pinned
 *
 *  1. **A delivery ticket is labelled `delivery`, not the generic `ticket`.** `delivery` was declared
 *     in `CALENDAR_SOURCES`/`CALENDAR_SOURCE_LABELS` since the source list existed and never once
 *     produced an entry — every ticket, delivery or not, came out as the generic "Job scheduled".
 *  2. **A task's own due date appears**, which nothing on the calendar read before this.
 *  3. **A site inspection appears with its site's name as `location` and its inspectors' names as
 *     `people`** — the two fields this session added to `CalendarEntry` for exactly this.
 */

const suffix = randomUUID().slice(0, 8);
const actor = {
  actorId: `cal-${suffix}`,
  actorLabel: "Calendar fixture",
  ip: null,
  userAgent: null,
  requestId: null,
};
const viewer = { id: actor.actorId, permissions: new Set<string>() };

const accountIds: string[] = [];
const siteIds: string[] = [];
const ticketIds: string[] = [];
const taskIds: string[] = [];
const inspectionIds: string[] = [];
const userIds: string[] = [];

const from = new Date("2027-01-01T00:00:00.000Z");
const to = new Date("2027-02-01T00:00:00.000Z");
const inRange = new Date("2027-01-15T09:00:00.000Z");

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityId: { in: [...taskIds, ...ticketIds] } } });
  await db.eventOutbox.deleteMany({ where: { actorId: actor.actorId } });
  await db.task.deleteMany({ where: { id: { in: taskIds } } });
  await db.siteInspection.deleteMany({ where: { id: { in: inspectionIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.site.deleteMany({ where: { id: { in: siteIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

async function makeAccount() {
  const account = await db.customerAccount.create({
    data: {
      code: `TC-cal-${randomUUID().slice(0, 6)}`,
      name: `TC Co calendar ${suffix}`,
      ownerId: actor.actorId,
    },
  });
  accountIds.push(account.id);
  return account;
}

async function makeInspector() {
  const role = await db.role.findFirstOrThrow();
  const user = await db.user.create({
    data: {
      email: `cal-inspector-${randomUUID().slice(0, 8)}@test.local`,
      name: `Inspector ${suffix}`,
      passwordHash: "x",
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  userIds.push(user.id);
  return user;
}

describe("calendarService", () => {
  it("labels a delivery ticket 'delivery', not the generic 'ticket'", async () => {
    const account = await makeAccount();
    const delivery = await db.ticket.create({
      data: {
        number: `AIESTKT-cal-${randomUUID().slice(0, 6)}`,
        accountId: account.id,
        type: "delivery",
        title: "Deliver the replacement bearing set",
        scopeOfWork: "Deliver",
        status: "generated",
        raisedById: actor.actorId,
        scheduledStart: inRange,
      },
    });
    ticketIds.push(delivery.id);

    const installation = await db.ticket.create({
      data: {
        number: `AIESTKT-cal-${randomUUID().slice(0, 6)}`,
        accountId: account.id,
        type: "installation",
        title: "Install the new pump",
        scopeOfWork: "Install",
        status: "generated",
        raisedById: actor.actorId,
        scheduledStart: inRange,
      },
    });
    ticketIds.push(installation.id);

    const { entries } = await calendarService(viewer, { from, to });
    const deliveryEntry = entries.find((entry) => entry.id === delivery.id);
    const installationEntry = entries.find((entry) => entry.id === installation.id);

    expect(deliveryEntry?.source).toBe("delivery");
    expect(installationEntry?.source).toBe("ticket");
  }, 30_000);

  it("shows a task's own due date", async () => {
    const task = await createTaskService(actor, {
      title: "Chase the calibration certificate",
      dueAt: inRange,
      assigneeId: actor.actorId,
    });
    taskIds.push(task.id);

    const { entries } = await calendarService(viewer, { from, to });
    const entry = entries.find(
      (candidate) => candidate.source === "task_due" && candidate.id === task.id,
    );

    expect(entry).toBeTruthy();
    expect(entry?.title).toBe("Chase the calibration certificate");
    expect(entry?.userIds).toEqual([actor.actorId]);
  }, 30_000);

  it("shows a site inspection with its site as the location and its inspectors named", async () => {
    const account = await makeAccount();
    const site = await db.site.create({
      data: { accountId: account.id, name: `Warehouse ${suffix}`, address: { line1: "Km 17" } },
    });
    siteIds.push(site.id);
    const inspector = await makeInspector();

    const inspection = await db.siteInspection.create({
      data: {
        number: `AIESSIR-cal-${randomUUID().slice(0, 6)}`,
        siteId: site.id,
        inspectedByIds: [inspector.id],
        scheduledFor: inRange,
      },
    });
    inspectionIds.push(inspection.id);

    const { entries } = await calendarService(viewer, { from, to });
    const entry = entries.find((candidate) => candidate.id === inspection.id);

    expect(entry?.source).toBe("site_inspection");
    expect(entry?.location).toBe(`${site.name} — Km 17`);
    expect(entry?.people).toEqual([inspector.name]);
    expect(entry?.userIds).toEqual([inspector.id]);
  }, 30_000);
});
