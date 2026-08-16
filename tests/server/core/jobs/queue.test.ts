import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { __resetJobHandlersForTests, registerJobHandler } from "@/server/core/jobs/registry";
import { drain, enqueue } from "@/server/core/jobs/queue";

/**
 * These tests need a queue with nothing else in it, and say so rather than hoping.
 *
 * `drain` claims the **oldest pending jobs globally** — `ORDER BY "runAt" ASC LIMIT batchSize` — by
 * design, because that is what a worker should do. That makes every test here implicitly dependent
 * on the state of a shared table.
 *
 * It broke on 2026-08-17. Other test files emit domain events; relay.test.ts turns every unrelayed
 * outbox row into a job; nothing drains those, so pending jobs accumulate across runs. Once exactly
 * ten had piled up, `drain({ batchSize: 10 })` claimed them instead of the job the test had just
 * enqueued, and the assertions read "expected 'pending' to be 'succeeded'" — which looks like a
 * broken queue and is actually a full one.
 *
 * It failed as the suite grew rather than when anything changed, which is the worst way for a test
 * to be wrong: sessions 2 to 4 added event-emitting tests until the pile crossed the batch size.
 *
 * Pending jobs on a test database are detritus by definition — nothing asserts on another file's
 * unprocessed jobs — so clearing them is safe, and doing it here makes the precondition explicit
 * instead of accidental.
 */
beforeAll(async () => {
  await db.job.deleteMany({ where: { status: "pending" } });
});

const createdJobIds: string[] = [];

afterEach(async () => {
  __resetJobHandlersForTests();
  if (createdJobIds.length > 0) {
    await db.job.deleteMany({ where: { id: { in: createdJobIds } } });
    createdJobIds.length = 0;
  }
});

async function trackedEnqueue(
  queue: string,
  payload: unknown,
  opts: Parameters<typeof enqueue>[3] = {},
) {
  await enqueue(db, queue, payload, opts);
  const job = await db.job.findFirstOrThrow({
    where: { queue, idempotencyKey: opts.idempotencyKey ?? undefined },
    orderBy: { createdAt: "desc" },
  });
  createdJobIds.push(job.id);
  return job;
}

describe("enqueue", () => {
  it("creates a pending job", async () => {
    const job = await trackedEnqueue("test-queue", { hello: "world" });
    expect(job.status).toBe("pending");
    expect(job.payload).toEqual({ hello: "world" });
  }, 30_000);

  it("is idempotent on a duplicate idempotencyKey", async () => {
    const key = `test-${randomUUID()}`;
    await trackedEnqueue("test-queue", { n: 1 }, { idempotencyKey: key });
    await enqueue(db, "test-queue", { n: 2 }, { idempotencyKey: key }); // should no-op, not throw

    const rows = await db.job.findMany({ where: { idempotencyKey: key } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ n: 1 }); // the first write wins
  }, 30_000);
});

describe("drain", () => {
  it("claims a pending job, runs the handler, and marks it succeeded", async () => {
    const seen: unknown[] = [];
    registerJobHandler("test-succeed", (payload) => {
      seen.push(payload);
    });

    const job = await trackedEnqueue("test-succeed", { x: 1 });
    const result = await drain({ batchSize: 10 });

    expect(result.claimed).toBeGreaterThanOrEqual(1);
    expect(result.succeeded).toBeGreaterThanOrEqual(1);
    expect(seen).toContainEqual({ x: 1 });

    const updated = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe("succeeded");
    expect(updated.attempts).toBe(1);
    expect(updated.lockedAt).toBeNull();
  }, 30_000);

  it("retries a failing job with backoff, then dead-letters it after maxAttempts", async () => {
    registerJobHandler("test-fail", () => {
      throw new Error("simulated handler failure");
    });

    const job = await trackedEnqueue("test-fail", {}, {});
    await db.job.update({ where: { id: job.id }, data: { maxAttempts: 2 } });

    await drain({ batchSize: 10 });
    const afterFirst = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(afterFirst.status).toBe("pending"); // retryable — not dead yet
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.lastError).toContain("simulated handler failure");
    expect(afterFirst.runAt.getTime()).toBeGreaterThan(Date.now()); // pushed out by backoff

    // Force it due now rather than waiting out the real backoff window.
    await db.job.update({ where: { id: job.id }, data: { runAt: new Date() } });

    await drain({ batchSize: 10 });
    const afterSecond = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(afterSecond.status).toBe("dead");
    expect(afterSecond.attempts).toBe(2);
  }, 30_000);

  it("dead-letters a job on an unregistered queue immediately", async () => {
    const job = await trackedEnqueue("no-such-handler", {});
    await drain({ batchSize: 10 });

    const updated = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe("dead");
    expect(updated.lastError).toContain("No handler registered");
  }, 30_000);

  it("does not reclaim a job that is genuinely still running (recently locked)", async () => {
    const job = await trackedEnqueue("test-stuck", {});
    await db.job.update({
      where: { id: job.id },
      data: { status: "running", lockedAt: new Date(), lockedBy: "some-other-worker" },
    });

    const result = await drain({ batchSize: 10 });

    const stillRunning = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(stillRunning.status).toBe("running");
    expect(result.claimed).toBe(0);
  }, 30_000);

  it("specs/00-foundation.md §11: killing the drain mid-flight redelivers the event exactly once to an idempotent handler", async () => {
    let callCount = 0;
    registerJobHandler("test-idempotent", () => {
      callCount++;
    });

    const job = await trackedEnqueue("test-idempotent", {});

    // Simulate a worker that claimed the job and then got killed by the platform mid-handler,
    // before it could write back a status — the row is left stuck at "running" with a stale lock.
    await db.job.update({
      where: { id: job.id },
      data: {
        status: "running",
        lockedAt: new Date(Date.now() - 10 * 60_000), // 10 minutes ago — well past the 5m threshold
        lockedBy: "dead-worker",
      },
    });

    const result = await drain({ batchSize: 10 });

    expect(result.claimed).toBe(1);
    expect(callCount).toBe(1); // redelivered exactly once
    const updated = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe("succeeded");
  }, 30_000);
});
