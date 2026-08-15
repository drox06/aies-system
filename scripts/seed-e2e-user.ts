import { hash } from "@node-rs/argon2";
import { db } from "../src/lib/db";

/**
 * Creates the one account the end-to-end suite signs in as.
 *
 * ## Why a dedicated user with a fixed secret
 *
 * Every screen in this app sits behind a mandatory TOTP gate, which is why — until now — no UI had
 * ever been verified by anything but a person. An automated browser cannot read a code off somebody's
 * phone. It *can* compute one, if it knows the secret, which is exactly what `otpauth` does for the
 * server on every login.
 *
 * So this seeds a user whose TOTP secret is a known constant. That is a real credential and it is
 * treated like one:
 *
 * - The email is on `@e2e.local`, a domain that does not exist and cannot receive mail.
 * - The password comes from `E2E_PASSWORD` when set, so CI can supply its own.
 * - It is created **only when `ALLOW_E2E_USER` is set**, so running this against production by
 *   accident does nothing. There is no path from the app to this script.
 *
 * The secret being public is not a weakness here: the account exists on a development database, and
 * an attacker who can reach that database does not need a second factor.
 */

/** Base32, and deliberately a constant: the test computes codes from it. */
export const E2E_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
export const E2E_EMAIL = "e2e@e2e.local";

async function main() {
  if (!process.env.ALLOW_E2E_USER) {
    console.error(
      "Refusing: set ALLOW_E2E_USER=1 to seed the end-to-end account. It carries a publicly " +
        "known second factor and must never exist on a database holding real work.",
    );
    process.exitCode = 1;
    return;
  }

  const password = process.env.E2E_PASSWORD ?? "E2ePassw0rd!Aies";

  // The president's role, because the suite walks every screen and a narrower role would make half
  // of them 403 — which would test the permission system, not the pages.
  const role = await db.role.findUniqueOrThrow({ where: { key: "president" } });

  const user = await db.user.upsert({
    where: { email: E2E_EMAIL },
    update: {
      passwordHash: await hash(password),
      totpSecret: E2E_TOTP_SECRET,
      totpEnabled: true,
      totpEnrolledAt: new Date(),
      // Both false, or the suite lands on /change-password and /enroll-totp instead of the app.
      mustChangePassword: false,
      isActive: true,
      failedLoginCount: 0,
      lockedUntil: null,
      deletedAt: null,
    },
    create: {
      email: E2E_EMAIL,
      name: "End-to-end Test",
      passwordHash: await hash(password),
      totpSecret: E2E_TOTP_SECRET,
      totpEnabled: true,
      totpEnrolledAt: new Date(),
      isDemoUser: true,
    },
  });

  await db.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: role.id } },
    update: {},
    create: { userId: user.id, roleId: role.id },
  });

  console.log(`End-to-end account ready: ${E2E_EMAIL}`);
  console.log(`  password: ${password}`);
  console.log(`  TOTP secret is a constant in this file — codes are computed, never typed.`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
