import {
  CLOSED_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type TaskPriority,
  type TaskStatus,
} from "@/server/core/collab/task-rules";

/**
 * §2's boards, as rules — no Prisma, no database.
 *
 * On `UI_SAFE_SERVER_MODULES`: the board screen has to know what a column is, whether one is over
 * its WIP limit, and what a smart board's filter says, and a second copy of any of those on the
 * client is a second answer waiting to disagree with the server's.
 */

export const BOARD_TYPES = ["manual", "smart"] as const;
export type BoardType = (typeof BOARD_TYPES)[number];

export const SWIMLANE_OPTIONS = ["none", "assignee", "priority"] as const;
export type SwimlaneBy = (typeof SWIMLANE_OPTIONS)[number];

export const SWIMLANE_LABELS: Record<SwimlaneBy, string> = {
  none: "One lane",
  assignee: "A lane per person",
  priority: "A lane per priority",
};

export interface BoardColumn {
  key: string;
  label: string;
  /**
   * The statuses this column stands for.
   *
   * On a **manual** board, dropping a card here sets the first of them — so a board can move work
   * along without anybody touching a status dropdown, which is the point of a board.
   *
   * On a **smart** board it is the whole meaning of the column: nothing is placed, so a task appears
   * in the column whose statuses include its own.
   */
  statuses?: TaskStatus[];
}

/** The default board, which is §2's status list read left to right. */
export const DEFAULT_COLUMNS: BoardColumn[] = [
  { key: "todo", label: TASK_STATUS_LABELS.todo, statuses: ["todo"] },
  { key: "in_progress", label: TASK_STATUS_LABELS.in_progress, statuses: ["in_progress"] },
  { key: "blocked", label: TASK_STATUS_LABELS.blocked, statuses: ["blocked"] },
  { key: "for_review", label: TASK_STATUS_LABELS.for_review, statuses: ["for_review"] },
  { key: "done", label: TASK_STATUS_LABELS.done, statuses: ["done"] },
];

/**
 * The question a smart board asks.
 *
 * Every field is optional and they are combined with **and**. Kept small on purpose: §2 wants boards
 * that stay current without maintenance, and a filter language rich enough to express anything is
 * one nobody can read six months later.
 */
export interface BoardFilterRule {
  /** `me` resolves to whoever is looking, which is what makes "awaiting my approval" work. */
  assignee?: "me" | "anyone" | "unassigned" | string;
  statuses?: TaskStatus[];
  priorities?: TaskPriority[];
  entityTypes?: string[];
  labels?: string[];
  /** Only tasks past their due date. Undated tasks are never overdue — see `daysLate`. */
  overdueOnly?: boolean;
  /** Only tasks raised by a template, or only tasks a person raised by hand. */
  raisedBy?: "template" | "person";
}

export interface BoardCheck {
  ok: boolean;
  errors: string[];
}

