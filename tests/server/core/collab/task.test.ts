import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  TASK_ASSIGNED_NOTIFICATION_TYPE,
  assignTaskService,
  createTaskService,
  myWorkService,
  setTaskStatusService,
  tasksForRecordService,
} from "@/server/core/collab/task-service";

/**
 * §2's task, against the real database.
 *
 * ## What is pinned here, and why each one
 *
 *  1. **A task reaches somebody.** §1's failure is an assignment that leaves no record and no
 *     notification. A create that writes a row and tells nobody would reproduce it exactly.
 *  2. **`assignedAt` is a real clock.** It starts on a handover, does not move when the task is
 *     edited, and clears when the task is put down. §8 fires `task.overdue` off dates like this,
 *     and docs/DECISIONS.md #133 is the record of what happens when a report and its data are built
 *     at different moments.
 *  3. **My Work is ordered by lateness, not by priority.** The rules test pins the comparator; this
 *     one pins that the service actually applies it to rows out of the database.
 *  4. **Closed work leaves My Work.** A list of what is owed that keeps showing finished tasks stops
 *     being read.
 *  5. **A task attached to a record is findable from that record.** The entity link is the whole
 *     argument of the module; a link nothing can query is decoration.
 */

const suffix = randomUUID().slice(0, 8);
const actor = {
  actorId: `task-${suffix}`,
  actorLabel: "Task fixture",
  ip: null,
  userAgent: null,
  requestId: null,
};

const taskIds: string[] = [];
const userIds: string[] = [];

/** A day offset from now, at midnight, so the urgency bands land where the test intends. */
function daysFromNow(days: number): Date {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

async function makeUser(name: string) {
  const user = await db.user.create({
    data: {
      name,
      email: `task-${randomUUID().slice(0, 8)}@test.local`,
      passwordHash: "x",
      isActive: true,
    },
  });
  userIds.push(user.id);
  return user;
}

async function makeTask(input: Parameters<typeof createTaskService>[1]) {
  const task = await createTaskService(actor, input);
  taskIds.push(task.id);
  return task;
}

afterAll(async () => {
  /*
    Every step guarded, and the users last.

    docs/DECISIONS.md #132: cleanup is sequential, so one failure part-way up abandons everything
    below it — which is how fourteen `@test.local` users came to be live in the company's database
    while every fixture that created them had a correct-looking `afterAll`.
  */
  const step = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      console.error(`[task.test cleanup] ${label} failed`, error);
    }
  };

  await step("notifications", () =>
    db.notification.deleteMany({ where: { entityId: { in: taskIds } } }),
  );
  await step("audit", () => db.auditLog.deleteMany({ where: { entityId: { in: taskIds } } }));
  await step("events", () => db.eventOutbox.deleteMany({ where: { actorId: actor.actorId } }));
  await step("tasks", () => db.task.deleteMany({ where: { id: { in: taskIds } } }));
  await step("user roles", () => db.userRole.deleteMany({ where: { userId: { in: userIds } } }));
  await step("users", () => db.user.deleteMany({ where: { id: { in: userIds } } }));
  await db.$disconnect();
});

