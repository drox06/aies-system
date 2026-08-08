import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
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
