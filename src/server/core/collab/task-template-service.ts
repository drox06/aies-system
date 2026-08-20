import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { addBusinessDays } from "@/server/core/calendar/business-days";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { CLOSED_STATUSES } from "@/server/core/collab/task-rules";
import { createTaskService } from "@/server/core/collab/task-service";
import {
  ASSIGN_MODE_LABELS,
  chooseAssignee,
  conditionMatches,
  templateStamp,
  type AssignMode,
  type Candidate,
  type TaskSpec,
  type TaskTemplateSpec,
} from "@/server/core/collab/task-template-rules";
import { TASK_TEMPLATE_SEEDS } from "@/server/core/collab/task-template-seeds";
import { resolverFor, type TriggerTarget } from "@/server/core/collab/task-trigger-resolvers";

/**
 * §2's templates, fired by events — *"the direct replacement for the meeting where work used to be
 * assigned verbally."*
 *
 * ## Idempotency is the whole of the difficulty
 *
 * specs/00-foundation.md §6 requires event handlers to be idempotent, and this one creates numbered
 * records that notify people. A retried `sales_order.created` must not raise a second "Acknowledge
 * the PO" or consume a second number. Every task carries `{templateKey}:{taskKey}` in
 * `createdByTemplate`, and a task with that stamp already on that record, for that person, is not
 * created again.
 *
 * It is checked per **assignee** rather than per record, because `all` mode legitimately raises the
 * same stamp several times — one per approver. Skipping on the stamp alone would give the first
 * approver a task and silently drop the rest.
 *
 * ## Failure is per task, not per event
 *
 * One template that cannot resolve must not stop the other three, and none of them may fail the job
 * that relayed the event — the sales order is already created, and rolling anything back is not on
 * offer. Failures are logged and counted, and the summary is returned so a test can assert on what
 * happened rather than on nothing having thrown.
 */

const TEMPLATE_ACTOR: ActorMeta = {
  actorId: "system",
  actorLabel: "The system, from a task template",
};

export interface TemplateRunResult {
  created: { taskId: string; number: string; templateKey: string; taskKey: string }[];
  skipped: number;
  failures: { templateKey: string; taskKey: string; reason: string }[];
}

/** The row shape as it comes back from the database, before the Json column is trusted. */
interface StoredTemplate {
  key: string;
  name: string;
  trigger: string;
  condition: unknown;
  tasks: unknown;
}

function asSpec(row: StoredTemplate): TaskTemplateSpec | null {
  if (!Array.isArray(row.tasks)) return null;
  return {
    key: row.key,
    name: row.name,
    trigger: row.trigger,
    condition: (row.condition ?? null) as Record<string, string> | null,
    tasks: row.tasks as unknown as TaskSpec[],
  };
}

/**
 * Everybody who could take this task, with the two numbers the modes need.
 *
 * Both are gathered per call rather than cached. A cached load figure is a load figure from before
 * the last three tasks were raised, and the whole point of `least_loaded` is that it reflects now.
 */
async function candidatesFor(roleKeys: string[], templateKey: string): Promise<Candidate[]> {
  const users = await db.user.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      roles: { some: { role: { key: { in: roleKeys } } } },
    },
    select: { id: true },
  });
  if (users.length === 0) return [];

  const ids = users.map((user) => user.id);

  const openCounts = await db.task.groupBy({
    by: ["assigneeId"],
    where: {
      deletedAt: null,
      assigneeId: { in: ids },
      status: { notIn: [...CLOSED_STATUSES] },
    },
    _count: { _all: true },
  });
  const openByUser = new Map(openCounts.map((row) => [row.assigneeId, row._count._all]));

  /*
    When this template last gave each person something.

    `assignedAt` rather than `createdAt`, because a task reassigned to somebody is work they have had
    since the handover — and because `createdAt` would keep pointing at the original recipient's turn
    forever. The stamp is matched with `startsWith` so every task line in the template counts as a
    turn: rotation is over the template, not over one of its rows.
  */
  const lastAssigned = await db.task.groupBy({
    by: ["assigneeId"],
    where: {
      deletedAt: null,
      assigneeId: { in: ids },
      createdByTemplate: { startsWith: `${templateKey}:` },
    },
    _max: { assignedAt: true },
  });
  const lastByUser = new Map(lastAssigned.map((row) => [row.assigneeId, row._max.assignedAt]));

  return users.map((user) => ({
    id: user.id,
    openTasks: openByUser.get(user.id) ?? 0,
    lastAssignedAt: lastByUser.get(user.id) ?? null,
  }));
}

/**
 * Who gets this line of the template.
 *
 * Returns `[null]` — one unassigned task — when nobody can be found. Recording the work and leaving
 * it ownerless is the lesser evil: the alternative is a job the platform knows needs doing and never
 * mentions again. `/tasks` lists unassigned work first for exactly this reason.
 */
