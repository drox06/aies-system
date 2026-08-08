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
  }
  return relayed;
}