describe("createTaskService", () => {
  it("numbers the task and tells the person it was given to", async () => {
    const kj = await makeUser(`Assignee ${suffix}`);

    const task = await makeTask({
      title: "Raise the downpayment invoice",
      entityType: "SalesOrder",
      entityId: `so-${suffix}`,
      assigneeId: kj.id,
      dueAt: daysFromNow(1),
    });

    expect(task.number).toMatch(/^AIESTSK-\d{6}$/);

    const notifications = await db.notification.findMany({
      where: { recipientId: kj.id, type: TASK_ASSIGNED_NOTIFICATION_TYPE, entityId: task.id },
    });
    // The record and the telling. §1's problem is an assignment that produces neither.
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.title).toContain(task.number);

    const row = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.assignedAt).not.toBeNull();
  });

  it("tells an urgent assignee straight through quiet hours", async () => {
    // docs/DECISIONS.md and the 21 August walkthrough (finding #1): `tellAssignee` never told
    // `notify()` a task was urgent, so `passesQuietHours()` — built for exactly this — never saw it.
    // Deterministic regardless of when the suite runs: `passesQuietHours(type, true)` is true
    // whatever the hour, so an urgent task's notification is never held, in or out of quiet hours.
    const kj = await makeUser(`Urgent assignee ${suffix}`);

    const task = await makeTask({
      title: "Process payment to a supplier",
      assigneeId: kj.id,
      priority: "urgent",
    });

    const notification = await db.notification.findFirstOrThrow({
      where: { recipientId: kj.id, type: TASK_ASSIGNED_NOTIFICATION_TYPE, entityId: task.id },
    });
    expect(notification.heldUntil).toBeNull();
  });

  it("does not notify somebody about a task they gave themselves", async () => {
    const task = await makeTask({ title: "Tidy the store room", assigneeId: actor.actorId });

    const notifications = await db.notification.count({ where: { entityId: task.id } });
    expect(notifications).toBe(0);
  });

  it("accepts a task with no assignee and no due date", async () => {
    const task = await makeTask({ title: "Book the Christmas party" });

    const row = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.assigneeId).toBeNull();
    // Never assigned, so never clocked. Not "assigned at creation with nobody in the box".
    expect(row.assignedAt).toBeNull();
  });

  it("refuses a task attached to half a record", async () => {
    await expect(
      createTaskService(actor, { title: "Chase it", entityType: "Ticket" }),
    ).rejects.toThrow(/whole record/);
  });
});

describe("assignTaskService", () => {
  it("starts the clock on a handover and clears it when the task is put down", async () => {
    const first = await makeUser(`First ${suffix}`);
    const second = await makeUser(`Second ${suffix}`);

    const task = await makeTask({ title: "Confirm the site contact", assigneeId: first.id });
    const before = await db.task.findUniqueOrThrow({ where: { id: task.id } });

    await assignTaskService(actor, { taskId: task.id, assigneeId: second.id });
    const handed = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(handed.assigneeId).toBe(second.id);
    expect(handed.assignedAt!.getTime()).toBeGreaterThanOrEqual(before.assignedAt!.getTime());

    await assignTaskService(actor, { taskId: task.id, assigneeId: null });
    const dropped = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(dropped.assigneeId).toBeNull();
    // Nobody owes it, so nothing has been owed since any particular moment.
    expect(dropped.assignedAt).toBeNull();
  });

  it("tells a reassigned urgent task's new owner straight through quiet hours", async () => {
    // Same fix, the other call site: `tellAssignee` is shared by create and reassignment, and the
    // reassignment path needed `priority` added to its own `select` before it had anything to pass.
    const first = await makeUser(`Handoff first ${suffix}`);
    const second = await makeUser(`Handoff second ${suffix}`);
    const task = await makeTask({
      title: "Chase the overdue supplier bill",
      assigneeId: first.id,
      priority: "urgent",
    });

    await assignTaskService(actor, { taskId: task.id, assigneeId: second.id });

    const notification = await db.notification.findFirstOrThrow({
      where: { recipientId: second.id, type: TASK_ASSIGNED_NOTIFICATION_TYPE, entityId: task.id },
    });
    expect(notification.heldUntil).toBeNull();
  });

  it("leaves the clock alone when the assignee is unchanged", async () => {
    const owner = await makeUser(`Owner ${suffix}`);
    const task = await makeTask({ title: "Return the tools", assigneeId: owner.id });
    const before = await db.task.findUniqueOrThrow({ where: { id: task.id } });

    await assignTaskService(actor, { taskId: task.id, assigneeId: owner.id });

    const after = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    // Re-saving must not make a week-old assignment look fresh — the whole reason `assignedAt` is
    // its own column rather than a read of `updatedAt`.
    expect(after.assignedAt!.getTime()).toBe(before.assignedAt!.getTime());
  });

  it("refuses to hand a task to somebody who is not an active user", async () => {
    const task = await makeTask({ title: "Send the report" });

    await expect(
      assignTaskService(actor, { taskId: task.id, assigneeId: `ghost-${suffix}` }),
    ).rejects.toThrow(/not an active user/);
  });

  it("refuses to reassign finished work", async () => {
    const owner = await makeUser(`Finisher ${suffix}`);
    const task = await makeTask({ title: "Close the punch list", assigneeId: owner.id });
    await setTaskStatusService(actor, { taskId: task.id, status: "done" });

    await expect(
      assignTaskService(actor, { taskId: task.id, assigneeId: actor.actorId }),
    ).rejects.toThrow(/done/);
  });
});