async function assigneesFor(
  spec: TaskSpec,
  target: TriggerTarget,
  templateKey: string,
): Promise<(string | null)[]> {
  if (spec.assignTo === "record_owner" && target.recordOwnerId) {
    const owner = await db.user.findFirst({
      where: { id: target.recordOwnerId, isActive: true, deletedAt: null },
      select: { id: true },
    });
    // An inactive owner falls through to the role rather than being assigned work they cannot do.
    if (owner) return [owner.id];
  }

  const candidates = await candidatesFor(spec.roleKeys, templateKey);
  const chosen = chooseAssignee(spec.assignMode as AssignMode, candidates);
  return chosen.length > 0 ? chosen : [null];
}

/**
 * When the task is due.
 *
 * Null when the anchor the template asked for does not exist on the record. §2 gave that task its
 * deadline for a reason, and quietly substituting the event date would be the platform inventing a
 * commitment nobody made — the same rule that makes `daysLate` null rather than zero.
 */
function dueAtFor(spec: TaskSpec, target: TriggerTarget): Date | null {
  const from = spec.dueFrom ?? "event";
  const anchor =
    from === "event"
      ? target.anchors.event
      : from === "neededBy"
        ? (target.anchors.neededBy ?? null)
        : (target.anchors.liquidationDue ?? null);

  if (!anchor) return null;
  if (spec.dueInDays === undefined || spec.dueInDays === null) return anchor;
  return addBusinessDays(anchor, spec.dueInDays);
}

/** Titles say which job they are about, when the record has a number to say it with. */
function titleFor(spec: TaskSpec, target: TriggerTarget): string {
  return target.reference ? `${spec.title} — ${target.reference}` : spec.title;
}

export interface RunTemplatesOptions {
  /**
   * Consider only these template keys.
   *
   * Exists for one reason and it is worth stating plainly: this platform has **no separate test
   * database** (docs/DECISIONS.md #1 — it was tried and reverted), so a test that fires a real
   * trigger would otherwise set the company's own standing templates going and raise real work,
   * with real notifications, for real people. Narrowing the run keeps a test to its own fixtures.
   *
   * Nothing in production passes it. The subscriber in the manifest does not, so a live event runs
   * every active template, which is the whole point of them.
   */
  templateKeys?: string[];
}

export async function runTemplatesForEvent(
  event: string,
  payload: Record<string, unknown>,
  occurredAt: Date = new Date(),
  options: RunTemplatesOptions = {},
): Promise<TemplateRunResult> {
  const result: TemplateRunResult = { created: [], skipped: 0, failures: [] };

  const resolve = resolverFor(event);
  if (!resolve) return result;

  const rows = await db.taskTemplate.findMany({
    where: {
      trigger: event,
      isActive: true,
      deletedAt: null,
      ...(options.templateKeys ? { key: { in: options.templateKeys } } : {}),
    },
    select: { key: true, name: true, trigger: true, condition: true, tasks: true },
  });
  if (rows.length === 0) return result;

  const targets = await resolve(payload, occurredAt);
  if (targets.length === 0) return result;

  for (const row of rows) {
    const template = asSpec(row);
    if (!template) {
      result.failures.push({
        templateKey: row.key,
        taskKey: "-",
        reason: "Its task list is not an array, so nothing can be read from it.",
      });
      continue;
    }

    for (const target of targets) {
      if (!conditionMatches(template.condition, target.conditionValues)) continue;

      for (const spec of template.tasks) {
        const stamp = templateStamp(template.key, spec.key);
        try {
          const existing = await db.task.findMany({
            where: {
              createdByTemplate: stamp,
              entityType: target.entityType,
              entityId: target.entityId,
              deletedAt: null,
            },
            select: { assigneeId: true },
          });
          const alreadyWith = new Set(existing.map((task) => task.assigneeId));

          const assignees = await assigneesFor(spec, target, template.key);

          for (const assigneeId of assignees) {
            if (alreadyWith.has(assigneeId)) {
              result.skipped += 1;
              continue;
            }

            const created = await createTaskService(TEMPLATE_ACTOR, {
              title: titleFor(spec, target),
              description: spec.description ?? null,
              entityType: target.entityType,
              entityId: target.entityId,
              assigneeId,
              priority: spec.priority ?? "normal",
              dueAt: dueAtFor(spec, target),
              createdByTemplate: stamp,
            });

            result.created.push({
              taskId: created.id,
              number: created.number,
              templateKey: template.key,
              taskKey: spec.key,
            });
          }
        } catch (error) {
          /*
            Logged and carried, never rethrown.

            The event that brought us here has already happened — the sales order exists, the QA has
            failed — and there is nothing to roll back to. Failing the job would also retry every
            template that already succeeded, which the stamp check would then skip, so the retry
            would achieve nothing except another failure.
          */
          const reason = error instanceof Error ? error.message : String(error);
          console.error(`[task-templates] ${stamp} on ${event}: ${reason}`);
          result.failures.push({ templateKey: template.key, taskKey: spec.key, reason });
        }
      }
    }
  }

  return result;
}

