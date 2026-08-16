import { db } from "../src/lib/db";

/**
 * Removes the end-to-end account.
 *
 * The companion to seed-e2e-user.ts, and the reason that script is guarded: the account carries a
 * publicly known TOTP secret and the president's role. On a database holding real work it exists for
 * the length of a Playwright run and no longer.
 *
 * A hard delete, not the soft delete the admin UI performs — a soft-deleted row keeps the password
 * hash and the TOTP secret, which is the whole thing being removed.
 */
const E2E_EMAIL = "e2e@e2e.local";

async function main() {
  const user = await db.user.findUnique({ where: { email: E2E_EMAIL }, select: { id: true } });
  if (!user) {
    console.log(`No ${E2E_EMAIL} account present. Nothing to do.`);
    return;
  }

  await db.notification.deleteMany({ where: { recipientId: user.id } });
  await db.notificationPreference.deleteMany({ where: { userId: user.id } });
  await db.userRole.deleteMany({ where: { userId: user.id } });
  await db.user.delete({ where: { id: user.id } });

  const check = await db.user.findUnique({ where: { email: E2E_EMAIL } });
  console.log(check ? "STILL PRESENT — investigate." : `Hard-deleted ${E2E_EMAIL}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