describe("setTaskStatusService", () => {
  it("stamps completion and clears it again when the task is reopened", async () => {
    const task = await makeTask({ title: "Prepare the close-out pack" });

    await setTaskStatusService(actor, { taskId: task.id, status: "done", actualHours: 3.5 });
    const done = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(done.completedAt).not.toBeNull();
    expect(Number(done.actualHours)).toBe(3.5);

    await setTaskStatusService(actor, { taskId: task.id, status: "in_progress" });
    const reopened = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    // A reopened task that kept its completion date would report as finished on a day it was not.
    expect(reopened.completedAt).toBeNull();
  });

  it("refuses to reopen a cancelled task", async () => {
    const task = await makeTask({ title: "Order the wrong part" });
    await setTaskStatusService(actor, { taskId: task.id, status: "cancelled" });

    await expect(setTaskStatusService(actor, { taskId: task.id, status: "todo" })).rejects.toThrow(
      /raise a new one/,
    );
  });
});

describe("myWorkService", () => {
  it("orders by lateness, keeps undated last, and drops finished work", async () => {
    const me = await makeUser(`Worker ${suffix}`);

    const veryLate = await makeTask({
      title: "Chase the 2307",
      assigneeId: me.id,
      dueAt: daysFromNow(-9),
    });
    const slightlyLate = await makeTask({
      title: "Approve the material request",
      assigneeId: me.id,
      dueAt: daysFromNow(-2),
    });
    const urgentButDistant = await makeTask({
      title: "Renew the calibration certificate",
      assigneeId: me.id,
      priority: "urgent",
      dueAt: daysFromNow(30),
    });
    const undated = await makeTask({
      title: "Book the Christmas party",
      assigneeId: me.id,
      priority: "urgent",
    });
    const finished = await makeTask({
      title: "Already handled",
      assigneeId: me.id,
      dueAt: daysFromNow(-30),
    });
    await setTaskStatusService(actor, { taskId: finished.id, status: "done" });

    const work = await myWorkService(me.id);
    const order = work.rows.map((row) => row.id);

    expect(order).toEqual([veryLate.id, slightlyLate.id, urgentButDistant.id, undated.id]);
    // The urgent-but-distant task sits below both overdue ones despite its priority. That is the
    // rule, not an accident of insertion order.
    expect(order.indexOf(urgentButDistant.id)).toBeGreaterThan(order.indexOf(slightlyLate.id));
    expect(order).not.toContain(finished.id);

    expect(work.overdue).toBe(2);
    expect(work.undated).toBe(1);
    expect(work.rows[0]!.daysLate).toBe(9);
    // Undated is null, never zero — an uncommitted task is not on time.
    expect(work.rows[3]!.daysLate).toBeNull();
    expect(work.rows[3]!.urgency).toBe("undated");
  });
});

describe("tasksForRecordService", () => {
  it("finds the tasks hanging off one record, with the owner's name", async () => {
    const owner = await makeUser(`Panel ${suffix}`);
    const ticketId = `ticket-${suffix}`;

    const onRecord = await makeTask({
      title: "Schedule the site inspection",
      entityType: "Ticket",
      entityId: ticketId,
      assigneeId: owner.id,
    });
    await makeTask({ title: "Unrelated work", assigneeId: owner.id });

    const rows = await tasksForRecordService({ entityType: "Ticket", entityId: ticketId });

    expect(rows.map((row) => row.id)).toEqual([onRecord.id]);
    // A panel showing cuids is a panel nobody can work from.
    expect(rows[0]!.assigneeName).toBe(owner.name);
  });
});
