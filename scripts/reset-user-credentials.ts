/**
 * Reset one user's sign-in credentials back to first-run state.
 *
 *   npm run reset:credentials -- <email> [newPassword]
 *
 * Sets a known password, forces a change at next login, clears TOTP enrolment, and clears any
 * lockout. The user then walks the full first-run flow again: change password, then enrol TOTP.
 *
 * This exists because there is deliberately no self-service recovery path: specs/00-foundation.md
 * §4.1 makes TOTP mandatory with "no opt-out, no admin-only carve-out", and the app has no
 * recovery-code redemption. A lost authenticator therefore needs an operator with database access,
 * and that operation should be one reviewed script rather than someone improvising SQL against
 * production at speed.
 *
 * Deliberately NOT wired into the admin UI. Resetting another user's second factor from a signed-in
 * session would be a privilege-escalation path straight through the control §4.1 calls
 * non-negotiable — one compromised president account could then take over every other account
 * without ever knowing a password.
 */
import { hash } from "@node-rs/argon2";
import { PrismaClient } from "@prisma/client";

try {
  process.loadEnvFile(".env");
} catch {
  // CI/production supply real env vars directly.
}

const db = new PrismaClient();

const email = process.argv[2];
const newPassword = process.argv[3] ?? "ChangeMe123!Aies";

if (!email) {
  console.error("Usage: npm run reset:credentials -- <email> [newPassword]");
  process.exit(2);
}

async function main(): Promise<void> {
  const existing = await db.user.findUnique({
    where: { email },
    select: { id: true, name: true, totpEnabled: true },
  });
  if (!existing) {
    console.error(`No user with email "${email}".`);
    process.exit(1);
  }

  await db.user.update({
    where: { email },
    data: {
      passwordHash: await hash(newPassword),
      mustChangePassword: true,
      // Clearing the secret as well as the flag matters: leaving a stale secret behind would let
      // an old authenticator entry keep working after re-enrolment.
      totpSecret: null,
      totpEnabled: false,
      totpEnrolledAt: null,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  console.log(`Reset ${existing.name} <${email}>.`);
  console.log(`  Temporary password: ${newPassword}`);
  console.log(`  Next sign-in will force a password change, then TOTP enrolment.`);
  console.log(
    `  Previous TOTP enrolment ${existing.totpEnabled ? "was active and has been revoked" : "was not active"}.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
