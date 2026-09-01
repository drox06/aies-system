import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import { emit } from "@/server/core/events/emit";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";
import type { ActorMeta } from "@/server/core/crm/account-service";
import {
  CLOSED_STATUSES,
  canSeeEveryArchivedTask,
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
export const TASK_EDITED_NOTIFICATION_TYPE = "task.edited";

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

registerNotificationType({
  key: TASK_EDITED_NOTIFICATION_TYPE,
  label: "A task assigned to you was edited",
  // Same shape as the assignment notice and for the same reason — an edit that changes what the
  // work actually is should reach the person doing it as directly as being handed it did.
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

/**
 * Telling the assignee a task they already have was changed under them.
 *
 * A near-duplicate of `tellAssignee` rather than a shared parameter on it: the two are different
 * facts ("this is now yours" versus "this changed"), the assignment one is pinned by
 * `tests/server/core/collab/task.test.ts`, and a shared function taking a type and a message string
 * would mostly exist to save six lines neither caller would then read as clearly.
 */
async function tellAssigneeOfEdit(
  actor: ActorMeta,
  taskId: string,
  assigneeId: string,
  number: string,
  title: string,
  priority: TaskPriority,
) {
  if (assigneeId === actor.actorId) return; // Nobody needs telling about their own edit.
  try {
    await notify({
      recipientId: assigneeId,
      type: TASK_EDITED_NOTIFICATION_TYPE,
      title: `${actor.actorLabel} edited ${number}`,
      body: title,
      entityType: TASK_ENTITY_TYPE,
      entityId: taskId,
      urgent: priority === "urgent",
    });
  } catch {
    // Deliberately swallowed, same reasoning as tellAssignee.
  }
}

export interface UpdateTaskInput {
  taskId: string;
  title?: string;
  description?: string | null;
  priority?: TaskPriority;
  dueAt?: Date | null;
  startAt?: Date | null;
  estimateHours?: number | null;
  labels?: string[];
}

/**
 * Editing a task's own content — the gap PD hit directly: *"he was making a task and when he needed
 * to edit the note part in the task he cannot perform the edit."* `createTaskService` could write a
 * task down; nothing could change one afterward. Title, description, priority, dates and labels are
 * editable here; the assignee has its own procedure (`assignTaskService`) because handing work to
 * somebody else is its own act with its own notice, and the entity a task is attached to is not
 * editable at all — re-pointing a task at a different record after the fact is a different task
 * wearing the old one's number, not an edit.
 *
 * **Who may edit, at the company's explicit instruction (2026-09-01): the task's own creator, or
 * EA.** Checked as `admin.manage_users` rather than the `president` role by name — the practice
 * grant (`scripts/practice-authority.ts`) gives every named user the president role for the
 * walkthrough but deliberately withholds that one permission along with `admin.manage_roles`, so it
 * is the one thing in the permission matrix that still means "actually EA" during practice and
 * "whoever holds president" once it ends, without this file needing to change either way.
 */
export async function updateTaskService(actor: ActorMeta, input: UpdateTaskInput) {
  const task = await db.task.findFirst({
    where: { id: input.taskId, deletedAt: null },
    select: {
      id: true,
      number: true,
      title: true,
      description: true,
      priority: true,
      dueAt: true,
      startAt: true,
      estimateHours: true,
      labels: true,
      entityType: true,
      entityId: true,
      status: true,
      assigneeId: true,
      createdById: true,
    },
  });
  if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "That task no longer exists." });

  const isCreator = actor.actorId === task.createdById;
  const isEa = actor.permissions?.has("admin.manage_users") ?? false;
  if (!isCreator && !isEa) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Only whoever raised ${task.number}, or EA, can edit it.`,
    });
  }

  if (CLOSED_STATUSES.includes(task.status as TaskStatus)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${task.number} is ${task.status}. Editing finished work changes the record of what was actually done.`,
    });
  }

  const merged = {
    title: input.title !== undefined ? input.title : task.title,
    entityType: task.entityType,
    entityId: task.entityId,
    dueAt: input.dueAt !== undefined ? input.dueAt : task.dueAt,
    startAt: input.startAt !== undefined ? input.startAt : task.startAt,
    estimateHours:
      input.estimateHours !== undefined
        ? input.estimateHours
        : task.estimateHours === null
          ? null
          : Number(task.estimateHours),
  };
  const check = checkTask(merged);
  if (!check.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: check.errors.join(" ") });
  }

  await db.$transaction(async (tx) => {
    await tx.task.update({
      where: { id: task.id },
      data: {
        title: merged.title.trim(),
        description:
          input.description !== undefined ? input.description?.trim() || null : undefined,
        priority: input.priority ?? undefined,
        dueAt: input.dueAt !== undefined ? input.dueAt : undefined,
        startAt: input.startAt !== undefined ? input.startAt : undefined,
        estimateHours:
          input.estimateHours !== undefined ? (input.estimateHours?.toFixed(2) ?? null) : undefined,
        labels: input.labels ?? undefined,
        version: { increment: 1 },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "update",
      entityType: TASK_ENTITY_TYPE,
      entityId: task.id,
      summary: `Edited ${task.number} — ${merged.title}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  if (task.assigneeId) {
    await tellAssigneeOfEdit(
      actor,
      task.id,
      task.assigneeId,
      task.number,
      merged.title,
      (input.priority ?? task.priority) as TaskPriority,
    );
  }

  return { id: task.id };
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

/** The shape every task list on a screen reads. `createdById` is here so a screen can decide
 *  whether to offer editing — only the task's creator, or EA, may (`updateTaskService`). */
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
  createdById: string;
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
      createdById: true,
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
      createdById: true,
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
      createdById: true,
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

const ARCHIVE_SORTABLE = new Set(["completedAt", "number", "title"]);

export interface ArchivedTasksParams {
  search?: string;
  assigneeId?: string;
  entityType?: string;
  page?: number;
  pageSize?: number;
  sortKey?: string | null;
  sortDir?: "asc" | "desc";
}

/**
 * Finished work, kept and searchable — the company's request in one line: *"an archive of tasks
 * where all completed tasks are saved for later viewing and traceability."*
 *
 * Nothing new is stored to build this. A completed task was never deleted — `myWorkService` and
 * `listTasksService`'s default "open" filter simply stop showing it, because a list of what's owed
 * is not the place for what's already done. This reads the exact same rows from the other side:
 * `status: "done"` specifically, not every closed status — a cancelled task was abandoned, not
 * completed, and stays reachable through `/tasks`' own status filter rather than being folded in
 * here and blurring the two.
 *
 * Paginated and searchable on purpose, unlike the working lists: an open-work list stays small by
 * definition — it is what's outstanding — but an archive only grows, and "traceability" means being
 * able to find one task in a thousand months later, not just look at the most recent fifty.
 *
 * **Scoped per person, at the company's later instruction (2026-09-01):** *"archived tasks should
 * be viewed only by the assigned person, the person that created that task, EA, and KJ."* Enforced
 * here rather than only in the router, because the restriction is about which *rows* a query
 * returns, not whether the screen may be opened at all — everyone can still open `/tasks/archive`
 * (`task.view`), and a query with no matches for them looks the same as an empty archive rather
 * than a 403 explaining why they cannot see somebody else's finished work.
 */
export async function archivedTasksService(
  viewer: { id: string; email: string },
  params: ArchivedTasksParams = {},
) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 25));
  const search = params.search?.trim();

  const where: Prisma.TaskWhereInput = {
    deletedAt: null,
    status: "done",
    ...(params.assigneeId ? { assigneeId: params.assigneeId } : {}),
    ...(params.entityType ? { entityType: params.entityType } : {}),
    /*
      Search's own OR and the visibility scope's own OR are combined through AND rather than
      spread into the same object — two top-level `OR` keys on one Prisma where-input would not
      merge, the second would silently overwrite the first, and "search" would stop working for
      anybody it was scoping at the same time.
    */
    AND: [
      ...(search
        ? [
            {
              OR: [
                { title: { contains: search, mode: "insensitive" as const } },
                { number: { contains: search, mode: "insensitive" as const } },
                { description: { contains: search, mode: "insensitive" as const } },
              ],
            },
          ]
        : []),
      ...(canSeeEveryArchivedTask(viewer.email)
        ? []
        : [{ OR: [{ assigneeId: viewer.id }, { createdById: viewer.id }] }]),
    ],
  };

  const sortKey =
    params.sortKey && ARCHIVE_SORTABLE.has(params.sortKey) ? params.sortKey : "completedAt";
  const sortDir = params.sortDir === "asc" ? "asc" : "desc";

  const [tasks, total] = await Promise.all([
    db.task.findMany({
      where,
      orderBy: { [sortKey]: sortDir },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        number: true,
        title: true,
        description: true,
        priority: true,
        assigneeId: true,
        entityType: true,
        entityId: true,
        labels: true,
        createdById: true,
        createdAt: true,
        completedAt: true,
      },
    }),
    db.task.count({ where }),
  ]);

  const names = await namesFor([
    ...tasks.map((task) => task.assigneeId),
    ...tasks.map((task) => task.createdById),
  ]);

  return {
    rows: tasks.map((task) => ({
      ...task,
      assigneeName: task.assigneeId ? (names.get(task.assigneeId) ?? "somebody") : null,
      createdByName: names.get(task.createdById) ?? "somebody",
    })),
    total,
  };
}

/** Who a task can be given to. Active users only — an inactive one owes nothing. */
export async function assignableUsersService() {
  return db.user.findMany({
    where: { isActive: true, deletedAt: null },
    select: { id: true, name: true, jobTitle: true },
    orderBy: { name: "asc" },
  });
}
