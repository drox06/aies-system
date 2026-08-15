import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { enqueue } from "./queue";

export interface EventJobPayload {
  outboxId: string;
  event: string;
  payload: unknown;
}

/**
 * Relays unrelayed EventOutbox rows into the job queue (Spec.md §6: "Events are persisted to an
 * EventOutbox table... then relayed into the job queue by the cron drain"). Each row's job creation
 * and its `relayedAt` stamp happen in one transaction, keyed by `outbox:{id}` as the idempotency
 * key, so a crash between the two — or a duplicate cron invocation — can't double-enqueue.
 */
export async function relayOutboxToJobs(batchSize = 20): Promise<number> {
  const rows = await db.eventOutbox.findMany({
    where: { relayedAt: null },
    orderBy: { createdAt: "asc" },
    take: batchSize,
  });

  let relayed = 0;
  for (const row of rows) {
    try {
      await db.$transaction(async (tx) => {
        const jobPayload: EventJobPayload = {
          outboxId: row.id,
          event: row.event,
          payload: row.payload,
        };
        await enqueue(tx, "events", jobPayload, { idempotencyKey: `outbox:${row.id}` });
        await tx.eventOutbox.update({ where: { id: row.id }, data: { relayedAt: new Date() } });
      });
      relayed++;
    } catch (error) {
      /**
       * The row disappeared between the read above and the update — Prisma's P2025.
       *
       * One vanished row must not take the whole pass down with it. Before this, a single P2025
       * threw out of `relayOutboxToJobs`, which failed the entire `POST /api/cron/drain` with a
       * 500 — so every *other* pending event in the batch went unrelayed until the next tick, and
       * a row that stays missing would stall the same batch every time.
       *
       * Two ways it happens. In development it is the documented one: the test suite deletes its
       * own outbox rows while the dev drainer (src/instrumentation.ts, every 5s) is midway through
       * relaying them — see docs/PROGRESS.md's "run nothing else against the dev database" note.
       * In production it is a second drain invocation overlapping the first, which Vercel Cron can
       * do on a slow pass.
       *
       * Skipping is correct in both. The row is gone, so there is nothing to relay and nothing to
       * stamp; and if a concurrent pass took it, that pass enqueued the job under the same
       * `outbox:{id}` idempotency key. Anything else is re-thrown, because a failure that is *not*
       * a missing row is a real one and must still fail the drain.
       */
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        console.warn(
          `[relay] outbox row ${row.id} vanished mid-relay — skipped. Another drain or a test ` +
            `cleanup took it.`,
        );
        continue;
      }
      throw error;
    }
  }
  return relayed;
}
