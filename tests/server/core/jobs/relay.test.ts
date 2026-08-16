import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";

/**
 * Same precondition as queue.test.ts, and for the same reason: `drain` takes the oldest pending jobs
 * in the table, so a backlog left by other files starves this one's own job. See the long note there
 * — it failed on 2026-08-17 once exactly ten had accumulated.
 */
beforeAll(async () => {
  await db.job.deleteMany({ where: { status: "pending" } });
});
import { emit } from "@/server/core/events/emit";
import { relayOutboxToJobs } from "@/server/core/jobs/relay";
import { drain } from "@/server/core/jobs/queue";
import "@/server/core/jobs/handlers/events"; // registers the real "events" queue handler

const createdOutboxIds: string[] = [];
const createdJobIds: string[] = [];

afterEach(async () => {
  if (createdJobIds.length > 0) {
    await db.job.deleteMany({ where: { id: { in: createdJobIds } } });
    createdJobIds.length = 0;
  }
  if (createdOutboxIds.length > 0) {
    await db.eventOutbox.deleteMany({ where: { id: { in: createdOutboxIds } } });
    createdOutboxIds.length = 0;
  }
});

describe("relayOutboxToJobs", () => {
  it("relays an unrelayed outbox row into an 'events' job and stamps relayedAt", async () => {
    const requestId = `test-${randomUUID()}`;
    const outboxRow = await db.$transaction(async (tx) => {
      await emit(tx, "user.created", { userId: "u1" }, { requestId });
      return tx.eventOutbox.findFirstOrThrow({ where: { requestId } });
    });
    createdOutboxIds.push(outboxRow.id);

    const relayedCount = await relayOutboxToJobs();
    expect(relayedCount).toBeGreaterThanOrEqual(1);

    const updatedOutbox = await db.eventOutbox.findUniqueOrThrow({ where: { id: outboxRow.id } });
    expect(updatedOutbox.relayedAt).not.toBeNull();

    const job = await db.job.findFirstOrThrow({
      where: { idempotencyKey: `outbox:${outboxRow.id}` },
    });
    createdJobIds.push(job.id);
    expect(job.queue).toBe("events");
    expect(job.payload).toEqual({
      outboxId: outboxRow.id,
      event: "user.created",
      payload: { userId: "u1" },
    });
  }, 30_000);

  it("does not re-relay an already-relayed row on a second call (idempotent)", async () => {
    const requestId = `test-${randomUUID()}`;
    const outboxRow = await db.$transaction(async (tx) => {
      await emit(tx, "user.created", { userId: "u2" }, { requestId });
      return tx.eventOutbox.findFirstOrThrow({ where: { requestId } });
    });
    createdOutboxIds.push(outboxRow.id);

    await relayOutboxToJobs();
    const job = await db.job.findFirstOrThrow({
      where: { idempotencyKey: `outbox:${outboxRow.id}` },
    });
    createdJobIds.push(job.id);

    // Second "cron invocation": the row is already relayed, so this must not create a second job.
    await relayOutboxToJobs();
    const jobs = await db.job.findMany({ where: { idempotencyKey: `outbox:${outboxRow.id}` } });
    expect(jobs).toHaveLength(1);
  }, 30_000);

  it("skips a row that vanishes mid-pass, and still relays the rest of the batch", async () => {
    /**
     * The failure this prevents was seen live, in the dev server log: a single P2025 threw out of
     * `relayOutboxToJobs` and failed the whole `POST /api/cron/drain` with a 500 — so every other
     * pending event in that batch went unrelayed until the next tick.
     *
     * Two ways a row disappears. In development it is the test suite deleting its own outbox rows
     * while the 5-second dev drainer is midway through them. In production it is a second drain
     * overlapping the first, which Vercel Cron can do on a slow pass.
     *
     * Simulated here by deleting one row after it has been read but before it is relayed, which is
     * exactly the window that matters. `doomed` is deliberately emitted *first* so it sorts ahead
     * of `survivor` in the batch — a version that gave up on the first bad row would leave the
     * second unrelayed, and this would fail.
     */
    const doomedRequestId = `test-doomed-${randomUUID()}`;
    const survivorRequestId = `test-survivor-${randomUUID()}`;

    const doomed = await db.$transaction(async (tx) => {
      await emit(tx, "user.created", { userId: "gone" }, { requestId: doomedRequestId });
      return tx.eventOutbox.findFirstOrThrow({ where: { requestId: doomedRequestId } });
    });
    const survivor = await db.$transaction(async (tx) => {
      await emit(tx, "user.created", { userId: "kept" }, { requestId: survivorRequestId });
      return tx.eventOutbox.findFirstOrThrow({ where: { requestId: survivorRequestId } });
    });
    createdOutboxIds.push(survivor.id);

    // The concurrent deletion, in the window between the relay's read and its update.
    await db.eventOutbox.delete({ where: { id: doomed.id } });

    await expect(relayOutboxToJobs()).resolves.toBeGreaterThanOrEqual(1);

    const job = await db.job.findFirstOrThrow({
      where: { idempotencyKey: `outbox:${survivor.id}` },
    });
    createdJobIds.push(job.id);

    const relayedSurvivor = await db.eventOutbox.findUniqueOrThrow({ where: { id: survivor.id } });
    expect(relayedSurvivor.relayedAt).not.toBeNull();
  }, 30_000);

  it("end to end: emit -> relay -> drain runs the events handler and the job succeeds", async () => {
    const requestId = `test-${randomUUID()}`;
    const outboxRow = await db.$transaction(async (tx) => {
      // No module has subscribed to this event yet — the handler should still run cleanly as a
      // no-op dispatch, and the job should still be marked succeeded.
      await emit(tx, "user.created", { userId: "u3" }, { requestId });
      return tx.eventOutbox.findFirstOrThrow({ where: { requestId } });
    });
    createdOutboxIds.push(outboxRow.id);

    await relayOutboxToJobs();
    const job = await db.job.findFirstOrThrow({
      where: { idempotencyKey: `outbox:${outboxRow.id}` },
    });
    createdJobIds.push(job.id);

    await drain({ batchSize: 10 });

    const updatedJob = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(updatedJob.status).toBe("succeeded");
  }, 30_000);
});
