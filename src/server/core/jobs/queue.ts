import { randomUUID } from "node:crypto";
import type { Job, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getJobHandler } from "./registry";

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
  /** A duplicate cron invocation must not double-enqueue (Spec.md §3.3). */
  idempotencyKey?: string;
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

/**
 * Accepts a transaction client so callers can enqueue in the same transaction as whatever wrote
 * the data the job depends on — pass `db` itself when no wrapping transaction is needed.
 */
export async function enqueue(
  client: Prisma.TransactionClient,
  queue: string,
  payload: unknown,
  opts: EnqueueOptions = {},
): Promise<void> {
  try {
    await client.job.create({
      data: {
        queue,
        payload: payload as Prisma.InputJsonValue,
        runAt: opts.runAt ?? new Date(),
        maxAttempts: opts.maxAttempts ?? 5,
        idempotencyKey: opts.idempotencyKey ?? null,
      },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) return; // already enqueued under this idempotencyKey
    throw err;
  }
}

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;

function computeBackoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
}

export interface DrainResult {
  claimed: number;
  succeeded: number;
  retrying: number;
  dead: number;
}

/** Claims and runs one batch. `POST /api/cron/drain` calls this every minute in production. */
export async function drain(
  options: { batchSize?: number; workerId?: string } = {},
): Promise<DrainResult> {
  const batchSize = options.batchSize ?? 10;
  const workerId = options.workerId ?? randomUUID();
  const now = new Date();

  const claimedIds = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Job"
      WHERE status = 'pending' AND "runAt" <= ${now}
      ORDER BY "runAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `;
    const ids = rows.map((row) => row.id);
    if (ids.length > 0) {
      await tx.job.updateMany({
        where: { id: { in: ids } },
        data: { status: "running", lockedAt: now, lockedBy: workerId },
      });
    }
    return ids;
  });

  const result: DrainResult = { claimed: claimedIds.length, succeeded: 0, retrying: 0, dead: 0 };

  for (const id of claimedIds) {
    const job = await db.job.findUniqueOrThrow({ where: { id } });
    const outcome = await runOne(job);
    result[outcome]++;
  }

  return result;
}

async function runOne(job: Job): Promise<"succeeded" | "retrying" | "dead"> {
  const handler = getJobHandler(job.queue);
  const attempt = job.attempts + 1;

  if (!handler) {
    await db.job.update({
      where: { id: job.id },
      data: {
        status: "dead",
        attempts: attempt,
        lastError: `No handler registered for queue "${job.queue}".`,
        lockedAt: null,
        lockedBy: null,
      },
    });
    return "dead";
  }

  try {
    await handler(job.payload, { attempt, jobId: job.id });
    await db.job.update({
      where: { id: job.id },
      data: {
        status: "succeeded",
        attempts: attempt,
        lockedAt: null,
        lockedBy: null,
        lastError: null,
      },
    });
    return "succeeded";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isDead = attempt >= job.maxAttempts;
    await db.job.update({
      where: { id: job.id },
      data: {
        status: isDead ? "dead" : "pending",
        attempts: attempt,
        lastError: message,
        lockedAt: null,
        lockedBy: null,
        runAt: isDead ? job.runAt : new Date(Date.now() + computeBackoffMs(attempt)),
      },
    });
    return isDead ? "dead" : "retrying";
  }
}
