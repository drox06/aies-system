import type { TaskPriority } from "@/server/core/collab/task-rules";

/**
 * §2's task templates — the shapes and the rules, with no database and no Prisma.
 *
 * On `UI_SAFE_SERVER_MODULES`, because the templates screen shows what each one will do and must not
 * describe it differently from the code that does it.
 */

/**
 * How a template picks a person when a role has several holders (§2).
 *
 * The company settled the defaults on 2026-08-20: **all** for anything that is an approval,
 * **least-loaded** for crew work, **all** elsewhere.
 */
export const ASSIGN_MODES = ["all", "round_robin", "least_loaded"] as const;
export type AssignMode = (typeof ASSIGN_MODES)[number];

export const ASSIGN_MODE_LABELS: Record<AssignMode, string> = {
  all: "Everyone who holds the role",
  round_robin: "In turn",
  least_loaded: "Whoever is carrying least",
};

export const ASSIGN_MODE_EXPLANATIONS: Record<AssignMode, string> = {
  all:
    "One task each, to every holder of the role. Right for approvals: the first person free acts, " +
    "and nothing waits on one named individual being at their desk.",
  round_robin:
    "One task, to whoever has gone longest without getting one from this template. Not a stored " +
    "counter — a counter drifts when somebody is on leave and nobody notices.",
  least_loaded:
    "One task, to whoever has fewest open tasks right now. Counts tasks, not effort or hours: the " +
    "platform does not know how hard a job is, and pretending otherwise would be a worse guess " +
    "than counting.",
};

/** One line of a template: a task that will be raised, and who it goes to. */
export interface TaskSpec {
  /** Stable within the template. Half of the idempotency handle written to `createdByTemplate`. */
  key: string;
  title: string;
  description?: string;
  /**
   * Who the task is for.
   *
   * `role` — anybody active holding one of `roleKeys`, picked by `assignMode`. The default.
   *
   * `record_owner` — the one person the record itself names: the requester of a cash advance, the
   * lead on a ticket. §2 asks for exactly this in two places, and a role cannot express it —
   * putting somebody else's spending on a colleague's list is not the same task. `roleKeys` is
   * still required and is the fallback for when the record names nobody.
   */
  assignTo?: "role" | "record_owner";
  /** Role keys from `prisma/seed.ts`. Everybody active holding any of them is a candidate. */
  roleKeys: string[];
  assignMode: AssignMode;
  priority?: TaskPriority;
  /**
   * Working days from the anchor. Business days rather than calendar days throughout, because a
   * task raised at five on a Friday and due "+1d" is not due on Saturday — the platform already
   * counts approval escalation this way.
   */
  dueInDays?: number;
  /**
   * Which date the offset counts from.
   *
   * `event` is the default and means "when this happened". The others read a date **off the record
   * itself**, because §2 has rows whose deadline is not an offset at all — a cash advance is needed
   * by the date the requester wrote down, and an advance is liquidated against its own due date.
   * Falling back to the event when the record has no such date would silently invent a deadline.
   */
  dueFrom?: "event" | "neededBy" | "liquidationDue";
}

export interface TaskTemplateSpec {
  key: string;
  name: string;
  trigger: string;
  condition?: Record<string, string> | null;
  tasks: TaskSpec[];
}

/**
 * Whether a payload satisfies a template's condition.
 *
 * String equality on named fields, deliberately — the conditions §2 needs are "which kind of ticket"
 * and "did commissioning pass". A general expression language here would be a second thing to learn
 * and a place for a template to fail silently.
 *
 * An absent field does **not** match. `{ result: "accepted" }` against a payload with no `result`
 * means the platform cannot tell whether commissioning was accepted, and raising close-out work on a
 * guess is worse than raising none.
 */
export function conditionMatches(
  condition: Record<string, string> | null | undefined,
  values: Record<string, unknown>,
): boolean {
  if (!condition) return true;
  return Object.entries(condition).every(([field, expected]) => {
    const actual = values[field];
    return typeof actual === "string" && actual === expected;
  });
}

