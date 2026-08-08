import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notify,
  setNotificationPreference,
  unreadNotificationCount,
} from "@/server/core/notify/notify";
import {
  __resetNotificationTypesForTests,
  registerNotificationType,
} from "@/server/core/notify/registry";

const recipientId = `test-user-${randomUUID()}`;
const createdNotificationIds: string[] = [];

beforeEach(() => {
  registerNotificationType({
    key: "test.mentioned",
    label: "Test mentioned",
    defaultChannels: { inApp: true, email: false, digest: false },
    coalesceWindowMs: 5 * 60_000,
  });
  registerNotificationType({
    key: "test.no_coalesce",
    label: "Test no coalesce",
    defaultChannels: { inApp: true, email: false, digest: false },
  });
  registerNotificationType({
    key: "test.emails_too",
    label: "Test with email",
    defaultChannels: { inApp: true, email: true, digest: false },
  });
});

afterEach(async () => {
  __resetNotificationTypesForTests();
  await db.notification.deleteMany({ where: { recipientId } });
  await db.notificationPreference.deleteMany({ where: { userId: recipientId } });
  await db.job.deleteMany({ where: { queue: "notify_email" } });
  createdNotificationIds.length = 0;
});

describe("notify", () => {
  it("throws for an unregistered type", async () => {
    await expect(notify({ recipientId, type: "nope.not_registered", title: "x" })).rejects.toThrow(
      /Unknown notification type/,
    );
  }, 30_000);

  it("creates an in-app notification for a registered type", async () => {
    await notify({ recipientId, type: "test.no_coalesce", title: "Hello" });

    const rows = await listNotifications(recipientId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Hello");
    expect(rows[0]?.count).toBe(1);
  }, 30_000);

  it("coalesces repeated notifications for the same entity within the window into one row", async () => {
    for (let i = 0; i < 10; i++) {
      await notify({
        recipientId,
        type: "test.mentioned",
        title: `Comment ${i}`,
        entityType: "quotation",
        entityId: "q1",
      });
    }

    const rows = await listNotifications(recipientId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(10);
  }, 30_000);

  it("does not coalesce notifications for different entities", async () => {
    await notify({
      recipientId,
      type: "test.mentioned",
      title: "On Q1",
      entityType: "quotation",
      entityId: "q1",
    });
    await notify({
      recipientId,
      type: "test.mentioned",
      title: "On Q2",
      entityType: "quotation",
      entityId: "q2",
    });

    const rows = await listNotifications(recipientId);
    expect(rows).toHaveLength(2);
  }, 30_000);

  it("enqueues a notify_email job when the email channel is enabled", async () => {
    await notify({ recipientId, type: "test.emails_too", title: "Email me" });

    const jobs = await db.job.findMany({ where: { queue: "notify_email" } });
    expect(jobs.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("a per-user preference overrides the type's default channels", async () => {
    await setNotificationPreference(recipientId, "test.no_coalesce", { inApp: false });
    await notify({ recipientId, type: "test.no_coalesce", title: "Should not appear" });

    const rows = await listNotifications(recipientId);
    expect(rows).toHaveLength(0);
  }, 30_000);

  it("markNotificationRead and markAllNotificationsRead update readAt and the unread count", async () => {
    await notify({ recipientId, type: "test.no_coalesce", title: "One" });
    await notify({
      recipientId,
      type: "test.mentioned",
      title: "Two",
      entityType: "quotation",
      entityId: "q3",
    });

    expect(await unreadNotificationCount(recipientId)).toBe(2);

    const [first] = await listNotifications(recipientId);
    await markNotificationRead(recipientId, first!.id);
    expect(await unreadNotificationCount(recipientId)).toBe(1);

    await markAllNotificationsRead(recipientId);
    expect(await unreadNotificationCount(recipientId)).toBe(0);
  }, 30_000);
});
