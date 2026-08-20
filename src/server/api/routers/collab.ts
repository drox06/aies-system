import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { p, router, type Context } from "@/server/api/trpc";
import type { ActorMeta } from "@/server/core/crm/account-service";
import {
  assignTaskService,
  assignableUsersService,
  createTaskService,
  listTasksService,
  myWorkService,
  setTaskStatusService,
  tasksForRecordService,
} from "@/server/core/collab/task-service";
import { TASK_ENTITY_TYPES, TASK_PRIORITIES, TASK_STATUSES } from "@/server/core/collab/task-rules";
import { ASSIGN_MODES } from "@/server/core/collab/task-template-rules";
import {
  setTemplateActiveService,
  setTemplateAssignModeService,
  taskTemplatesService,
} from "@/server/core/collab/task-template-service";

/**
 * Module 06's procedures. Session 1 covers §2's task and My Work.
 *
 * Two gates rather than one on the writes: `task.create` to write work down, `task.assign` to put it
 * in somebody else's queue — see the manifest for why those are separate acts.
 */

function actorMeta(ctx: Context & { user: { id: string; name: string } }): ActorMeta {
  return {
    actorId: ctx.user.id,
    actorLabel: ctx.user.name,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  };
}

export const collabRouter = router({
  /**
   * §2's My Work. No input: it is always the caller's own.
   *
   * Reading somebody else's queue is a different question with a different answer — that is `list`
   * with an `assigneeId`, which needs `task.assign` because it is the load-check a person makes
   * before handing work over.
   */
  myWork: p("task.view").query(({ ctx }) => myWorkService(ctx.user.id)),

  list: p("task.assign")
    .input(
      z
        .object({
          status: z.enum(TASK_STATUSES).optional(),
          assigneeId: z.string().optional(),
          entityType: z.enum(TASK_ENTITY_TYPES).optional(),
        })
        .optional(),
    )
    .query(({ input }) => listTasksService(input ?? {})),

  /** The task panel a record's own screen shows. */
  forRecord: p("task.view")
    .input(z.object({ entityType: z.enum(TASK_ENTITY_TYPES), entityId: z.string() }))
    .query(({ input }) => tasksForRecordService(input)),

  /** Who a task can be given to. Gated on `task.view` — the picker is useless without it, and the
   *  same list of colleagues is already visible in every mention box. */
  assignableUsers: p("task.view").query(() => assignableUsersService()),

  create: p("task.create")
    .input(
      z.object({
        title: z.string().min(3).max(300),
        description: z.string().max(5000).nullish(),
        entityType: z.enum(TASK_ENTITY_TYPES).nullish(),
        entityId: z.string().nullish(),
        assigneeId: z.string().nullish(),
        watcherIds: z.array(z.string()).max(20).optional(),
        priority: z.enum(TASK_PRIORITIES).optional(),
        dueAt: z.coerce.date().nullish(),
        startAt: z.coerce.date().nullish(),
        estimateHours: z.number().positive().max(500).nullish(),
        labels: z.array(z.string().min(1).max(40)).max(10).optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      /*
        Assigning to somebody else on the way in is an assignment, so it needs the assignment grant.

        Checked here rather than in the service because it is an authorisation decision about the
        caller, and every other procedure in this platform keeps those at the edge. Taking work on
        yourself needs nothing beyond `task.create`.
      */
      if (input.assigneeId && input.assigneeId !== ctx.user.id) {
        requireAssign(ctx.user.permissions);
      }

      /*
        A task raised by hand with nobody named becomes the raiser's.

        The service permits an unassigned task and will keep permitting it — session 2's templates
        create work before anybody has picked it up, and forcing a name on those would put a wrong
        owner on real work. But nothing raised *through this procedure* is a template, and My Work
        reads by assignee: an unassigned task raised here would be written down and then shown on no
        screen at all, which is the same silence §1 is trying to end.
      */
      return createTaskService(actorMeta(ctx), {
        ...input,
        assigneeId: input.assigneeId ?? ctx.user.id,
      });
    }),

  assign: p("task.assign")
    .input(z.object({ taskId: z.string(), assigneeId: z.string().nullable() }))
    .mutation(({ ctx, input }) => assignTaskService(actorMeta(ctx), input)),

  /**
   * Moving a task along. `task.create` rather than `task.assign`, because the person doing the work
   * is the one who says it is done — requiring the assignment grant would mean a technician needed a
   * manager to tick off their own task, which is the meeting §1 is trying to get rid of.
   */
  setStatus: p("task.create")
    .input(
      z.object({
        taskId: z.string(),
        status: z.enum(TASK_STATUSES),
        actualHours: z.number().positive().max(500).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => setTaskStatusService(actorMeta(ctx), input)),

  // ---- §2's templates ---------------------------------------------------------------------------

  /**
   * What the platform will raise without being asked, and how much it has raised so far.
   *
   * Readable by anybody who can see a task, deliberately. A task that appears on somebody's list
   * because a sales order was created is confusing until they can see the standing rule that put it
   * there — and "why have I got this?" is the question that makes people stop trusting a queue.
   */
  templates: p("task.view").query(() => taskTemplatesService()),

  setTemplateActive: p("task.manage_templates")
    .input(z.object({ templateId: z.string(), isActive: z.boolean() }))
    .mutation(({ ctx, input }) => setTemplateActiveService(actorMeta(ctx), input)),

  setTemplateAssignMode: p("task.manage_templates")
    .input(
      z.object({
        templateId: z.string(),
        taskKey: z.string(),
        assignMode: z.enum(ASSIGN_MODES),
      }),
    )
    .mutation(({ ctx, input }) => setTemplateAssignModeService(actorMeta(ctx), input)),
});

function requireAssign(permissions: ReadonlySet<string>) {
  if (!permissions.has("task.assign")) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "You can raise a task for yourself, but putting work in somebody else's queue needs the " +
        "assignment permission.",
    });
  }
}
