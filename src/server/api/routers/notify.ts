import { z } from "zod";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  setNotificationPreference,
  unreadNotificationCount,
} from "@/server/core/notify/notify";
import { listNotificationTypes } from "@/server/core/notify/registry";
import { protectedProcedure, router } from "@/server/api/trpc";

export const notifyRouter = router({
  list: protectedProcedure
    .input(z.object({ unreadOnly: z.boolean().optional() }).optional())
    .query(({ ctx, input }) => listNotifications(ctx.user.id, { unreadOnly: input?.unreadOnly })),

  unreadCount: protectedProcedure.query(({ ctx }) => unreadNotificationCount(ctx.user.id)),

  markRead: protectedProcedure
    .input(z.object({ notificationId: z.string() }))
    .mutation(({ ctx, input }) => markNotificationRead(ctx.user.id, input.notificationId)),

  markAllRead: protectedProcedure.mutation(({ ctx }) => markAllNotificationsRead(ctx.user.id)),

  listTypes: protectedProcedure.query(() => listNotificationTypes()),

  setPreference: protectedProcedure
    .input(
      z.object({
        type: z.string(),
        inApp: z.boolean().optional(),
        email: z.boolean().optional(),
        digest: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => setNotificationPreference(ctx.user.id, input.type, input)),
});
