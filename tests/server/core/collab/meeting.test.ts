import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  addActionItemService,
  cancelMeetingService,
  meetingService,
  recordMinutesService,
  scheduleMeetingService,
} from "@/server/core/collab/meeting-service";

/**
 * §6's meetings against the real database.
 *
 * ## What is pinned
 *
 *  1. **An action item is a real task**, numbered, on somebody's My Work, pointing back at the
 *     meeting. §6's entire argument: *"action items that are created as real tasks with owners and
 *     due dates"* rather than a to-do list buried in minutes.
 *  2. **A series carries forward what is still open**, read live — an item closed since the last
 *     meeting is not on this one's agenda.
 *  3. **Decisions are stored apart from the prose**, because a decision buried in a paragraph cannot
 *     be found six months later.
 *  4. **A cancelled meeting cannot be written up, and a held one cannot be cancelled.** Both would
 *     produce a record that disagrees with itself.
 */

const suffix = randomUUID().slice(0, 8);
const actor = {
  actorId: `meet-${suffix}`,
  actorLabel: "Meeting fixture",
  ip: null,
  userAgent: null,
  requestId: null,
};

const meetingIds: string[] = [];
const taskIds: string[] = [];

async function schedule(over: Record<string, unknown> = {}) {
  const meeting = await scheduleMeetingService(actor, {
    title: `Operations review ${suffix}`,
    scheduledAt: new Date("2026-08-21T01:00:00.000Z"),
    ...over,
  });
  meetingIds.push(meeting.id);
  return meeting;
}

afterAll(async () => {
  const step = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      console.error(`[meeting.test cleanup] ${label} failed`, error);
    }
  };

  // By entity as well as by tracked id, per docs/DECISIONS.md #139.
  const tasks = await db.task.findMany({
    where: {
      OR: [{ id: { in: taskIds } }, { entityType: "Meeting", entityId: { in: meetingIds } }],
    },
    select: { id: true },
  });
  const ids = tasks.map((task) => task.id);

  await step("notifications", () =>
    db.notification.deleteMany({ where: { entityId: { in: ids } } }),
  );
  await step("audit", () =>
    db.auditLog.deleteMany({ where: { entityId: { in: [...ids, ...meetingIds] } } }),
  );
  await step("events", () => db.eventOutbox.deleteMany({ where: { actorId: actor.actorId } }));
  await step("tasks", () => db.task.deleteMany({ where: { id: { in: ids } } }));
  await step("meetings", () => db.meeting.deleteMany({ where: { id: { in: meetingIds } } }));
  await db.$disconnect();
});

describe("action items", () => {
  it("raises a real task that points back at the meeting", async () => {
    const meeting = await schedule();

    const task = await addActionItemService(actor, {
      meetingId: meeting.id,
      title: "Send the revised method statement",
      dueAt: new Date("2026-08-28T00:00:00.000Z"),
    });
    taskIds.push(task.id);

    const row = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.number).toMatch(/^AIESTSK-/);
    // Not a field on the meeting: a real task, findable from the meeting and from My Work.
    expect(row.entityType).toBe("Meeting");
    expect(row.entityId).toBe(meeting.id);
    expect(row.description).toContain(meeting.number);

    const view = await meetingService({ meetingId: meeting.id });
    expect(view.actionItems.map((item) => item.id)).toEqual([task.id]);
  });
});

describe("a recurring series", () => {
  it("carries forward what the last meeting left open, and drops what was closed", async () => {
    const seriesKey = `weekly-${suffix}`;

    const first = await schedule({
      seriesKey,
      scheduledAt: new Date("2026-08-14T01:00:00.000Z"),
    });
    const stillOpen = await addActionItemService(actor, {
      meetingId: first.id,
      title: "Chase the crane quotation",
    });
    const finished = await addActionItemService(actor, {
      meetingId: first.id,
      title: "Book the hotel",
    });
    taskIds.push(stillOpen.id, finished.id);

    await db.task.update({ where: { id: finished.id }, data: { status: "done" } });

    const second = await schedule({
      seriesKey,
      scheduledAt: new Date("2026-08-21T01:00:00.000Z"),
    });

    const view = await meetingService({ meetingId: second.id });
    expect(view.carriedFrom?.number).toBe(first.number);
    /*
      Read live rather than copied. The item somebody finished on Tuesday is not on Thursday's
      agenda — which is what stops a standing meeting becoming a standing complaint.
    */
    expect(view.carriedForward.map((task) => task.id)).toEqual([stillOpen.id]);
  });

  it("carries nothing forward for a meeting that is not in a series", async () => {
    const meeting = await schedule();
    const view = await meetingService({ meetingId: meeting.id });
    expect(view.carriedForward).toEqual([]);
    expect(view.carriedFrom).toBeNull();
  });
});

describe("writing it up", () => {
  it("stores decisions apart from the prose and marks the meeting held", async () => {
    const meeting = await schedule();

    const result = await recordMinutesService(actor, {
      meetingId: meeting.id,
      minutes: "Went through the open jobs and the crane hire.",
      decisions: ["Approved the revised lifting method", "Deferred the Cebu visit to September"],
    });

    expect(result.decisions).toBe(2);

    const view = await meetingService({ meetingId: meeting.id });
    // A meeting with minutes and a `scheduled` status would be a record that disagrees with itself.
    expect(view.status).toBe("held");
    expect(view.heldAt).not.toBeNull();
    // Separately, because a decision buried in a paragraph cannot be searched for.
    expect(view.decisions.map((entry) => entry.decision)).toContain(
      "Approved the revised lifting method",
    );
    expect(view.minutes).toContain("crane hire");
  });

  it("refuses minutes for a meeting that was cancelled", async () => {
    const meeting = await schedule();
    await cancelMeetingService(actor, {
      meetingId: meeting.id,
      reason: "Half the team is on site",
    });

    await expect(
      recordMinutesService(actor, {
        meetingId: meeting.id,
        minutes: "This meeting did not take place.",
      }),
    ).rejects.toThrow(/fiction/);
  });

  it("refuses to cancel a meeting that has been held", async () => {
    const meeting = await schedule();
    await recordMinutesService(actor, {
      meetingId: meeting.id,
      minutes: "Short review of the week.",
    });

    // It happened. Cancelling it afterwards would erase the fact that decisions were taken.
    await expect(
      cancelMeetingService(actor, { meetingId: meeting.id, reason: "Changed my mind" }),
    ).rejects.toThrow(/has been held/);
  });
});
