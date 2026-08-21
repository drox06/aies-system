import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { listNotificationTypes } from "@/server/core/notify/registry";
import {
  ALWAYS_THROUGH_TYPES,
  DEFAULT_QUIET_HOURS,
  TYPE_NOTIFICATION_LEVELS,
  checkSchedule,
  type QuietHours,
  type TypeNotificationLevel,
} from "@/server/core/collab/quiet-hours-rules";

/**
 * §7's notification settings.
 *
 * ## Three levels, not three checkboxes
 *
 * §7 asks for *"three levels per source: all, mentions and assignments only, none"*. Module 00 stores
 * three booleans per type — in-app, email, digest — which is a different question: it is about
 * *where* rather than *how much*. The level is expressed in those columns rather than adding a
 * fourth: **all** is in-app and digest; **mentions only** is digest alone, so it still arrives but
 * once a day; **none** is neither.
 *
 * `email` stays false throughout, as everywhere in this platform — `notify_email` has no consumer by
 * design (docs/DECISIONS.md #10), and setting it would enqueue a job that dies.
 */

export const NOTIFICATION_LEVELS = TYPE_NOTIFICATION_LEVELS;
export type NotificationLevel = TypeNotificationLevel;

function levelFrom(pref: { inApp: boolean; digest: boolean } | undefined): NotificationLevel {
  if (!pref) return "all";
  if (pref.inApp) return "all";
  return pref.digest ? "mentions" : "none";
}

function channelsFor(level: NotificationLevel) {
  return {
    inApp: level === "all",
    email: false,
    digest: level !== "none",
  };
}

/** Everything this person can be told about, at the level they have chosen. */
export async function notificationSettingsService(userId: string) {
  const [preferences, schedule] = await Promise.all([
    db.notificationPreference.findMany({ where: { userId } }),
    db.notificationSchedule.findUnique({ where: { userId } }),
  ]);

  const byType = new Map(preferences.map((pref) => [pref.type, pref]));

  return {
    /*
      Driven by the registry rather than by the rows that exist.

      A person who has never changed anything has no rows at all, and a screen built from rows would
      show them nothing to change. The registry is the list of everything the platform can say.
    */
    types: listNotificationTypes()
      .map((type) => ({
        key: type.key,
        label: type.label,
        level: levelFrom(byType.get(type.key)),
        /** Reaches them at any hour. Shown so nobody wonders why the phone lit up at midnight. */
        alwaysThrough: ALWAYS_THROUGH_TYPES.includes(type.key),
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),

    quietHours: schedule
      ? {
          quietHoursOn: schedule.quietHoursOn,
          quietFromMinutes: schedule.quietFromMinutes ?? DEFAULT_QUIET_HOURS.quietFromMinutes,
          quietToMinutes: schedule.quietToMinutes ?? DEFAULT_QUIET_HOURS.quietToMinutes,
          digestAtMinutes: schedule.digestAtMinutes,
        }
      : DEFAULT_QUIET_HOURS,
    /** True when nothing has been changed, so the screen can say "these are the defaults". */
    usingDefaults: !schedule,

    /** What is waiting for morning right now — the proof that nothing was thrown away. */
    held: await db.notification.count({
      where: { recipientId: userId, heldUntil: { not: null } },
    }),
  };
}

export async function setNotificationLevelService(
  userId: string,
  input: { type: string; level: NotificationLevel },
) {
  const known = listNotificationTypes().some((type) => type.key === input.type);
  if (!known) {
    // A preference on a type nothing sends is a setting that does nothing, saved as though it did.
    throw new TRPCError({ code: "BAD_REQUEST", message: "Nothing sends that kind of message." });
  }

  const channels = channelsFor(input.level);
  await db.notificationPreference.upsert({
    where: { userId_type: { userId, type: input.type } },
    update: channels,
    create: { userId, type: input.type, ...channels },
  });

  return { type: input.type, level: input.level };
}

export async function setQuietHoursService(userId: string, input: QuietHours) {
  const check = checkSchedule(input);
  if (!check.ok) throw new TRPCError({ code: "BAD_REQUEST", message: check.errors.join(" ") });

  await db.notificationSchedule.upsert({
    where: { userId },
    update: {
      quietHoursOn: input.quietHoursOn,
      quietFromMinutes: input.quietFromMinutes,
      quietToMinutes: input.quietToMinutes,
      digestAtMinutes: input.digestAtMinutes,
    },
    create: {
      userId,
      quietHoursOn: input.quietHoursOn,
      quietFromMinutes: input.quietFromMinutes,
      quietToMinutes: input.quietToMinutes,
      digestAtMinutes: input.digestAtMinutes,
    },
  });

  return input;
}
