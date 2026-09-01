import webpush from "web-push";
import { db } from "@/lib/db";

/**
 * §7's actual answer to "make the phone ring" — a real Web Push send, not just the in-app bell.
 *
 * ## Why this exists as its own file
 *
 * `notify()` decides *whether* somebody should be told and *whether* it can wait for quiet hours to
 * end. This decides how to reach a device once that decision is made, and nothing here overrides the
 * other's judgement — it is called after, never instead of, writing the `Notification` row.
 *
 * ## Configured or not
 *
 * The three `VAPID_*` env vars are set once per deployment (`.env.example`). Until they are, every
 * call here is a no-op — the in-app bell still works exactly as it always has, because the whole
 * point of building this as an addition to `notify()` rather than a replacement is that a missing or
 * wrong key can never take the existing channel down with it.
 */

let configured = false;
function ensureConfigured(): boolean {
  if (configured) return true;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) return false;
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

/** What the client needs to call `PushManager.subscribe()` — not a secret, safe to send. `null`
 *  when the deployment has no VAPID keys configured, so the settings screen can say so plainly
 *  rather than offering a button that will fail. */
export function publicVapidKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

export interface SubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

/**
 * Records a device. `endpoint` is the natural key — the same phone re-subscribing (a browser
 * update, a cleared cache) arrives with the same endpoint and should update in place, not pile up
 * a second row nothing ever cleans out.
 */
export async function subscribeDevice(userId: string, input: SubscriptionInput) {
  return db.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    update: { userId, p256dh: input.p256dh, auth: input.auth, userAgent: input.userAgent ?? null },
    create: {
      userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent ?? null,
    },
  });
}

/** Scoped to the caller — a person can only ever remove their own device, never guess an endpoint
 *  and detach somebody else's. */
export async function unsubscribeDevice(userId: string, endpoint: string) {
  await db.pushSubscription.deleteMany({ where: { userId, endpoint } });
}

export function listDevicesForUser(userId: string) {
  return db.pushSubscription.findMany({
    where: { userId },
    select: { id: true, endpoint: true, userAgent: true, createdAt: true, lastSeenAt: true },
    orderBy: { createdAt: "desc" },
  });
}

export interface PushPayload {
  title: string;
  body?: string;
  /** Where tapping the notification should take somebody. `/my-work` for a task, say. */
  url?: string;
}

/**
 * Sends to every device a person has subscribed, best-effort per device.
 *
 * One dead subscription must never stop the others — a phone that was reset in March should not be
 * the reason a desktop push silently stops arriving in September. A subscription the push service
 * reports as gone (410, or 404 — some services use it instead) is removed here rather than left to
 * fail forever; anything else is logged and left, since it may be transient.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!ensureConfigured()) return;

  const subscriptions = await db.pushSubscription.findMany({ where: { userId } });
  if (subscriptions.length === 0) return;

  const body = JSON.stringify(payload);

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
        );
        await db.pushSubscription.update({
          where: { id: sub.id },
          data: { lastSeenAt: new Date() },
        });
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await db.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        } else {
          console.error(`[push] send failed for subscription ${sub.id}`, error);
        }
      }
    }),
  );
}
