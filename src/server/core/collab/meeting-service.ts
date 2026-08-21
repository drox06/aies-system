import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { createTaskService } from "@/server/core/collab/task-service";
import { CLOSED_STATUSES } from "@/server/core/collab/task-rules";

/**
 * §6's meetings: *"Since meetings will not disappear, make them produce records instead of replacing
 * them."*
 *
 * ## The action items are tasks, not a list on this record
 *
 * §6 asks for *"action items that are created as real tasks with owners and due dates"*, and that is
 * the whole design. A decision written into minutes that nobody owns is §1's problem in a tidier
 * format — the meeting where work is assigned and nothing follows. Every item goes through
 * `createTaskService`, lands on somebody's My Work, and links back here.
 *
 * ## A series carries its open items forward
 *
 * §6: *"Recurring meeting series carry forward open action items automatically."* Carried as a
 * **reading**, not a copy: the next meeting's agenda shows the tasks from the last one that are still
 * open, live. Copying them would produce two records of one job and the copy is the one that goes
 * stale.
 */

export const MEETING_ENTITY_TYPE = "Meeting";
export const MEETING_DOCUMENT_TYPE = "meeting";

interface AgendaItem {
  item: string;
  note?: string;
}

interface Decision {
  decision: string;
  madeAt: string;
}

const asAgenda = (value: unknown): AgendaItem[] =>
  Array.isArray(value) ? (value as unknown as AgendaItem[]) : [];

const asDecisions = (value: unknown): Decision[] =>
  Array.isArray(value) ? (value as unknown as Decision[]) : [];

