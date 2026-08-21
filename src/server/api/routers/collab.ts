import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { p, protectedProcedure, router, type Context } from "@/server/api/trpc";
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
  BOARD_TYPES,
  SWIMLANE_OPTIONS,
  type BoardColumn,
  type BoardFilterRule,
} from "@/server/core/collab/board-rules";
import { CHANNEL_TYPES, NOTIFICATION_LEVELS } from "@/server/core/collab/channel-rules";
import {
  channelsService,
  createChannelService,
  deleteMessageService,
  editMessageService,
  joinChannelService,
  leaveChannelService,
  markReadService,
  messagesService,
  postMessageService,
  promoteMessageService,
  reactService,
  searchMessagesService,
  setNotificationLevelService,
  updateChannelService,
} from "@/server/core/collab/channel-service";
import {
  boardViewService,
  boardsService,
  createBoardService,
  deleteBoardService,
  moveCardService,
  placeableTasksService,
  removeCardService,
  updateBoardService,
} from "@/server/core/collab/board-service";
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

  // ---- §2's boards ------------------------------------------------------------------------------

  boards: p("task.view").query(({ ctx }) => boardsService(ctx.user.id)),

  /** One board, resolved. The viewer matters: a smart board's `assignee: "me"` means the reader. */
  board: p("task.view")
    .input(z.object({ boardId: z.string(), includeDone: z.boolean().optional() }))
    .query(({ ctx, input }) => boardViewService(ctx.user.id, input)),

  placeableTasks: p("task.view")
    .input(z.object({ boardId: z.string() }))
    .query(({ input }) => placeableTasksService(input)),

  createBoard: p("task.manage_boards")
    .input(
      z.object({
        name: z.string().min(2).max(80),
        type: z.enum(BOARD_TYPES).optional(),
        isPrivate: z.boolean().optional(),
        columns: z
          .array(
            z.object({
              key: z.string().min(1).max(40),
              label: z.string().min(1).max(40),
              statuses: z.array(z.enum(TASK_STATUSES)).optional(),
            }),
          )
          .optional(),
        wipLimits: z.record(z.string(), z.number().int().positive()).nullish(),
        filterRule: z.record(z.string(), z.unknown()).nullish(),
        swimlaneBy: z.enum(SWIMLANE_OPTIONS).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      createBoardService(actorMeta(ctx), {
        ...input,
        columns: input.columns as BoardColumn[] | undefined,
        filterRule: (input.filterRule ?? null) as BoardFilterRule | null,
      }),
    ),

  updateBoard: p("task.manage_boards")
    .input(
      z.object({
        boardId: z.string(),
        name: z.string().min(2).max(80).optional(),
        isPrivate: z.boolean().optional(),
        wipLimits: z.record(z.string(), z.number().int().positive()).nullish(),
        filterRule: z.record(z.string(), z.unknown()).nullish(),
        swimlaneBy: z.enum(SWIMLANE_OPTIONS).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      updateBoardService(actorMeta(ctx), {
        ...input,
        filterRule:
          input.filterRule === undefined ? undefined : (input.filterRule as BoardFilterRule | null),
      }),
    ),

  deleteBoard: p("task.manage_boards")
    .input(z.object({ boardId: z.string() }))
    .mutation(({ ctx, input }) => deleteBoardService(actorMeta(ctx), input)),

  /**
   * Moving a card.
   *
   * `task.create` rather than `task.manage_boards`: dragging a card is doing the work, and the
   * column carries the status, so this is the same act as ticking a task off. Building the board is
   * a different job from working from it.
   */
  moveCard: p("task.create")
    .input(
      z.object({
        taskId: z.string(),
        boardId: z.string(),
        columnKey: z.string(),
        position: z.number().int().min(0).optional(),
      }),
    )
    .mutation(({ ctx, input }) => moveCardService(actorMeta(ctx), input)),

  removeCard: p("task.create")
    .input(z.object({ taskId: z.string() }))
    .mutation(({ ctx, input }) => removeCardService(actorMeta(ctx), input)),

  // ---- §3's channels ----------------------------------------------------------------------------

  /**
   * Reading and posting need no permission beyond being signed in.
   *
   * Membership is the gate, not a role. This company is nine people; a permission matrix over
   * conversation would mean somebody deciding in advance which colleagues may talk to which, which
   * is the opposite of what §3 is for. `channel.create` exists because a wall of half-made channels
   * is a real failure mode; reading one is not.
   */
  channels: protectedProcedure.query(({ ctx }) => channelsService(ctx.user.id)),

  channel: protectedProcedure
    .input(z.object({ channelId: z.string(), threadRootId: z.string().nullish() }))
    .query(({ ctx, input }) => messagesService(ctx.user.id, input)),

  searchMessages: protectedProcedure
    .input(z.object({ query: z.string().min(2).max(200) }))
    .query(({ ctx, input }) => searchMessagesService(ctx.user.id, input)),

  createChannel: p("channel.create")
    .input(
      z.object({
        name: z.string().min(2).max(60),
        description: z.string().max(500).nullish(),
        type: z.enum(CHANNEL_TYPES).optional(),
        isPrivate: z.boolean().optional(),
        memberIds: z.array(z.string()).max(50).optional(),
      }),
    )
    .mutation(({ ctx, input }) => createChannelService(actorMeta(ctx), input)),

  postMessage: protectedProcedure
    .input(
      z.object({
        channelId: z.string(),
        body: z.string().min(1).max(8000),
        threadRootId: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => postMessageService(actorMeta(ctx), input)),

  editMessage: protectedProcedure
    .input(z.object({ messageId: z.string(), body: z.string().min(1).max(8000) }))
    .mutation(({ ctx, input }) => editMessageService(actorMeta(ctx), input)),

  /** Own message inside the window, or anybody's with `message.delete_any` — which is audited. */
  deleteMessage: protectedProcedure
    .input(z.object({ messageId: z.string() }))
    .mutation(({ ctx, input }) =>
      deleteMessageService(actorMeta(ctx), {
        ...input,
        canDeleteAny: ctx.user.permissions.has("message.delete_any"),
      }),
    ),

  react: protectedProcedure
    .input(z.object({ messageId: z.string(), emoji: z.string().min(1).max(8) }))
    .mutation(({ ctx, input }) => reactService(actorMeta(ctx), input)),

  markChannelRead: protectedProcedure
    .input(z.object({ channelId: z.string() }))
    .mutation(({ ctx, input }) => markReadService(ctx.user.id, input)),

  joinChannel: protectedProcedure
    .input(z.object({ channelId: z.string() }))
    .mutation(({ ctx, input }) => joinChannelService(actorMeta(ctx), input)),

  leaveChannel: protectedProcedure
    .input(z.object({ channelId: z.string() }))
    .mutation(({ ctx, input }) => leaveChannelService(actorMeta(ctx), input)),

  setChannelNotifications: protectedProcedure
    .input(z.object({ channelId: z.string(), level: z.enum(NOTIFICATION_LEVELS) }))
    .mutation(({ ctx, input }) => setNotificationLevelService(ctx.user.id, input)),

  /** Renaming, membership and archiving — all three act on other people's access. */
  updateChannel: p("channel.manage")
    .input(
      z.object({
        channelId: z.string(),
        name: z.string().min(2).max(60).optional(),
        description: z.string().max(500).nullish(),
        addMemberIds: z.array(z.string()).max(50).optional(),
        removeMemberIds: z.array(z.string()).max(50).optional(),
        archived: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => updateChannelService(actorMeta(ctx), input)),

  /**
   * §3's promote-to-task.
   *
   * `task.create`, because that is what it does. The message stays where it is; what changes is that
   * somebody now owns the thing it asked for.
   */
  promoteMessage: p("task.create")
    .input(
      z.object({
        messageId: z.string(),
        title: z.string().min(3).max(300),
        assigneeId: z.string().nullish(),
        dueAt: z.coerce.date().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => promoteMessageService(actorMeta(ctx), input)),
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
