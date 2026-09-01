import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import {
  DEFAULT_COLUMNS,
  checkBoard,
  columnFor,
  compareCards,
  isClosed,
  laneFor,
  matchesFilter,
  wipFor,
  type BoardColumn,
  type BoardFilterRule,
  type BoardType,
  type SwimlaneBy,
} from "@/server/core/collab/board-rules";
import { daysLate, urgencyFor } from "@/server/core/collab/task-rules";

/**
 * §2's boards.
 *
 * ## The one idea worth holding
 *
 * A **manual** board is a place; a **smart** board is a question. Nothing is ever placed on a smart
 * board, which is what §2 means by *"stay current without a human maintaining them"* — and it is why
 * the view is resolved here rather than read straight out of the table. Reading rows would work for
 * one kind of board and silently return nothing for the other.
 *
 * ## Why a move writes the status
 *
 * Dragging a card to **In progress** and then having to open it and set its status would make the
 * board a second place to record the same fact, which is how two records of the same thing start
 * disagreeing. A column carries the status it stands for, and the move sets it.
 */

export const BOARD_ENTITY_TYPE = "Board";

/** The name shown for the one board `/boards` provisions on its own. Not how it is found — see
 *  `Board.isDefault`'s comment — only what it is called until somebody renames it. */
export const DEFAULT_BOARD_NAME = "Task board";

/**
 * The board `/boards` shows without anybody having to make one first (2026-09-02, the company's own
 * instruction: *"repurpose the board to display the different states the raised tasks are in"*).
 *
 * A smart board with an empty filter — `matchesFilter({}, ...)` is true for every task — over the
 * default five-status columns, so opening Boards is immediately the answer to "what state is
 * everything in", the same view `checkBoard`'s comment on `DEFAULT_COLUMNS` already describes as
 * "§2's status list read left to right." Lazily created and self-healing: if it is ever deleted,
 * the next visit makes another one rather than the page breaking.
 */
export async function ensureDefaultBoardService(actor: ActorMeta): Promise<{ id: string }> {
  const existing = await db.board.findFirst({
    where: { isDefault: true, deletedAt: null },
    select: { id: true },
  });
  if (existing) return existing;

  const created = await db.board.create({
    data: {
      name: DEFAULT_BOARD_NAME,
      type: "smart",
      ownerId: actor.actorId,
      isPrivate: false,
      isDefault: true,
      columns: DEFAULT_COLUMNS as unknown as Prisma.InputJsonValue,
      filterRule: {} as Prisma.InputJsonValue,
      swimlaneBy: "none",
    },
    select: { id: true },
  });
  return created;
}

const asColumns = (value: unknown): BoardColumn[] =>
  Array.isArray(value) ? (value as unknown as BoardColumn[]) : DEFAULT_COLUMNS;

const asLimits = (value: unknown): Record<string, number> | null =>
  value && typeof value === "object" ? (value as Record<string, number>) : null;

const asRule = (value: unknown): BoardFilterRule | null =>
  value && typeof value === "object" ? (value as BoardFilterRule) : null;

interface BoardInput {
  name: string;
  type?: BoardType;
  isPrivate?: boolean;
  columns?: BoardColumn[];
  wipLimits?: Record<string, number> | null;
  filterRule?: BoardFilterRule | null;
  swimlaneBy?: SwimlaneBy;
}

