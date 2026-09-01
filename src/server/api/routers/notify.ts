import { z } from "zod";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  setNotificationPreference,
  unreadNotificationCount,
} from "@/server/core/notify/notify";
import { listNotificationTypes } from "@/server/core/notify/registry";
import {
  listDevicesForUser,
  publicVapidKey,
  subscribeDevice,
  unsubscribeDevice,
} from "@/server/core/notify/push";
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

  // ---- device push — §7's actual "make the phone ring" ------------------------------------------

  pushPublicKey: protectedProcedure.query(() => ({ key: publicVapidKey() })),

  listDevices: protectedProcedure.query(({ ctx }) => listDevicesForUser(ctx.user.id)),

  subscribeDevice: protectedProcedure
    .input(
      z.object({
        endpoint: z.string(),
        p256dh: z.string(),
        auth: z.string(),
        userAgent: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => subscribeDevice(ctx.user.id, input)),

  unsubscribeDevice: protectedProcedure
    .input(z.object({ endpoint: z.string() }))
    .mutation(({ ctx, input }) => unsubscribeDevice(ctx.user.id, input.endpoint)),
});
