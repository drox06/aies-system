/**
 * §2's task rules — pure, so the screen and the server never disagree about what a task is.
 *
 * On `UI_SAFE_SERVER_MODULES` in eslint.config.mjs. No Prisma, no node builtins.
 */

export const TASK_STATUSES = [
  "todo",
  "in_progress",
  "blocked",
  "for_review",
  "done",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  for_review: "For review",
  done: "Done",
  cancelled: "Cancelled",
};

/** Statuses that mean nobody owes anything further. */
export const CLOSED_STATUSES: readonly TaskStatus[] = ["done", "cancelled"];

export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

/**
 * The records a task may hang off.
 *
 * §2 names seven. Kept as a list rather than left open, because an `entityType` nobody recognises
 * produces a task whose link goes nowhere — and the whole argument of this module is that a task
 * belongs to a record.
 */
export const TASK_ENTITY_TYPES = [
  "Inquiry",
  "Quotation",
  "SalesOrder",
  "Ticket",
  "Project",
  "CashAdvance",
  "MaterialRequest",
  // §6's meetings. Added when action items became real tasks: an item agreed in a meeting has to
  // be able to point back at the meeting it was agreed in, or the task arrives with no context and
  // the minutes have no trace of what came of them.
  "Meeting",
] as const;
export type TaskEntityType = (typeof TASK_ENTITY_TYPES)[number];

/** Where a task's record lives, so a link can be rendered without every screen knowing the map. */
export const TASK_ENTITY_HREF: Record<TaskEntityType, (id: string) => string> = {
  Inquiry: (id) => `/crm/inquiries/${id}`,
  Quotation: (id) => `/quotations/${id}`,
  SalesOrder: (id) => `/sales-orders/${id}`,
  Ticket: (id) => `/tickets/${id}`,
  Project: (id) => `/projects/${id}`,
  CashAdvance: (id) => `/cash-advances/${id}`,
  MaterialRequest: (id) => `/material-requests/${id}`,
  Meeting: (id) => `/meetings/${id}`,
};

export function isTaskEntityType(value: string): value is TaskEntityType {
  return (TASK_ENTITY_TYPES as readonly string[]).includes(value);
}

export interface TaskInput {
  title: string;
  entityType?: string | null;
  entityId?: string | null;
  dueAt?: Date | null;
  startAt?: Date | null;
  estimateHours?: number | null;
}

export interface TaskCheck {
  ok: boolean;
  errors: string[];
}

/**
 * Whether a task can be created as described.
 *
 * ## What is deliberately not required
 *
 * **An assignee.** §2's own trigger table creates tasks before anybody has picked them up, and a
 * platform that refused an unassigned task would force a wrong name onto it — which is worse than
 * an empty one, because a wrong owner looks like an answer.
 *
 * **A due date.** Same reasoning. "Book the Christmas party" has no deadline and is still work.
 * What the platform does instead is show undated tasks last rather than pretending they are urgent.
 */