/** The idempotency handle a created task carries. Retried events must not double the work. */
export function templateStamp(templateKey: string, taskKey: string): string {
  return `${templateKey}:${taskKey}`;
}

export function parseStamp(stamp: string | null | undefined): {
  templateKey: string;
  taskKey: string;
} | null {
  if (!stamp) return null;
  const at = stamp.indexOf(":");
  if (at < 1) return null;
  return { templateKey: stamp.slice(0, at), taskKey: stamp.slice(at + 1) };
}

export interface TemplateCheck {
  ok: boolean;
  errors: string[];
}

/**
 * Whether a template is well-formed.
 *
 * Run over the seeds by a test rather than at creation time, because the seeds are the only source
 * of templates today. What it is really guarding is the pair of silent failures: a task with no role
 * can reach nobody, and two lines sharing a key would collapse into one through the idempotency
 * check — the second would look created and never exist.
 */
export function checkTemplate(template: TaskTemplateSpec): TemplateCheck {
  const errors: string[] = [];

  if (!template.key.trim()) errors.push("A template needs a key.");
  if (!template.trigger.includes(".")) {
    errors.push(`"${template.trigger}" is not an event name.`);
  }
  if (template.tasks.length === 0) {
    errors.push(`${template.key} creates no tasks, so firing it does nothing.`);
  }

  const seen = new Set<string>();
  for (const task of template.tasks) {
    if (seen.has(task.key)) {
      errors.push(
        `${template.key} has two tasks keyed "${task.key}". The second would be treated as a ` +
          `duplicate of the first and never created.`,
      );
    }
    seen.add(task.key);

    if (task.roleKeys.length === 0) {
      errors.push(`${template.key}/${task.key} names no role, so it would reach nobody.`);
    }
    if (!(ASSIGN_MODES as readonly string[]).includes(task.assignMode)) {
      errors.push(`${template.key}/${task.key} has assignment mode "${task.assignMode}".`);
    }
    if (task.dueInDays !== undefined && task.dueInDays < 0) {
      errors.push(`${template.key}/${task.key} is due before the thing that raises it.`);
    }
    if (task.title.trim().length < 3) {
      errors.push(`${template.key}/${task.key} has no usable title.`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Which candidate gets the task.
 *
 * Pure so both modes can be tested without a database — the load figures and the last-assigned
 * timestamps are gathered by the service and handed in.
 *
 * `all` is not here: it needs no choosing, and the service raises one task per candidate.
 */
export interface Candidate {
  id: string;
  /** Open tasks assigned to them right now, across every template and every module. */
  openTasks: number;
  /** When this template last gave them something. Null means never. */
  lastAssignedAt: Date | null;
}

export function chooseAssignee(mode: AssignMode, candidates: Candidate[]): string[] {
  if (candidates.length === 0) return [];
  if (mode === "all") return candidates.map((candidate) => candidate.id);

  if (mode === "least_loaded") {
    // Ties broken by id so the choice is reproducible. Two people with an empty queue would
    // otherwise depend on row order, and a test that pins today's order would pin nothing.
    const sorted = [...candidates].sort(
      (a, b) => a.openTasks - b.openTasks || a.id.localeCompare(b.id),
    );
    return [sorted[0]!.id];
  }

  /*
    Round-robin, expressed as "who has gone longest without one".

    Never assigned wins outright — somebody new to the role should not wait out a full rotation.
    Otherwise the oldest `lastAssignedAt` wins, which self-corrects: a person away for a fortnight
    comes back at the front of the queue rather than having silently kept their slot, and a counter
    that would have drifted while they were away does not exist to drift.
  */
  const sorted = [...candidates].sort((a, b) => {
    if (!a.lastAssignedAt && !b.lastAssignedAt) return a.id.localeCompare(b.id);
    if (!a.lastAssignedAt) return -1;
    if (!b.lastAssignedAt) return 1;
    return a.lastAssignedAt.getTime() - b.lastAssignedAt.getTime() || a.id.localeCompare(b.id);
  });
  return [sorted[0]!.id];
}
