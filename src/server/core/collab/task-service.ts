import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import { emit } from "@/server/core/events/emit";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";
import type { ActorMeta } from "@/server/core/crm/account-service";
import {
  CLOSED_STATUSES,
  checkStatusChange,
  checkTask,
  compareForMyWork,
  daysLate,
  urgencyFor,
  type TaskPriority,
  type TaskStatus,
} from "@/server/core/collab/task-rules";

export const TASK_ENTITY_TYPE = "Task";
export const TASK_DOCUMENT_TYPE = "task";

export const TASK_ASSIGNED_NOTIFICATION_TYPE = "task.assigned";

/**
 * §2's tasks — the record an assignment leaves behind.
 *
 * §1 is worth keeping in view while reading this file, because it explains why the service is shaped
 * around `entityId` rather than around a board:
 *
 * > Work is assigned in a way that produces no record. The fix is **every assignment is a task
 * > attached to a business record, with an owner and a due date**.
 *
 * So the interesting parts here are not the CRUD. They are: assignment is its own act with its own
 * clock, completion is a claim that work happened, and a task always says what record it serves.
 */

registerNotificationType({
  key: TASK_ASSIGNED_NOTIFICATION_TYPE,
  label: "A task was assigned to you",
  /*
    Not coalesced, and not digest-only.

    §2's whole purpose is that an assignment reaches somebody. Rolling three into "3 tasks assigned"
    would make them open a screen to find out what they are — and the commonest of these arrives from
    a template the moment a sales order is raised, when the point is that finance learns about the
    downpayment invoice without being told in a meeting.
  */
  defaultChannels: { inApp: true, email: false, digest: true },
});

interface CreateTaskInput {
  title: string;
  description?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  assigneeId?: string | null;
  watcherIds?: string[];
  priority?: TaskPriority;
  dueAt?: Date | null;
  startAt?: Date | null;
  estimateHours?: number | null;
  labels?: string[];
  parentTaskId?: string | null;
  createdByTemplate?: string | null;
}