export function checkTask(input: TaskInput): TaskCheck {
  const errors: string[] = [];

  const title = input.title.trim();
  if (title.length < 3) {
    errors.push("Give the task a title somebody else would understand.");
  }

  /*
    Both halves of the link, or neither.

    A type with no id points at nothing; an id with no type cannot be resolved to a screen. Either
    on its own is a link that looks real and goes nowhere, which is worse than an unattached task.
  */
  const hasType = !!input.entityType;
  const hasId = !!input.entityId;
  if (hasType !== hasId) {
    errors.push("A task is attached to a whole record or to none — not to half of one.");
  }
  if (hasType && input.entityType && !isTaskEntityType(input.entityType)) {
    errors.push(`"${input.entityType}" is not a kind of record a task can be attached to.`);
  }

  if (input.dueAt && input.startAt && input.dueAt < input.startAt) {
    errors.push("It cannot be due before it starts.");
  }

  if (input.estimateHours !== null && input.estimateHours !== undefined) {
    if (input.estimateHours <= 0) {
      errors.push("An estimate of nothing is not an estimate. Leave it blank instead.");
    }
    if (input.estimateHours > 500) {
      errors.push("Over 500 hours is a project, not a task. Break it up.");
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * How late a task is, in whole days.
 *
 * Null when it has no due date — **not zero**. A task nobody set a deadline for is not on time; it
 * is undated, and reporting it as on time would let a screen sort it among the healthy ones. Same
 * rule this platform applies to a warranty window nobody entered.
 *
 * Negative means days remaining. Callers that only care about lateness check `> 0`.
 */
export function daysLate(dueAt: Date | null | undefined, now: Date = new Date()): number | null {
  if (!dueAt) return null;

  const startOfDay = (date: Date) =>
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

  return Math.round((startOfDay(now) - startOfDay(new Date(dueAt))) / (24 * 60 * 60 * 1000));
}

export type TaskUrgency = "overdue" | "today" | "soon" | "later" | "undated";

/**
 * How loudly a row should read on My Work.
 *
 * `undated` is its own state rather than being folded into `later`, because the two call for
 * different actions: one needs doing eventually, the other needs a date agreeing with somebody.
 */
export function urgencyFor(
  dueAt: Date | null | undefined,
  status: string,
  now: Date = new Date(),
): TaskUrgency {
  if (CLOSED_STATUSES.includes(status as TaskStatus)) return "later";

  const late = daysLate(dueAt, now);
  if (late === null) return "undated";
  if (late > 0) return "overdue";
  if (late === 0) return "today";
  if (late >= -3) return "soon";
  return "later";
}

/**
 * The order My Work reads in.
 *
 * Overdue first and oldest-overdue at the very top, then today, then soon, then everything dated,
 * then the undated. Undated last on purpose: they are the ones nobody has committed to, and putting
 * them among dated work is how a list stops being a plan.
 *
 * Priority breaks ties within a band rather than overriding the bands. An urgent task due next month
 * is not more pressing than a normal one that was due last Tuesday — treating it as such is how a
 * queue fills with things marked urgent by whoever shouted loudest.
 */
const URGENCY_ORDER: Record<TaskUrgency, number> = {
  overdue: 0,
  today: 1,
  soon: 2,
  later: 3,
  undated: 4,
};

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export function compareForMyWork(
  a: { dueAt: Date | null; status: string; priority: string },
  b: { dueAt: Date | null; status: string; priority: string },
  now: Date = new Date(),
): number {
  const bandA = URGENCY_ORDER[urgencyFor(a.dueAt, a.status, now)];
  const bandB = URGENCY_ORDER[urgencyFor(b.dueAt, b.status, now)];
  if (bandA !== bandB) return bandA - bandB;

  const lateA = daysLate(a.dueAt, now);
  const lateB = daysLate(b.dueAt, now);
  if (lateA !== null && lateB !== null && lateA !== lateB) return lateB - lateA;

  const prioA = PRIORITY_ORDER[a.priority as TaskPriority] ?? 2;
  const prioB = PRIORITY_ORDER[b.priority as TaskPriority] ?? 2;
  return prioA - prioB;
}

/**
 * Whether a status change is allowed.
 *
 * Deliberately permissive: §2 describes a board people drag cards around on, and a state machine
 * that refused "back to in progress" would be fighting the way the tool is used. The two rules that
 * do hold are about *finishing*, because a completed task is a claim that work happened.
 */
export function checkStatusChange(from: string, to: string): TaskCheck {
  const errors: string[] = [];

  if (!(TASK_STATUSES as readonly string[]).includes(to)) {
    errors.push(`"${to}" is not a task status.`);
    return { ok: false, errors };
  }

  // Reopening a cancelled task hides why it was cancelled. Raise a new one instead — the old one
  // stays as the record that this was considered and dropped.
  if (from === "cancelled" && to !== "cancelled") {
    errors.push(
      "A cancelled task is not reopened — raise a new one, so the reason this was dropped survives.",
    );
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Who sees every archived task, not just the ones they raised or were assigned — the company's own
 * instruction (2026-09-01): *"archived tasks should be viewed only by the assigned person, the
 * person that created that task, EA, and KJ."*
 *
 * Checked by email rather than by the `president`/`vice_president` roles those two names would
 * otherwise map to. The practice grant running for the walkthrough (`scripts/practice-authority.ts`)
 * currently gives all five named users the `president` role, so a role check would not actually
 * restrict anything until practice ends — the two emails are the only thing that means "EA and KJ
 * specifically" right now. Once practice ends this and a role check become equivalent; this stays
 * correct either way and needs no revisiting when that happens.
 */
export const ARCHIVE_FULL_ACCESS_EMAILS = ["ea@aieselectromech.com", "kj@aieselectromech.com"];

export function canSeeEveryArchivedTask(email: string): boolean {
  return ARCHIVE_FULL_ACCESS_EMAILS.includes(email.trim().toLowerCase());
}