export async function createBoardService(actor: ActorMeta, input: BoardInput) {
  const type = input.type ?? "manual";
  const columns = input.columns ?? DEFAULT_COLUMNS;
  const check = checkBoard({
    name: input.name,
    type,
    columns,
    filterRule: input.filterRule ?? null,
    wipLimits: input.wipLimits ?? null,
  });
  if (!check.ok) throw new TRPCError({ code: "BAD_REQUEST", message: check.errors.join(" ") });

  const board = await db.$transaction(async (tx) => {
    const created = await tx.board.create({
      data: {
        name: input.name.trim(),
        type,
        ownerId: actor.actorId,
        isPrivate: input.isPrivate ?? false,
        columns: columns as unknown as Prisma.InputJsonValue,
        wipLimits: (input.wipLimits ?? undefined) as Prisma.InputJsonValue | undefined,
        filterRule: (input.filterRule ?? undefined) as Prisma.InputJsonValue | undefined,
        swimlaneBy: input.swimlaneBy ?? "none",
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "create",
      entityType: BOARD_ENTITY_TYPE,
      entityId: created.id,
      summary: `Created the ${type} board "${created.name}"`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return created;
  });

  return { id: board.id, name: board.name };
}

export async function updateBoardService(
  actor: ActorMeta,
  input: { boardId: string } & Partial<BoardInput>,
) {
  const board = await db.board.findFirst({
    where: { id: input.boardId, deletedAt: null },
    select: {
      id: true,
      name: true,
      type: true,
      ownerId: true,
      columns: true,
      wipLimits: true,
      filterRule: true,
      isPrivate: true,
    },
  });
  if (!board) throw new TRPCError({ code: "NOT_FOUND", message: "That board no longer exists." });

  const next = {
    name: input.name ?? board.name,
    type: (input.type ?? board.type) as BoardType,
    columns: input.columns ?? asColumns(board.columns),
    wipLimits: input.wipLimits === undefined ? asLimits(board.wipLimits) : input.wipLimits,
    filterRule: input.filterRule === undefined ? asRule(board.filterRule) : input.filterRule,
  };

  const check = checkBoard(next);
  if (!check.ok) throw new TRPCError({ code: "BAD_REQUEST", message: check.errors.join(" ") });

  await db.$transaction(async (tx) => {
    await tx.board.update({
      where: { id: board.id },
      data: {
        name: next.name.trim(),
        type: next.type,
        columns: next.columns as unknown as Prisma.InputJsonValue,
        wipLimits: (next.wipLimits ?? Prisma.DbNull) as Prisma.InputJsonValue,
        filterRule: (next.filterRule ?? Prisma.DbNull) as Prisma.InputJsonValue,
        ...(input.swimlaneBy ? { swimlaneBy: input.swimlaneBy } : {}),
        ...(input.isPrivate === undefined ? {} : { isPrivate: input.isPrivate }),
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "update",
      entityType: BOARD_ENTITY_TYPE,
      entityId: board.id,
      summary: `Changed the board "${next.name}"`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { id: board.id };
}

/**
 * Boards this person can open.
 *
 * A private board is its owner's alone; everything else is the company's. Deliberately not a
 * sharing model with per-board membership — §2 asks for a flag, and a permissions system nobody
 * asked for is a permissions system nobody maintains.
 */
export async function boardsService(viewerId: string) {
  const boards = await db.board.findMany({
    where: { deletedAt: null, OR: [{ isPrivate: false }, { ownerId: viewerId }] },
    orderBy: [{ type: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      type: true,
      ownerId: true,
      isPrivate: true,
      isDefault: true,
      columns: true,
      swimlaneBy: true,
    },
  });

  return boards.map((board) => ({
    ...board,
    columns: asColumns(board.columns),
    isMine: board.ownerId === viewerId,
  }));
}

export interface BoardCard {
  id: string;
  number: string;
  title: string;
  status: string;
  priority: string;
  dueAt: Date | null;
  daysLate: number | null;
  urgency: string;
  assigneeId: string | null;
  assigneeName: string | null;
  entityType: string | null;
  entityId: string | null;
  labels: string[];
  fromTemplate: boolean;
  position: number;
  columnKey: string;
  laneKey: string;
  laneLabel: string;
}

/**
 * One board, resolved.
 *
 * `includeDone` is off by default. A "Done" column that accumulates every task the company has ever
 * finished is a scrollbar, not information — but the column stays visible, because a board whose
 * last column is missing looks broken rather than tidy.
 */
export async function boardViewService(
  viewerId: string,
  input: { boardId: string; includeDone?: boolean },
) {
  const board = await db.board.findFirst({
    where: { id: input.boardId, deletedAt: null },
    select: {
      id: true,
      name: true,
      type: true,
      ownerId: true,
      isPrivate: true,
      columns: true,
      wipLimits: true,
      filterRule: true,
      swimlaneBy: true,
    },
  });
  if (!board) throw new TRPCError({ code: "NOT_FOUND", message: "That board no longer exists." });
  if (board.isPrivate && board.ownerId !== viewerId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "That board is private to its owner." });
  }

  const columns = asColumns(board.columns);
  const wipLimits = asLimits(board.wipLimits);
  const rule = asRule(board.filterRule);
  const type = board.type as BoardType;

  /*
    A manual board reads its own cards; a smart board reads every open task and asks its question.

    The smart read is capped. A filter that matches everything would otherwise pull the whole table
    into memory to render two hundred cards nobody can look at — and a board that takes eight seconds
    is a board people stop opening.
  */
  const tasks = await db.task.findMany({
    where: {
      deletedAt: null,
      ...(type === "manual" ? { boardId: board.id } : {}),
      ...(input.includeDone ? {} : { status: { notIn: ["done", "cancelled"] } }),
    },
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      priority: true,
      dueAt: true,
      assigneeId: true,
      entityType: true,
      entityId: true,
      labels: true,
      createdByTemplate: true,
      columnId: true,
      position: true,
    },
    take: 500,
  });

  const now = new Date();
  const matching =
    type === "smart" && rule
      ? tasks.filter((task) => matchesFilter(rule, task, viewerId, now))
      : tasks;

  const names = new Map<string, string>();
  const assigneeIds = [
    ...new Set(matching.map((task) => task.assigneeId).filter((id): id is string => !!id)),
  ];
  if (assigneeIds.length > 0) {
    const users = await db.user.findMany({
      where: { id: { in: assigneeIds } },
      select: { id: true, name: true },
    });
    for (const user of users) names.set(user.id, user.name);
  }

  const swimlaneBy = board.swimlaneBy as SwimlaneBy;
  const cards: BoardCard[] = [];
  for (const task of matching) {
    const columnKey = columnFor(columns, task, type);
    // A task whose status no column stands for would otherwise vanish from a board it is on. It is
    // dropped into the first column instead, where somebody can see it and move it.
    const resolved = columnKey ?? columns[0]?.key ?? null;
    if (!resolved) continue;

    const lane = laneFor(swimlaneBy, task, (id) => names.get(id) ?? "somebody");
    cards.push({
      id: task.id,
      number: task.number,
      title: task.title,
      status: task.status,
      priority: task.priority,
      dueAt: task.dueAt,
      daysLate: daysLate(task.dueAt, now),
      urgency: urgencyFor(task.dueAt, task.status, now),
      assigneeId: task.assigneeId,
      assigneeName: task.assigneeId ? (names.get(task.assigneeId) ?? "somebody") : null,
      entityType: task.entityType,
      entityId: task.entityId,
      labels: task.labels,
      fromTemplate: !!task.createdByTemplate,
      position: task.position,
      columnKey: resolved,
      laneKey: lane.key,
      laneLabel: lane.label,
    });
  }

  cards.sort(compareCards);

  const lanes =
    swimlaneBy === "none"
      ? [{ key: "all", label: "" }]
      : [...new Map(cards.map((card) => [card.laneKey, card.laneLabel])).entries()]
          .map(([key, label]) => ({ key, label }))
          .sort((a, b) => a.label.localeCompare(b.label));

  return {
    id: board.id,
    name: board.name,
    type,
    swimlaneBy,
    isPrivate: board.isPrivate,
    isMine: board.ownerId === viewerId,
    columns: columns.map((column) => ({
      ...column,
      wip: wipFor(
        column.key,
        cards.filter((card) => card.columnKey === column.key).length,
        wipLimits,
      ),
    })),
    cards,
    /*
      The lanes §2 asks for, resolved here rather than on the screen.

      Only lanes with something in them are returned: a lane per person, over a company of nine,
      would otherwise be eight empty rows and one with work in it.
    */
    lanes,
    /*
      Said out loud when a smart board is empty.

      An empty smart board and a broken one look identical, and this platform has a standing rule
      that a screen which can be empty must say why it is.
    */
    emptyBecause:
      cards.length > 0
        ? null
        : type === "smart"
          ? "Nothing matches this board's filter right now."
          : "Nothing has been put on this board yet.",
    hidingDone: !input.includeDone,
  };
}

/**
 * Moving a card.
 *
 * Refused on a smart board — there is nowhere to move a card *to* when placement is not what decides
 * where it sits. Allowing it would move the card, change nothing on screen, and teach somebody that
 * the board is broken.
 */
export async function moveCardService(
  actor: ActorMeta,
  input: { taskId: string; boardId: string; columnKey: string; position?: number },
) {
  const [board, task] = await Promise.all([
    db.board.findFirst({
      where: { id: input.boardId, deletedAt: null },
      select: { id: true, name: true, type: true, columns: true },
    }),
    db.task.findFirst({
      where: { id: input.taskId, deletedAt: null },
      select: { id: true, number: true, status: true, columnId: true, boardId: true },
    }),
  ]);

  if (!board) throw new TRPCError({ code: "NOT_FOUND", message: "That board no longer exists." });
  if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "That task no longer exists." });

  if (board.type === "smart") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `"${board.name}" is a smart board: what is on it is decided by its filter, not by where ` +
        `cards are put. Change the task instead and it will move itself.`,
    });
  }

  const columns = asColumns(board.columns);
  const column = columns.find((candidate) => candidate.key === input.columnKey);
  if (!column) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That column is not on this board." });
  }

  // The column carries the status it stands for, so the drag is the status change. A board that
  // needed a second edit afterwards would be a second record of the same fact.
  const nextStatus = column.statuses?.[0] ?? task.status;

  await db.$transaction(async (tx) => {
    await tx.task.update({
      where: { id: task.id },
      data: {
        boardId: board.id,
        columnId: column.key,
        position: input.position ?? 0,
        status: nextStatus,
        completedAt: nextStatus === "done" ? new Date() : isClosed(nextStatus) ? undefined : null,
        version: { increment: 1 },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "update",
      entityType: "Task",
      entityId: task.id,
      summary: `Moved ${task.number} to ${column.label} on "${board.name}"`,
      diff:
        nextStatus === task.status ? undefined : { status: { from: task.status, to: nextStatus } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { columnKey: column.key, status: nextStatus };
}

/** Taking a card off a board without deleting the work. */
export async function removeCardService(actor: ActorMeta, input: { taskId: string }) {
  const task = await db.task.findFirst({
    where: { id: input.taskId, deletedAt: null },
    select: { id: true, number: true, boardId: true },
  });
  if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "That task no longer exists." });

  await db.$transaction(async (tx) => {
    await tx.task.update({
      where: { id: task.id },
      data: { boardId: null, columnId: null, position: 0, version: { increment: 1 } },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "update",
      entityType: "Task",
      entityId: task.id,
      // Said precisely, because "removed" reads like a deletion and this is not one.
      summary: `Took ${task.number} off its board. The task itself is untouched.`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { taskId: task.id };
}

/** Open tasks not on this board, for the "put something on it" picker. */
export async function placeableTasksService(input: { boardId: string }) {
  return db.task.findMany({
    where: {
      deletedAt: null,
      status: { notIn: ["done", "cancelled"] },
      OR: [{ boardId: null }, { boardId: { not: input.boardId } }],
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, number: true, title: true, status: true, assigneeId: true },
  });
}

export async function deleteBoardService(actor: ActorMeta, input: { boardId: string }) {
  const board = await db.board.findFirst({
    where: { id: input.boardId, deletedAt: null },
    select: { id: true, name: true, type: true },
  });
  if (!board) throw new TRPCError({ code: "NOT_FOUND", message: "That board no longer exists." });

  await db.$transaction(async (tx) => {
    await tx.board.update({
      where: { id: board.id },
      data: { deletedAt: new Date() },
    });
    /*
      The cards are freed, not deleted.

      A board is a way of looking at work. Deleting one must not delete the work — and leaving the
      tasks pointing at a board that no longer exists would strand them where no board shows them
      and My Work still would.
    */
    await tx.task.updateMany({
      where: { boardId: board.id },
      data: { boardId: null, columnId: null },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "delete",
      entityType: BOARD_ENTITY_TYPE,
      entityId: board.id,
      summary: `Deleted the board "${board.name}". Its tasks were taken off it, not deleted.`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { id: board.id };
}
