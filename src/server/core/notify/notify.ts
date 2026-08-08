import { db } from "@/lib/db";
import { enqueue } from "@/server/core/jobs/queue";
import { getNotificationType, type NotificationChannels } from "./registry";

export interface NotifyInput {
  recipientId: string;
  type: string;
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
}

async function resolveChannels(userId: string, type: string): Promise<NotificationChannels> {
  const typeDef = getNotificationType(type);
  if (!typeDef) {
    throw new Error(`Unknown notification type "${type}" — register it before calling notify().`);
  }

  const pref = await db.notificationPreference.findUnique({
    where: { userId_type: { userId, type } },
  });

  return pref
    ? { inApp: pref.inApp, email: pref.email, digest: pref.digest }
    : typeDef.defaultChannels;
}

/**
 * specs/00-foundation.md §7.3. Only the in-app channel actually delivers right now — see
 * prisma/schema/notify.prisma's header comment for why email is enqueued but not consumed yet.
 */
export async function notify(input: NotifyInput): Promise<void> {
  const channels = await resolveChannels(input.recipientId, input.type);
  const typeDef = getNotificationType(input.type)!; // resolveChannels already validated this

  if (channels.email) {
    await enqueue(db, "notify_email", input, {
      idempotencyKey: `notify_email:${input.recipientId}:${input.type}:${input.entityType ?? ""}:${input.entityId ?? ""}:${Date.now()}`,
    });
  }

  if (!channels.inApp) return;

  const coalesceWindowMs = typeDef.coalesceWindowMs ?? 0;
  if (coalesceWindowMs > 0 && input.entityType && input.entityId) {
    const since = new Date(Date.now() - coalesceWindowMs);
    const existing = await db.notification.findFirst({
      where: {
        recipientId: input.recipientId,
        type: input.type,
        entityType: input.entityType,
        entityId: input.entityId,
        readAt: null,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "desc" },
    });

    if (existing) {
      await db.notification.update({
        where: { id: existing.id },
        data: { count: { increment: 1 }, title: input.title, body: input.body },
      });
      return;
    }
  }

  await db.notification.create({
    data: {
      recipientId: input.recipientId,
      type: input.type,
      title: input.title,
      body: input.body,
      entityType: input.entityType,
      entityId: input.entityId,
    },
  });
}

export function listNotifications(recipientId: string, options: { unreadOnly?: boolean } = {}) {
  return db.notification.findMany({
    where: { recipientId, ...(options.unreadOnly ? { readAt: null } : {}) },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

export function unreadNotificationCount(recipientId: string): Promise<number> {
  return db.notification.count({ where: { recipientId, readAt: null } });
}

export async function markNotificationRead(recipientId: string, notificationId: string) {
  return db.notification.updateMany({
    where: { id: notificationId, recipientId },
    data: { readAt: new Date() },
  });
}

export async function markAllNotificationsRead(recipientId: string) {
  return db.notification.updateMany({
    where: { recipientId, readAt: null },
    data: { readAt: new Date() },
  });
}

export function setNotificationPreference(
  userId: string,
  type: string,
  channels: Partial<NotificationChannels>,
) {
  return db.notificationPreference.upsert({
    where: { userId_type: { userId, type } },
    update: channels,
    create: {
      userId,
      type,
      inApp: channels.inApp ?? true,
      email: channels.email ?? true,
      digest: channels.digest ?? false,
    },
  });
}