export async function scheduleMeetingService(
  actor: ActorMeta,
  input: {
    title: string;
    scheduledAt: Date;
    location?: string | null;
    seriesKey?: string | null;
    attendeeIds?: string[];
    agenda?: AgendaItem[];
  },
) {
  if (input.title.trim().length < 3) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Give the meeting a subject." });
  }

  const number = await allocateNumber(MEETING_DOCUMENT_TYPE);

  const meeting = await db.$transaction(async (tx) => {
    const created = await tx.meeting.create({
      data: {
        number,
        title: input.title.trim(),
        scheduledAt: input.scheduledAt,
        location: input.location?.trim() || null,
        seriesKey: input.seriesKey?.trim() || null,
        // Whoever calls a meeting is in it.
        attendeeIds: [...new Set([...(input.attendeeIds ?? []), actor.actorId])],
        agenda: (input.agenda ?? []) as unknown as Prisma.InputJsonValue,
        createdById: actor.actorId,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "create",
      entityType: MEETING_ENTITY_TYPE,
      entityId: created.id,
      summary: `Called ${created.number} — ${created.title}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return created;
  });

  return { id: meeting.id, number: meeting.number };
}

export async function meetingsService() {
  const meetings = await db.meeting.findMany({
    where: { deletedAt: null },
    orderBy: { scheduledAt: "desc" },
    take: 100,
    select: {
      id: true,
      number: true,
      title: true,
      scheduledAt: true,
      location: true,
      seriesKey: true,
      status: true,
      attendeeIds: true,
      minutes: true,
    },
  });

  const openItems = await db.task.groupBy({
    by: ["entityId"],
    where: {
      deletedAt: null,
      entityType: MEETING_ENTITY_TYPE,
      status: { notIn: [...CLOSED_STATUSES] },
    },
    _count: { _all: true },
  });
  const openByMeeting = new Map(openItems.map((row) => [row.entityId, row._count._all]));

  return meetings.map((meeting) => ({
    ...meeting,
    hasMinutes: !!meeting.minutes,
    openActionItems: openByMeeting.get(meeting.id) ?? 0,
  }));
}

/**
 * One meeting, with its action items and whatever the last meeting in the series left open.
 *
 * The carried-forward list is read live from the previous meeting's tasks. Somebody who closed an
 * item yesterday does not see it on today's agenda, which is the difference between a standing item
 * and a standing complaint.
 */
export async function meetingService(input: { meetingId: string }) {
  const meeting = await db.meeting.findFirst({
    where: { id: input.meetingId, deletedAt: null },
    select: {
      id: true,
      number: true,
      title: true,
      scheduledAt: true,
      location: true,
      seriesKey: true,
      agenda: true,
      attendeeIds: true,
      apologyIds: true,
      minutes: true,
      decisions: true,
      status: true,
      heldAt: true,
      createdById: true,
    },
  });
  if (!meeting) throw new TRPCError({ code: "NOT_FOUND", message: "That meeting is gone." });

  const actionItems = await db.task.findMany({
    where: { deletedAt: null, entityType: MEETING_ENTITY_TYPE, entityId: meeting.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      dueAt: true,
      assigneeId: true,
    },
  });

  /*
    The previous meeting in the series, and what it left open.

    Only the immediately previous one. Reaching further back would turn a standing agenda into an
    archive of everything anybody has ever failed to do, which is how a recurring meeting stops being
    read at all.
  */
  let carriedForward: typeof actionItems = [];
  let carriedFrom: { id: string; number: string; scheduledAt: Date } | null = null;

  if (meeting.seriesKey) {
    const previous = await db.meeting.findFirst({
      where: {
        deletedAt: null,
        seriesKey: meeting.seriesKey,
        scheduledAt: { lt: meeting.scheduledAt },
      },
      orderBy: { scheduledAt: "desc" },
      select: { id: true, number: true, scheduledAt: true },
    });

    if (previous) {
      carriedFrom = previous;
      carriedForward = await db.task.findMany({
        where: {
          deletedAt: null,
          entityType: MEETING_ENTITY_TYPE,
          entityId: previous.id,
          status: { notIn: [...CLOSED_STATUSES] },
        },
        orderBy: { dueAt: "asc" },
        select: {
          id: true,
          number: true,
          title: true,
          status: true,
          dueAt: true,
          assigneeId: true,
        },
      });
    }
  }

  const ids = [
    ...new Set([
      ...meeting.attendeeIds,
      ...meeting.apologyIds,
      ...actionItems.map((task) => task.assigneeId),
      ...carriedForward.map((task) => task.assigneeId),
    ]),
  ].filter((id): id is string => !!id);

  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  const names = new Map(users.map((user) => [user.id, user.name]));

  const withNames = (tasks: typeof actionItems) =>
    tasks.map((task) => ({
      ...task,
      assigneeName: task.assigneeId ? (names.get(task.assigneeId) ?? "somebody") : null,
    }));

  return {
    ...meeting,
    agenda: asAgenda(meeting.agenda),
    decisions: asDecisions(meeting.decisions),
    attendees: meeting.attendeeIds.map((id) => ({ id, name: names.get(id) ?? "somebody" })),
    apologies: meeting.apologyIds.map((id) => ({ id, name: names.get(id) ?? "somebody" })),
    actionItems: withNames(actionItems),
    carriedForward: withNames(carriedForward),
    carriedFrom,
  };
}

/**
 * §6's action item, which is a task.
 *
 * The one place this module refuses to store something itself. An item recorded on the meeting would
 * be a to-do list inside minutes: invisible on My Work, invisible on the board, chased by whoever
 * remembers to reread the notes.
 */
export async function addActionItemService(
  actor: ActorMeta,
  input: { meetingId: string; title: string; assigneeId?: string | null; dueAt?: Date | null },
) {
  const meeting = await db.meeting.findFirst({
    where: { id: input.meetingId, deletedAt: null },
    select: { id: true, number: true, title: true },
  });
  if (!meeting) throw new TRPCError({ code: "NOT_FOUND", message: "That meeting is gone." });

  const task = await createTaskService(actor, {
    title: input.title,
    description: `Agreed at ${meeting.number} — ${meeting.title}.`,
    entityType: MEETING_ENTITY_TYPE,
    entityId: meeting.id,
    assigneeId: input.assigneeId ?? null,
    dueAt: input.dueAt ?? null,
  });

  return task;
}

/**
 * Writing up what happened.
 *
 * Minutes and decisions are separate fields because they are read differently: nobody searches prose
 * for what was decided six months ago, and a decision buried in a paragraph is a decision that
 * cannot be found. Marking a meeting held is the same act — a meeting with minutes and a `scheduled`
 * status would be a record that disagrees with itself.
 */
export async function recordMinutesService(
  actor: ActorMeta,
  input: {
    meetingId: string;
    minutes: string;
    decisions?: string[];
    attendeeIds?: string[];
    apologyIds?: string[];
  },
) {
  const meeting = await db.meeting.findFirst({
    where: { id: input.meetingId, deletedAt: null },
    select: { id: true, number: true, title: true, status: true, decisions: true },
  });
  if (!meeting) throw new TRPCError({ code: "NOT_FOUND", message: "That meeting is gone." });
  if (meeting.status === "cancelled") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "That meeting was cancelled. Minutes of a meeting that did not happen are a fiction.",
    });
  }

  const minutes = input.minutes.trim();
  if (minutes.length < 10) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Say what happened." });
  }

  const now = new Date();
  const decisions: Decision[] = (input.decisions ?? [])
    .map((decision) => decision.trim())
    .filter(Boolean)
    .map((decision) => ({ decision, madeAt: now.toISOString() }));

  await db.$transaction(async (tx) => {
    await tx.meeting.update({
      where: { id: meeting.id },
      data: {
        minutes,
        decisions: decisions as unknown as Prisma.InputJsonValue,
        status: "held",
        heldAt: now,
        ...(input.attendeeIds ? { attendeeIds: input.attendeeIds } : {}),
        ...(input.apologyIds ? { apologyIds: input.apologyIds } : {}),
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "update",
      entityType: MEETING_ENTITY_TYPE,
      entityId: meeting.id,
      summary:
        `Wrote up ${meeting.number}` +
        (decisions.length > 0 ? `, recording ${decisions.length} decision(s)` : ""),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { id: meeting.id, decisions: decisions.length };
}

export async function cancelMeetingService(
  actor: ActorMeta,
  input: { meetingId: string; reason: string },
) {
  const meeting = await db.meeting.findFirst({
    where: { id: input.meetingId, deletedAt: null },
    select: { id: true, number: true, status: true },
  });
  if (!meeting) throw new TRPCError({ code: "NOT_FOUND", message: "That meeting is gone." });
  if (meeting.status === "held") {
    // It happened. Cancelling it afterwards would erase the fact that decisions were taken.
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "That meeting has been held and written up. It cannot be cancelled afterwards.",
    });
  }
  if (input.reason.trim().length < 5) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Say why it is not happening." });
  }

  await db.$transaction(async (tx) => {
    await tx.meeting.update({ where: { id: meeting.id }, data: { status: "cancelled" } });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "update",
      entityType: MEETING_ENTITY_TYPE,
      entityId: meeting.id,
      summary: `Cancelled ${meeting.number}: ${input.reason.trim()}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { id: meeting.id };
}
