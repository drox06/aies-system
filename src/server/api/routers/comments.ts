import { z } from "zod";
import { getActivityFeed } from "@/server/core/comments/activity-feed";
import {
  createComment,
  deleteComment,
  editComment,
  listComments,
} from "@/server/core/comments/service";
import { protectedProcedure, router } from "@/server/api/trpc";

export const commentsRouter = router({
  list: protectedProcedure
    .input(z.object({ entityType: z.string(), entityId: z.string() }))
    .query(({ input }) => listComments(input.entityType, input.entityId)),

  create: protectedProcedure
    .input(
      z.object({
        entityType: z.string(),
        entityId: z.string(),
        body: z.string().min(1),
        parentId: z.string().optional(),
        mentions: z.array(z.string()).optional(),
      }),
    )
    .mutation(({ ctx, input }) => createComment({ ...input, authorId: ctx.user.id })),

  edit: protectedProcedure
    .input(z.object({ commentId: z.string(), body: z.string().min(1) }))
    .mutation(({ ctx, input }) => editComment(input.commentId, ctx.user.id, input.body)),

  delete: protectedProcedure
    .input(z.object({ commentId: z.string() }))
    .mutation(({ ctx, input }) => deleteComment(input.commentId, ctx.user.id)),

  activityFeed: protectedProcedure
    .input(z.object({ entityType: z.string(), entityId: z.string() }))
    .query(({ input }) => getActivityFeed(input.entityType, input.entityId)),
});
