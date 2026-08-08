import { db } from "@/lib/db";

/** specs/00-foundation.md §4.1: "5 failures -> 15-minute lockout, logged and notified to admins." */
export const MAX_FAILED_LOGIN_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

export function isLockedOut(user: { lockedUntil: Date | null }, now: Date = new Date()): boolean {
  return user.lockedUntil !== null && user.lockedUntil > now;
}

export async function recordFailedLogin(userId: string): Promise<void> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const failedLoginCount = user.failedLoginCount + 1;
  const lockingOut = failedLoginCount >= MAX_FAILED_LOGIN_ATTEMPTS;

  await db.user.update({
    where: { id: userId },
    data: {
      failedLoginCount: lockingOut ? 0 : failedLoginCount,
      lockedUntil: lockingOut
        ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
        : user.lockedUntil,
    },
  });

  // TODO(module 00 session 3): audit-log this and notify admins once the audit log and notify
  // services exist (specs/00-foundation.md §4.1 — "logged and notified to admins").
}

export async function recordSuccessfulLogin(userId: string): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: { failedLoginCount: 0, lockedUntil: null },
  });
}
