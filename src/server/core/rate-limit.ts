import { db } from "@/lib/db";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

interface RateLimitRow {
  count: number;
  windowStart: Date;
}

/**
 * Fixed-window rate limit, atomic via a single upsert (ON CONFLICT) so concurrent requests can't
 * race past the limit through a separate check-then-increment. If the existing window has
 * expired, the row resets to count 1 and a fresh window start; otherwise it increments in place.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowMs);

  const rows = await db.$queryRaw<RateLimitRow[]>`
    INSERT INTO "RateLimitBucket" (key, "windowStart", count)
    VALUES (${key}, ${now}, 1)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN "RateLimitBucket"."windowStart" > ${cutoff} THEN "RateLimitBucket".count + 1
        ELSE 1
      END,
      "windowStart" = CASE
        WHEN "RateLimitBucket"."windowStart" > ${cutoff} THEN "RateLimitBucket"."windowStart"
        ELSE ${now}
      END
    RETURNING count, "windowStart"
  `;

  const row = rows[0];
  if (!row) {
    throw new Error("Rate limit upsert returned no row.");
  }

  if (row.count > limit) {
    const retryAfterMs = row.windowStart.getTime() + windowMs - now.getTime();
    return { allowed: false, retryAfterMs: Math.max(0, retryAfterMs) };
  }

  return { allowed: true };
}
