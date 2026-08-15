import { randomBytes, timingSafeEqual } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Recovery codes: the way back in when the authenticator is gone.
 *
 * ## Why this exists, and why it is not the other thing
 *
 * specs/00-foundation.md §4.1 makes TOTP mandatory with "no opt-out, no admin-only carve-out", and
 * this build honoured that to the letter: a lost phone meant a permanent lockout, recoverable only
 * by an operator running `npm run reset:credentials` against the database. For a five-person company
 * whose president is one of the five, that is a real operational risk sitting behind a rule meant to
 * reduce risk.
 *
 * The obvious fix — let the president clear somebody's second factor from the admin screen — is the
 * wrong one, and `scripts/reset-user-credentials.ts` has said so since session 2: one compromised
 * officer account could then take over every other account without ever knowing a password. That is
 * privilege escalation straight through the control §4.1 calls non-negotiable.
 *
 * Recovery codes avoid both problems. Nobody can reset anybody else's factor. And a code is not an
 * opt-out: redeeming one signs you in **and revokes the enrolment**, so the very next screen is
 * enrolment again. The factor is restored, never skipped.
 *
 * ## Shape
 *
 * Ten codes, generated at enrolment, shown exactly once, stored as argon2 hashes. A recovery code is
 * a credential — a database leak that hands over the second factor in plaintext would defeat the
 * point of having one — so it is hashed with the same function as a password.
 */

/** Ten is the usual number: enough that losing a couple is survivable, few enough to write down. */
export const RECOVERY_CODE_COUNT = 10;

/**
 * Crockford-style base32 without `I`, `L`, `O` or `U`.
 *
 * These get printed and typed back in by a person reading their own handwriting under pressure.
 * Dropping the characters that are misread as 1, 0 and each other costs four symbols of entropy per
 * character and saves a support call.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GROUP = 5;
const GROUPS = 2;

/** `A7K2M-9PQR3` — 10 characters, ~50 bits, hyphenated so it can be read aloud. */
function generateCode(): string {
  const bytes = randomBytes(GROUP * GROUPS);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  const groups: string[] = [];
  for (let i = 0; i < GROUPS; i++) {
    groups.push(chars.slice(i * GROUP, (i + 1) * GROUP).join(""));
  }
  return groups.join("-");
}

/** Uppercased, hyphens and spaces stripped, so what a person types matches what was generated. */
export function normaliseCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "");
}

/**
 * Replaces every code this user has with a fresh set, and returns the plaintext **once**.
 *
 * Replaces rather than appends: a new set is issued at enrolment and at explicit regeneration, and
 * in both cases the old codes must stop working. Leaving them valid would mean a code written down
 * two phones ago still opens the account.
 */
export async function issueRecoveryCodes(
  userId: string,
  tx: Prisma.TransactionClient | PrismaClient = db,
): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateCode);

  await tx.recoveryCode.deleteMany({ where: { userId } });
  await tx.recoveryCode.createMany({
    data: await Promise.all(
      codes.map(async (code) => ({ userId, codeHash: await hash(normaliseCode(code)) })),
    ),
  });

  // The only time these are ever readable. Nothing logs them, nothing stores them, and there is no
  // procedure to recover them — a lost set is regenerated, not retrieved.
  return codes;
}

export interface RedeemResult {
  ok: boolean;
  /** How many unused codes are left, so the screen can warn before they run out. */
  remaining: number;
}

/**
 * Spends one code, if it matches.
 *
 * **Every unused code is checked even after a match**, and the comparison result is accumulated
 * rather than returned early. Argon2 verification is slow and deliberately so; a loop that returns
 * on first match leaks, through timing, roughly where in the list the code sat. That is a small
 * leak, and this is a small loop — but the fix is three lines and the alternative is explaining why
 * it did not matter.
 *
 * The caller is responsible for revoking the TOTP enrolment on success; see
 * `redeemRecoveryCodeForLogin`.
 */
export async function redeemRecoveryCode(
  userId: string,
  input: string,
  ip?: string | null,
): Promise<RedeemResult> {
  const candidate = normaliseCode(input);
  if (candidate.length === 0) return { ok: false, remaining: 0 };

  const codes = await db.recoveryCode.findMany({
    where: { userId, usedAt: null },
    orderBy: { createdAt: "asc" },
  });

  let matched: string | null = null;
  for (const row of codes) {
    let ok = false;
    try {
      ok = await verify(row.codeHash, candidate);
    } catch {
      // A corrupt hash must not abort the loop — the remaining codes are still valid credentials.
      ok = false;
    }
    if (ok && matched === null) matched = row.id;
  }

  if (matched === null) {
    return { ok: false, remaining: codes.length };
  }

  // Conditional on `usedAt` still being null, so two simultaneous redemptions of the same code
  // cannot both succeed.
  const spent = await db.recoveryCode.updateMany({
    where: { id: matched, usedAt: null },
    data: { usedAt: new Date(), usedIp: ip ?? null },
  });
  if (spent.count === 0) {
    return { ok: false, remaining: codes.length - 1 };
  }

  return { ok: true, remaining: codes.length - 1 };
}

/** How many unused codes remain — for the warning on the account screen. */
export async function countRemainingRecoveryCodes(userId: string): Promise<number> {
  return db.recoveryCode.count({ where: { userId, usedAt: null } });
}

/**
 * Constant-time string comparison, for the one place a code is compared without argon2.
 *
 * Unused today; exported because the next person to add a comparison here should reach for this
 * rather than `===`.
 */
export function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