export function checkBoard(input: {
  name: string;
  type: BoardType;
  columns: BoardColumn[];
  filterRule?: BoardFilterRule | null;
  wipLimits?: Record<string, number> | null;
}): BoardCheck {
  const errors: string[] = [];

  if (input.name.trim().length < 2) errors.push("Give the board a name.");

  if (input.columns.length === 0) {
    errors.push("A board with no columns has nowhere to put anything.");
  }
  if (input.columns.length > 12) {
    errors.push("Twelve columns is already more than fits on a screen.");
  }

  const seen = new Set<string>();
  for (const column of input.columns) {
    if (seen.has(column.key)) {
      // Two columns with one key: cards would appear in both and a move would be ambiguous.
      errors.push(`Two columns share the key "${column.key}".`);
    }
    seen.add(column.key);
    if (column.label.trim().length === 0) errors.push("A column needs a label.");
    for (const status of column.statuses ?? []) {
      if (!(TASK_STATUSES as readonly string[]).includes(status)) {
        errors.push(`"${status}" is not a task status.`);
      }
    }
  }

  if (input.type === "smart") {
    if (!input.filterRule) {
      // The whole definition of a smart board. Without it the board is empty forever and looks
      // broken rather than unconfigured.
      errors.push("A smart board is its filter. This one has none.");
    }
    if (input.wipLimits && Object.keys(input.wipLimits).length > 0) {
      // Nothing is placed on a smart board, so a limit could never be respected or breached by an
      // act — it would just be a number that sometimes went red for reasons nobody chose.
      errors.push("A smart board has no WIP limits: nobody puts anything on it.");
    }
  }

  if (input.type === "manual" && input.filterRule) {
    errors.push("A manual board holds what people put on it, so a filter would be ignored.");
  }

  for (const [key, limit] of Object.entries(input.wipLimits ?? {})) {
    if (!seen.has(key)) errors.push(`WIP limit set on "${key}", which is not a column.`);
    if (!Number.isInteger(limit) || limit < 1) {
      errors.push(`A WIP limit of ${limit} on "${key}" would stop the column being usable.`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** A task, as much of it as the board rules need. */
export interface BoardTask {
  id: string;
  status: string;
  priority: string;
  dueAt: Date | null;
  assigneeId: string | null;
  entityType: string | null;
  labels: string[];
  createdByTemplate: string | null;
  columnId: string | null;
}

/**
 * Whether a task answers a smart board's question.
 *
 * `viewerId` is what `assignee: "me"` means — the board is the same board for everybody and shows
 * each person their own work, which is how §2's "awaiting my approval" example reads.
 */
export function matchesFilter(
  rule: BoardFilterRule,
  task: BoardTask,
  viewerId: string,
  now: Date = new Date(),
): boolean {
  if (rule.assignee === "me" && task.assigneeId !== viewerId) return false;
  if (rule.assignee === "unassigned" && task.assigneeId !== null) return false;
  if (
    rule.assignee &&
    rule.assignee !== "me" &&
    rule.assignee !== "anyone" &&
    rule.assignee !== "unassigned" &&
    task.assigneeId !== rule.assignee
  ) {
    return false;
  }

  if (rule.statuses?.length && !rule.statuses.includes(task.status as TaskStatus)) return false;
  if (rule.priorities?.length && !rule.priorities.includes(task.priority as TaskPriority)) {
    return false;
  }
  if (rule.entityTypes?.length && !rule.entityTypes.includes(task.entityType ?? "")) return false;
  if (rule.labels?.length && !rule.labels.some((label) => task.labels.includes(label)))
    return false;

  if (rule.raisedBy === "template" && !task.createdByTemplate) return false;
  if (rule.raisedBy === "person" && task.createdByTemplate) return false;

  if (rule.overdueOnly) {
    // Undated is not overdue. A task nobody set a deadline for is uncommitted, not late — the same
    // rule `daysLate` follows, and a board that quietly counted them as late would be lying about
    // how much trouble the company is in.
    if (!task.dueAt) return false;
    if (task.dueAt.getTime() >= now.getTime()) return false;
  }

  return true;
}

/**
 * Which column a task belongs in.
 *
 * On a manual board its placement wins; a task with no placement falls to the column matching its
 * status, so work that arrives from a template appears somewhere sensible rather than nowhere.
 */
export function columnFor(columns: BoardColumn[], task: BoardTask, type: BoardType): string | null {
  if (type === "manual" && task.columnId && columns.some((c) => c.key === task.columnId)) {
    return task.columnId;
  }
  const byStatus = columns.find((column) => column.statuses?.includes(task.status as TaskStatus));
  return byStatus?.key ?? null;
}

export interface WipState {
  count: number;
  limit: number | null;
  /** Over the limit right now. */
  over: boolean;
}

/**
 * §2's WIP limits, as a state rather than a gate.
 *
 * **A move into a full column is allowed**, and this is a deliberate call rather than an omission.
 * A limit's job is to make overload visible; refusing the move would not reduce the work, it would
 * leave the card sitting in the column it has already left — and a board that disagrees with reality
 * is worse than no board, which is the failure this whole module exists to end. The column goes red
 * and says how far over it is, which is the conversation the limit was meant to start.
 */
export function wipFor(
  columnKey: string,
  count: number,
  wipLimits: Record<string, number> | null | undefined,
): WipState {
  const limit = wipLimits?.[columnKey] ?? null;
  return { count, limit, over: limit !== null && count > limit };
}

/** Cards within a column: overdue first, then by due date, then by where somebody put them. */
export function compareCards(
  a: { dueAt: Date | null; position: number },
  b: { dueAt: Date | null; position: number },
): number {
  if (a.dueAt && b.dueAt && a.dueAt.getTime() !== b.dueAt.getTime()) {
    return a.dueAt.getTime() - b.dueAt.getTime();
  }
  if (a.dueAt && !b.dueAt) return -1;
  if (!a.dueAt && b.dueAt) return 1;
  return a.position - b.position;
}

/** The swimlane a card sits in, and what that lane is called. */
export function laneFor(
  swimlaneBy: SwimlaneBy,
  task: { assigneeId: string | null; priority: string },
  nameOf: (userId: string) => string,
): { key: string; label: string } {
  if (swimlaneBy === "assignee") {
    return task.assigneeId
      ? { key: task.assigneeId, label: nameOf(task.assigneeId) }
      : { key: "unassigned", label: "Nobody yet" };
  }
  if (swimlaneBy === "priority") {
    const priority = (TASK_PRIORITIES as readonly string[]).includes(task.priority)
      ? task.priority
      : "normal";
    return { key: priority, label: priority };
  }
  return { key: "all", label: "" };
}

/** Boards hide finished work by default — a column of last month's done cards is scrollbar. */
export function isClosed(status: string): boolean {
  return CLOSED_STATUSES.includes(status as TaskStatus);
}