/**
 * Creates any seeded template that is missing, and leaves every existing one alone.
 *
 * Never an update. Once a template is in the database it is the company's — §2 asks for the
 * assignment mode to be configurable, and a seed that overwrote on every deploy would silently undo
 * whatever somebody changed. Same treatment the checklist templates get.
 */
export async function ensureSeededTemplates(): Promise<{ created: string[]; existing: number }> {
  const present = await db.taskTemplate.findMany({ select: { key: true } });
  const have = new Set(present.map((row) => row.key));

  const created: string[] = [];
  for (const template of TASK_TEMPLATE_SEEDS) {
    if (have.has(template.key)) continue;
    await db.taskTemplate.create({
      data: {
        key: template.key,
        name: template.name,
        trigger: template.trigger,
        condition: template.condition ?? undefined,
        // Through `unknown`: Prisma's Json input type does not accept a typed array directly, and
        // the shape is validated by checkTemplate over these same seeds in the test suite.
        tasks: template.tasks as unknown as Prisma.InputJsonValue,
      },
    });
    created.push(template.key);
  }

  return { created, existing: have.size };
}

/** Every template, for the screen that shows what the platform will do without being asked. */
export async function taskTemplatesService() {
  const rows = await db.taskTemplate.findMany({
    where: { deletedAt: null },
    orderBy: [{ trigger: "asc" }, { key: "asc" }],
    select: {
      id: true,
      key: true,
      name: true,
      trigger: true,
      condition: true,
      tasks: true,
      isActive: true,
    },
  });

  const counts = await db.task.groupBy({
    by: ["createdByTemplate"],
    where: { deletedAt: null, createdByTemplate: { not: null } },
    _count: { _all: true },
  });

  return rows.map((row) => {
    const tasks = Array.isArray(row.tasks) ? (row.tasks as unknown as TaskSpec[]) : [];
    const raised = counts
      .filter((count) => count.createdByTemplate?.startsWith(`${row.key}:`))
      .reduce((sum, count) => sum + count._count._all, 0);
    return { ...row, tasks, raised };
  });
}

export const TASK_TEMPLATE_ENTITY_TYPE = "TaskTemplate";

/**
 * Turning a template off, or back on.
 *
 * Audited like any other change, and worth auditing more than most: a template switched off stops
 * work being raised across the whole company and nothing on any screen would say why. The audit row
 * is the only place that answers "when did we stop being told to acknowledge POs?".
 */
export async function setTemplateActiveService(
  actor: ActorMeta,
  input: { templateId: string; isActive: boolean },
) {
  const template = await db.taskTemplate.findFirst({
    where: { id: input.templateId, deletedAt: null },
    select: { id: true, key: true, name: true, isActive: true },
  });
  if (!template) throw new TRPCError({ code: "NOT_FOUND", message: "No such template." });

  await db.$transaction(async (tx) => {
    await tx.taskTemplate.update({
      where: { id: template.id },
      data: { isActive: input.isActive },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "update",
      entityType: TASK_TEMPLATE_ENTITY_TYPE,
      entityId: template.id,
      summary: input.isActive
        ? `Turned the "${template.name}" task template back on`
        : `Turned the "${template.name}" task template off — it will stop raising work`,
      diff: { isActive: { from: template.isActive, to: input.isActive } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { isActive: input.isActive };
}

/**
 * Changing how one line of a template picks its person — §2's "make this configurable".
 *
 * One task at a time rather than the whole template, because the modes are not a property of the
 * template: `cash-advance-requested` legitimately holds an approval that goes to everyone and a
 * release that goes to one person.
 */
export async function setTemplateAssignModeService(
  actor: ActorMeta,
  input: { templateId: string; taskKey: string; assignMode: AssignMode },
) {
  const template = await db.taskTemplate.findFirst({
    where: { id: input.templateId, deletedAt: null },
    select: { id: true, key: true, name: true, tasks: true },
  });
  if (!template) throw new TRPCError({ code: "NOT_FOUND", message: "No such template." });

  const tasks = Array.isArray(template.tasks) ? (template.tasks as unknown as TaskSpec[]) : null;
  if (!tasks) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "That template's task list cannot be read.",
    });
  }

  const target = tasks.find((task) => task.key === input.taskKey);
  if (!target) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `"${input.taskKey}" is not a task in that template.`,
    });
  }

  const was = target.assignMode;
  const next = tasks.map((task) =>
    task.key === input.taskKey ? { ...task, assignMode: input.assignMode } : task,
  );

  await db.$transaction(async (tx) => {
    await tx.taskTemplate.update({
      where: { id: template.id },
      data: { tasks: next as unknown as Prisma.InputJsonValue },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "update",
      entityType: TASK_TEMPLATE_ENTITY_TYPE,
      entityId: template.id,
      summary: `"${target.title}" now assigns ${ASSIGN_MODE_LABELS[input.assignMode].toLowerCase()}`,
      diff: { [`${input.taskKey}.assignMode`]: { from: was, to: input.assignMode } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { assignMode: input.assignMode };
}