export async function createTaskService(actor: ActorMeta, input: CreateTaskInput) {
  const check = checkTask(input);
  if (!check.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: check.errors.join(" ") });
  }

  const number = await allocateNumber(TASK_DOCUMENT_TYPE);

  const created = await db.$transaction(async (tx) => {
    const task = await tx.task.create({
      data: {
        number,
        title: input.title.trim(),
        description: input.description?.trim() || null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        assigneeId: input.assigneeId ?? null,
        // The clock starts when somebody is given it, not when it is written down. A task created
        // unassigned and picked up on Friday has been theirs since Friday.
        assignedAt: input.assigneeId ? new Date() : null,
        watcherIds: input.watcherIds ?? [],
        priority: input.priority ?? "normal",
        dueAt: input.dueAt ?? null,
        startAt: input.startAt ?? null,
        estimateHours:
          input.estimateHours === null || input.estimateHours === undefined
            ? null
            : input.estimateHours.toFixed(2),
        labels: input.labels ?? [],
        parentTaskId: input.parentTaskId ?? null,
        createdByTemplate: input.createdByTemplate ?? null,
        createdById: actor.actorId,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "create",
      entityType: TASK_ENTITY_TYPE,
      entityId: task.id,
      summary:
        `Raised ${task.number} — ${task.title}` +
        (input.entityType ? ` on ${input.entityType}` : "") +
        (input.dueAt ? `, due ${input.dueAt.toISOString().slice(0, 10)}` : ", no due date"),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "task.created",
      {
        taskId: task.id,
        number: task.number,
        entityType: task.entityType,
        entityId: task.entityId,
      },
      { actorId: actor.actorId },
    );

    return task;
  });

  if (created.assigneeId)
    await tellAssignee(
      actor,
      created.id,
      created.assigneeId,
      created.number,
      created.title,
      created.priority as TaskPriority,
    );

  return { id: created.id, number: created.number };
}

/**
 * Telling somebody a task is theirs.
 *
 * Outside the transaction and swallowed on failure, as every other notify in this platform is: the
 * task is recorded whatever the bell does. A missing notification is an annoyance; a rolled-back
 * assignment is work nobody owns.
 *
 * `urgent` is passed through to `notify()`, which is what `passesQuietHours()` has always checked —
 * the plumbing existed since §7 was built. This was the one caller that never told it: an urgent
 * task was held through quiet hours exactly like a normal one, reported and confirmed twice on
 * 2026-09-01, and matching finding #1 of the 21 August walkthrough (docs/FEEDBACK-LOG.md).
 */
async function tellAssignee(
  actor: ActorMeta,
  taskId: string,
  assigneeId: string,
  number: string,
  title: string,
  priority: TaskPriority,
) {
  if (assigneeId === actor.actorId) return; // Nobody needs telling about a task they gave themselves.
  try {
    await notify({
      recipientId: assigneeId,
      type: TASK_ASSIGNED_NOTIFICATION_TYPE,
      title: `${actor.actorLabel} assigned you ${number}`,
      body: title,
      entityType: TASK_ENTITY_TYPE,
      entityId: taskId,
      urgent: priority === "urgent",
    });
  } catch {
    // Deliberately swallowed. See above.
  }
}

export async function assignTaskService(
  actor: ActorMeta,
  input: { taskId: string; assigneeId: string | null },
) {
  const task = await db.task.findFirst({
    where: { id: input.taskId, deletedAt: null },
    select: { id: true, number: true, title: true, assigneeId: true, status: true, priority: true },
  });
  if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "That task no longer exists." });

  if (CLOSED_STATUSES.includes(task.status as TaskStatus)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${task.number} is ${task.status}. Reassigning finished work changes who it looks like did it.`,
    });
  }

  if (input.assigneeId) {
    const assignee = await db.user.findFirst({
      where: { id: input.assigneeId, isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (!assignee) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "That person is not an active user, so the task would be owed by nobody.",
      });
    }
  }

  await db.$transaction(async (tx) => {
    await tx.task.update({
      where: { id: task.id },
      data: {
        assigneeId: input.assigneeId,
        /*
          The clock restarts on a real handover and is cleared when a task is put back down.

          Not touched when the assignee is unchanged, so re-saving a task does not make it look
          freshly assigned — the same reason `assignedAt` is a column rather than a read of
          `updatedAt`.
        */
        assignedAt:
          input.assigneeId === task.assigneeId ? undefined : input.assigneeId ? new Date() : null,
        version: { increment: 1 },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "update",
      entityType: TASK_ENTITY_TYPE,
      entityId: task.id,
      summary: input.assigneeId
        ? `Assigned ${task.number} to ${input.assigneeId}`
        : `Unassigned ${task.number} — it is nobody's until somebody takes it`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "task.assigned",
      { taskId: task.id, number: task.number, assigneeId: input.assigneeId },
      { actorId: actor.actorId },
    );
  });

  if (input.assigneeId && input.assigneeId !== task.assigneeId) {
    await tellAssignee(
      actor,
      task.id,
      input.assigneeId,
      task.number,
      task.title,
      task.priority as TaskPriority,
    );
  }

  return { assigneeId: input.assigneeId };
}

