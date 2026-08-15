import { randomUUID } from "node:crypto";
import { hash } from "@node-rs/argon2";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  countRemainingRecoveryCodes,
  issueRecoveryCodes,
  normaliseCode,
  redeemRecoveryCode,
  RECOVERY_CODE_COUNT,
} from "@/server/core/auth/recovery-codes";

/**
 * Recovery codes — the way back in when the authenticator is gone.
 *
 * specs/00-foundation.md §4.1 makes TOTP mandatory with "no opt-out", and this build honoured that
 * so completely that a lost phone was a permanent lockout. These codes are the amendment, and they
 * are only defensible if they behave exactly like the credential they are: single use, hashed at
 * rest, and invalidated as a set when a new set is issued.
 *
 * Most of what follows tests refusals, because a recovery code that works twice is worse than no
 * recovery code at all.
 */

const suffix = randomUUID().slice(0, 8);
const userIds: string[] = [];

async function makeUser() {
  const user = await db.user.create({
    data: {
      email: `recovery-${randomUUID().slice(0, 8)}@test.local`,
      name: `Recovery Test ${suffix}`,
      passwordHash: await hash("irrelevant-for-these-tests"),
      totpEnabled: true,
      totpSecret: "JBSWY3DPEHPK3PXP",
    },
  });
  userIds.push(user.id);
  return user;
}

afterAll(async () => {
  await db.recoveryCode.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("issuing", () => {
  it("hands back ten codes and stores none of them in plaintext", async () => {
    const user = await makeUser();
    const codes = await issueRecoveryCodes(user.id);

    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);

    const stored = await db.recoveryCode.findMany({ where: { userId: user.id } });
    expect(stored).toHaveLength(RECOVERY_CODE_COUNT);
    // The whole point of hashing: a database leak must not hand over the second factor.
    for (const row of stored) {
      expect(codes).not.toContain(row.codeHash);
      expect(row.codeHash.startsWith("$argon2")).toBe(true);
    }
  }, 60_000);

  it("gives every code a distinct value", async () => {
    const user = await makeUser();
    const codes = await issueRecoveryCodes(user.id);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
  }, 60_000);

  it("replaces the previous set rather than adding to it", async () => {
    // A code written down two phones ago must stop working, or "regenerate" means nothing.
    const user = await makeUser();
    const old = await issueRecoveryCodes(user.id);
    await issueRecoveryCodes(user.id);

    expect(await countRemainingRecoveryCodes(user.id)).toBe(RECOVERY_CODE_COUNT);
    const result = await redeemRecoveryCode(user.id, old[0]!);
    expect(result.ok).toBe(false);
  }, 60_000);
});

describe("redeeming", () => {
  it("accepts a valid code once", async () => {
    const user = await makeUser();
    const codes = await issueRecoveryCodes(user.id);

    const first = await redeemRecoveryCode(user.id, codes[3]!);
    expect(first.ok).toBe(true);
    expect(first.remaining).toBe(RECOVERY_CODE_COUNT - 1);
  }, 60_000);

  it("refuses the same code a second time", async () => {
    // The single most important property here. A replayable code is a permanent bypass of the
    // second factor for anyone who ever saw it.
    const user = await makeUser();
    const codes = await issueRecoveryCodes(user.id);

    expect((await redeemRecoveryCode(user.id, codes[0]!)).ok).toBe(true);
    expect((await redeemRecoveryCode(user.id, codes[0]!)).ok).toBe(false);
    expect(await countRemainingRecoveryCodes(user.id)).toBe(RECOVERY_CODE_COUNT - 1);
  }, 60_000);

  it("leaves the other codes usable", async () => {
    const user = await makeUser();
    const codes = await issueRecoveryCodes(user.id);

    await redeemRecoveryCode(user.id, codes[0]!);
    expect((await redeemRecoveryCode(user.id, codes[1]!)).ok).toBe(true);
    expect(await countRemainingRecoveryCodes(user.id)).toBe(RECOVERY_CODE_COUNT - 2);
  }, 60_000);

  it("refuses a code belonging to somebody else", async () => {
    const mine = await makeUser();
    const theirs = await makeUser();
    const theirCodes = await issueRecoveryCodes(theirs.id);
    await issueRecoveryCodes(mine.id);

    const result = await redeemRecoveryCode(mine.id, theirCodes[0]!);
    expect(result.ok).toBe(false);
    // And theirs is still unspent.
    expect(await countRemainingRecoveryCodes(theirs.id)).toBe(RECOVERY_CODE_COUNT);
  }, 60_000);

  it("refuses nonsense and empty input without spending anything", async () => {
    const user = await makeUser();
    await issueRecoveryCodes(user.id);

    for (const attempt of ["", "   ", "not-a-code", "000000"]) {
      expect((await redeemRecoveryCode(user.id, attempt)).ok).toBe(false);
    }
    expect(await countRemainingRecoveryCodes(user.id)).toBe(RECOVERY_CODE_COUNT);
  }, 60_000);

  it("accepts a code however the person typed it", async () => {
    // These are read off paper and retyped by somebody who has just lost their phone. Case and
    // the hyphen are presentation, not content.
    const user = await makeUser();
    const codes = await issueRecoveryCodes(user.id);
    const code = codes[0]!;

    const messy = ` ${code.toLowerCase().replace("-", " ")} `;
    expect(normaliseCode(messy)).toBe(normaliseCode(code));
    expect((await redeemRecoveryCode(user.id, messy)).ok).toBe(true);
  }, 60_000);

  it("records when a code was spent, rather than deleting the row", async () => {
    // "Which code was used, and when" is evidence about a real security event.
    const user = await makeUser();
    const codes = await issueRecoveryCodes(user.id);

    await redeemRecoveryCode(user.id, codes[0]!, "203.0.113.7");

    const spent = await db.recoveryCode.findMany({
      where: { userId: user.id, usedAt: { not: null } },
    });
    expect(spent).toHaveLength(1);
    expect(spent[0]!.usedIp).toBe("203.0.113.7");
    expect(await db.recoveryCode.count({ where: { userId: user.id } })).toBe(RECOVERY_CODE_COUNT);
  }, 60_000);

  it("reports zero remaining once every code is spent", async () => {
    const user = await makeUser();
    const codes = await issueRecoveryCodes(user.id);

    for (const code of codes) {
      expect((await redeemRecoveryCode(user.id, code)).ok).toBe(true);
    }
    expect(await countRemainingRecoveryCodes(user.id)).toBe(0);

    // And a spent set locks the door again — which is why the screen warns as they run low.
    expect((await redeemRecoveryCode(user.id, codes[0]!)).ok).toBe(false);
  }, 120_000);

  it("uses an alphabet that cannot be misread", async () => {
    // I, L, O and U are the characters people get wrong copying by hand, and this is a credential
    // typed from paper under pressure.
    const user = await makeUser();
    const codes = await issueRecoveryCodes(user.id);

    for (const code of codes) {
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    }
  }, 60_000);
});
