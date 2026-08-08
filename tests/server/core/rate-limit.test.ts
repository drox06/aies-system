import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { checkRateLimit } from "@/server/core/rate-limit";

const usedKeys: string[] = [];

function testKey(): string {
  const key = `test:${randomUUID()}`;
  usedKeys.push(key);
  return key;
}

afterEach(async () => {
  if (usedKeys.length === 0) return;
  await db.rateLimitBucket.deleteMany({ where: { key: { in: usedKeys } } });
  usedKeys.length = 0;
});

describe("checkRateLimit", () => {
  it("allows requests up to the limit within the window", async () => {
    const key = testKey();
    for (let i = 0; i < 3; i++) {
      const result = await checkRateLimit(key, 3, 60_000);
      expect(result.allowed).toBe(true);
    }
  });

  it("denies the request once the limit is exceeded within the window", async () => {
    const key = testKey();
    await checkRateLimit(key, 2, 60_000);
    await checkRateLimit(key, 2, 60_000);
    const third = await checkRateLimit(key, 2, 60_000);

    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  it("resets the count once the window has elapsed", async () => {
    // A short-but-real window: it needs to be comfortably larger than the round trip to the
    // real dev database (network latency, not a mock), or the "within window" check below would
    // spuriously see the window as already expired.
    const windowMs = 3000;
    const key = testKey();
    await checkRateLimit(key, 1, windowMs);
    const withinWindow = await checkRateLimit(key, 1, windowMs);
    expect(withinWindow.allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, windowMs + 500));

    const afterWindow = await checkRateLimit(key, 1, windowMs);
    expect(afterWindow.allowed).toBe(true);
  }, 15_000);

  it("tracks independent keys independently", async () => {
    const keyA = testKey();
    const keyB = testKey();

    await checkRateLimit(keyA, 1, 60_000);
    const bStillAllowed = await checkRateLimit(keyB, 1, 60_000);

    expect(bStillAllowed.allowed).toBe(true);
  });
});