export async function setTaskStatusService(
  actor: ActorMeta,
  input: { taskId: string; status: TaskStatus; actualHours?: number | null },
) {
  const task = await db.task.findFirst({
    where: { id: input.taskId, deletedAt: null },
    select: { id: true, number: true, title: true, status: true, assigneeId: true },
  });
  if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "That task no longer exists." });

  const check = checkStatusChange(task.status, input.status);
  if (!check.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: check.errors.join(" ") });
  }

  const closing = CLOSED_STATUSES.includes(input.status);

  await db.$transaction(async (tx) => {
    await tx.task.update({
      where: { id: task.id },
      data: {
        status: input.status,
        /*
          `completedAt` is set on the way in and cleared on the way out.

          A task reopened from `done` that kept its completion date would report as finished on a day
          it was not — and §2 allows reopening precisely because boards get dragged around.
        */
        completedAt: input.status === "done" ? new Date() : closing ? undefined : null,
        actualHours:
          input.actualHours === null || input.actualHours === undefined
            ? undefined
            : input.actualHours.toFixed(2),
        version: { increment: 1 },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: input.status === "done" ? "complete" : "update",
      entityType: TASK_ENTITY_TYPE,
      entityId: task.id,
      summary: `${task.number} moved from ${task.status} to ${input.status}`,
      diff: { status: { from: task.status, to: input.status } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    if (input.status === "done") {
      await emit(
        tx,
        "task.completed",
        { taskId: task.id, number: task.number, assigneeId: task.assigneeId },
        { actorId: actor.actorId },
      );
    }
  });

  return { status: input.status };
}

/** The shape every task list on a screen reads. */
function decorate(task: {
  id: string;
  number: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueAt: Date | null;
  assigneeId: string | null;
  entityType: string | null;
  entityId: string | null;
  labels: string[];
  createdAt: Date;
}) {
  return {
    ...task,
    daysLate: daysLate(task.dueAt),
    urgency: urgencyFor(task.dueAt, task.status),
  };
}

/**
 * §2's My Work — *"one screen answers 'what am I supposed to be doing?'"*
 *
 * Across every module, which is the point: a task on a cash advance and a task on a quotation are
 * both work somebody owes, and asking them to check five screens is how the old meeting-based
 * assignment survived.
 *
 * Closed tasks are excluded rather than shown greyed. This is a list of what is owed; what was
 * finished belongs on the record it served.
 */
export async function myWorkService(userId: string) {
  const tasks = await db.task.findMany({
    where: {
      deletedAt: null,
      assigneeId: userId,
      status: { notIn: [...CLOSED_STATUSES] },
    },
    select: {
      id: true,
      number: true,
      title: true,
      description: true,
      status: true,
      priority: true,
      dueAt: true,
      assigneeId: true,
      entityType: true,
      entityId: true,
      labels: true,
      createdAt: true,
    },
    take: 300,
  });

  const now = new Date();
  const rows = tasks.map(decorate).sort((a, b) => compareForMyWork(a, b, now));

  return {
    rows,
    overdue: rows.filter((row) => row.urgency === "overdue").length,
    dueToday: rows.filter((row) => row.urgency === "today").length,
    /*
      Counted and surfaced rather than left in the list.

      An undated task is not late and not on time — it is uncommitted, and §2 asks for a screen that
      answers "what am I supposed to be doing". "Four of these have no date" is part of that answer.
    */
    undated: rows.filter((row) => row.urgency === "undated").length,
  };
}

/** Everything hanging off one record — the panel a ticket or a quotation shows. */
export async function tasksForRecordService(input: { entityType: string; entityId: string }) {
  const tasks = await db.task.findMany({
    where: { deletedAt: null, entityType: input.entityType, entityId: input.entityId },
    select: {
      id: true,
      number: true,
      title: true,
      description: true,
      status: true,
      priority: true,
      dueAt: true,
      assigneeId: true,
      entityType: true,
      entityId: true,
      labels: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
    take: 100,
  });

  const names = await namesFor(tasks.map((task) => task.assigneeId));
  return tasks.map((task) => ({
    ...decorate(task),
    assigneeName: task.assigneeId ? (names.get(task.assigneeId) ?? "somebody") : null,
  }));
}

async function namesFor(ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map<string, string>();
  const users = await db.user.findMany({
    where: { id: { in: wanted } },
    select: { id: true, name: true },
  });
  return new Map(users.map((user) => [user.id, user.name]));
}

/**
 * Everything, for the list view — with the assignee's name, because a board showing cuids is a board
 * nobody can work from.
 */
export async function listTasksService(
  filter: { status?: string; assigneeId?: string; entityType?: string } = {},
) {
  const tasks = await db.task.findMany({
    where: {
      deletedAt: null,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.assigneeId ? { assigneeId: filter.assigneeId } : {}),
      ...(filter.entityType ? { entityType: filter.entityType } : {}),
    },
    select: {
      id: true,
      number: true,
      title: true,
      description: true,
      status: true,
      priority: true,
      dueAt: true,
      assigneeId: true,
      entityType: true,
      entityId: true,
      labels: true,
      createdAt: true,
    },
    take: 300,
  });

  const names = await namesFor(tasks.map((task) => task.assigneeId));
  const now = new Date();

  return tasks
    .map((task) => ({
      ...decorate(task),
      assigneeName: task.assigneeId ? (names.get(task.assigneeId) ?? "somebody") : null,
    }))
    .sort((a, b) => compareForMyWork(a, b, now));
}

/** Who a task can be given to. Active users only — an inactive one owes nothing. */
export async function assignableUsersService() {
  return db.user.findMany({
    where: { isActive: true, deletedAt: null },
    select: { id: true, name: true, jobTitle: true },
    orderBy: { name: "asc" },
  });
}
