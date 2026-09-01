import { db } from "@/lib/db";
import { enqueue } from "@/server/core/jobs/queue";
import { getNotificationType, type NotificationChannels } from "./registry";
import { sendPushToUser } from "./push";
import {
  DEFAULT_QUIET_HOURS,
  isQuiet,
  passesQuietHours,
  releaseAt,
  type QuietHours,
} from "@/server/core/collab/quiet-hours-rules";

export interface NotifyInput {
  recipientId: string;
  type: string;
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
  /**
   * Passes §7's quiet hours whatever the hour.
   *
   * For the caller to decide, because only the caller knows: an `urgent` task, an emergency ticket.
   * Set it sparingly — §7's warning is that a platform which pings at midnight gets muted, and then
   * the message that mattered is missed as well.
   */
  urgent?: boolean;
}

/**
 * §7's quiet hours for one person, defaults included.
 *
 * A row exists only when somebody has changed something, so most people are served entirely from
 * the constants in `quiet-hours-rules.ts`.
 */
async function scheduleFor(userId: string): Promise<QuietHours> {
  const row = await db.notificationSchedule.findUnique({ where: { userId } });
  if (!row) return DEFAULT_QUIET_HOURS;
  return {
    quietHoursOn: row.quietHoursOn,
    quietFromMinutes: row.quietFromMinutes ?? DEFAULT_QUIET_HOURS.quietFromMinutes,
    quietToMinutes: row.quietToMinutes ?? DEFAULT_QUIET_HOURS.quietToMinutes,
    digestAtMinutes: row.digestAtMinutes,
  };
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

  /*
    §7's quiet hours: held until morning, never dropped.

    The distinction the company drew on 2026-08-20 and the reason there is a column rather than an
    early `return`: a notification discarded at 23:00 is exactly the outcome §7 is trying to prevent,
    only silently. It is written now, hidden from the bell until `heldUntil`, and released by the
    drain — so somebody who wakes up finds the night's news waiting rather than missing.
  */
  const now = new Date();
  const schedule = await scheduleFor(input.recipientId);
  const held =
    isQuiet(now, schedule) && !passesQuietHours(input.type, input.urgent ?? false)
      ? releaseAt(now, schedule)
      : null;

  await db.notification.create({
    data: {
      recipientId: input.recipientId,
      type: input.type,
      title: input.title,
      body: input.body,
      entityType: input.entityType,
      entityId: input.entityId,
      heldUntil: held,
    },
  });

  /*
    A device push, not just the in-app row. Held notifications are not pushed here — the whole
    point of holding is that nobody should be woken for them — they push instead when
    `releaseHeldNotifications` lets them go. `urgent` bypassing quiet hours (§7) means `held` is
    null and this fires immediately, which is the one case this exists for.

    Best-effort and outside any transaction, same as every other notify side-effect in this file: a
    push failing must never be why the in-app notification did not get written.
  */
  if (!held) {
    await sendPushToUser(input.recipientId, {
      title: input.title,
      body: input.body,
      url: "/notifications",
    }).catch(() => {});
  }
}

/**
 * Everything whose quiet hours have passed, released.
 *
 * Called by the drain, which runs every minute — so "the morning digest" is accurate to the minute
 * without a second schedule to keep. Returns the count so the cron's log says what it did.
 *
 * Pushes each one it releases — the device notification a held row never got at creation, arriving
 * now instead of only ever showing up if somebody happens to open the app.
 */
export async function releaseHeldNotifications(now: Date = new Date()): Promise<number> {
  const releasing = await db.notification.findMany({
    where: { heldUntil: { not: null, lte: now } },
    select: { id: true, recipientId: true, title: true, body: true },
  });
  if (releasing.length === 0) return 0;

  await db.notification.updateMany({
    where: { id: { in: releasing.map((n) => n.id) } },
    data: { heldUntil: null },
  });

  await Promise.all(
    releasing.map((n) =>
      sendPushToUser(n.recipientId, {
        title: n.title,
        body: n.body ?? undefined,
        url: "/notifications",
      }).catch(() => {}),
    ),
  );

  return releasing.length;
}

export function listNotifications(recipientId: string, options: { unreadOnly?: boolean } = {}) {
  return db.notification.findMany({
    // A held notification exists and is not yet news. Both halves matter: it is not lost, and it is
    // not shown at two in the morning to somebody who happens to open the app.
    where: { recipientId, heldUntil: null, ...(options.unreadOnly ? { readAt: null } : {}) },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

export function unreadNotificationCount(recipientId: string): Promise<number> {
  return db.notification.count({ where: { recipientId, readAt: null, heldUntil: null } });
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
