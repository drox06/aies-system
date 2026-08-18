import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * specs/04-operations-projects.md §14's outbox, server side.
 *
 * ## What this is for
 *
 * §14 calls the offline story "the hardest technical requirement in the platform" and then says the
 * part that actually matters in one line: **"Server operations are idempotent on that UUID."**
 *
 * The scenario is not exotic. A technician spends an afternoon in a plant with no signal. The phone
 * reconnects somewhere on the drive home, starts replaying the queue, and loses the connection again
 * halfway through — after the server committed the write but before the reply arrived. The client,
 * correctly, retries. Without something to recognise the retry, the second attempt creates a second
 * delivery attempt, a second progress log, a second everything, and nobody finds out until a report
 * is wrong weeks later.
 *
 * ## Why rejections are stored rather than thrown
 *
 * §14's conflict policy is a correctness requirement, in its own words: the server "surfaces the
 * conflict on next sync — **never silently discards work**", because "losing a technician's
 * afternoon destroys trust in the system permanently".
 *
 * A `TRPCError` satisfies none of that. It exists in a response body, and if the tab is closed, the
 * app is backgrounded by the OS, or the connection drops while the error is in flight, it is gone —
 * and so is the record that the work was ever attempted. So a business-rule refusal is **committed**
 * as a `rejected` row carrying the reason, and the client reads it back on the next sync and shows
 * the technician what happened to their work. The error is still thrown, for the online case where
 * somebody is looking at the screen; the row is what survives when nobody is.
 *
 * The distinction this rests on is the platform's usual one: a status the server returned and a
 * record of what it decided are different things, and only the second can be read tomorrow.
 */

export const FIELD_SUBMISSION_ENTITY_TYPE = "FieldSubmission";

/** Applied is the happy path; rejected is a business rule saying no, on the record. */
export const SUBMISSION_STATUSES = ["applied", "rejected"] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

/**
 * A stable digest of the payload.
 *
 * Object keys are sorted before hashing. `JSON.stringify` preserves insertion order, and a client
 * that rebuilds a queued payload — after a page reload, say — can easily produce the same data with
 * its keys in a different order. Hashing that naively would report a payload mismatch on a perfectly
 * ordinary replay, which is worse than not checking at all: it would train whoever reads the logs to
 * ignore the one signal that means a real client bug.
 *
 * Same reasoning, and the same fix, as docs/DECISIONS.md #70's jsonb comparison.
 */
export function hashPayload(payload: unknown): string {
  const canonical = JSON.stringify(payload ?? null, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : entry,
  );
  return createHash("sha256").update(canonical).digest("hex");
}

export interface ReplayedResult<T> {
  /** True when this call did the work; false when it recognised a replay and answered from the record. */
  applied: boolean;
  /** True when the first attempt was refused by a business rule, and this is that refusal replayed. */
  rejected: boolean;
  result: T | null;
  rejectionReason: string | null;
  submissionId: string;
}

interface RunInput<T> {
  clientUuid: string;
  userId: string;
  operation: string;
  payload: unknown;
  capturedAt?: Date | null;
  /** The actual work. Returns what should be replayed to a retry, plus what it touched. */
  run: () => Promise<{ result: T; entityType?: string | null; entityId?: string | null }>;
}

/**
 * Runs a field write exactly once per `clientUuid`.
 *
 * The shape is deliberately "do the work, then record it" rather than "claim the id, then do the
 * work". Claiming first would need a `pending` state and an answer to what happens when the process
 * dies holding a claim — a queue that can wedge, needing its own sweep. Recording after means a
 * crash mid-write leaves no row at all, and the replay simply runs, which is the safe direction to
 * fail in. The cost is that two *simultaneous* replays of the same UUID can both do the work; the
 * unique constraint means only one commits, and the loser is retried by its caller. Field replays
 * are sequential from one device, so this is a narrow window that fails safe rather than a race that
 * needs a lock.
 */
export async function runFieldWrite<T>(input: RunInput<T>): Promise<ReplayedResult<T>> {
  const payloadHash = hashPayload(input.payload);

  const seen = await db.fieldSubmission.findUnique({ where: { clientUuid: input.clientUuid } });
  if (seen) return replayOf<T>(seen, payloadHash, input);

  let outcome: { result: T; entityType?: string | null; entityId?: string | null };
  try {
    outcome = await input.run();
  } catch (error) {
    // A business rule said no. §14: record it, so the technician is told on the next sync rather
    // than losing the work to an error message nobody was there to read.
    if (error instanceof TRPCError && error.code === "BAD_REQUEST") {
      const rejected = await recordRejection(input, payloadHash, error.message);
      // Still thrown, for the online caller who is watching the screen. The row is what survives
      // for the one who is not.
      throw Object.assign(error, { submissionId: rejected.id });
    }
    // Anything else — a crash, a lost connection to the database, a bug — is *not* recorded as a
    // rejection. It is not a decision, and writing it down as one would tell the technician their
    // work was refused when in truth nobody knows whether it landed. The retry is the right answer.
    throw error;
  }

  try {
    const applied = await db.fieldSubmission.create({
      data: {
        clientUuid: input.clientUuid,
        userId: input.userId,
        operation: input.operation,
        payloadHash,
        status: "applied",
        result: (outcome.result ?? null) as Prisma.InputJsonValue,
        entityType: outcome.entityType ?? null,
        entityId: outcome.entityId ?? null,
        capturedAt: input.capturedAt ?? null,
      },
    });
    return {
      applied: true,
      rejected: false,
      result: outcome.result,
      rejectionReason: null,
      submissionId: applied.id,
    };
  } catch (error) {
    // Lost the race described above: another replay of this UUID committed first. Its row is the
    // authority, and the work this call did is the duplicate. That is a real defect in the caller's
    // service if it is not itself idempotent, so it is worth saying loudly rather than swallowing.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002" &&
      (error.meta?.target as string[] | undefined)?.includes("clientUuid")
    ) {
      console.error(
        `[field-sync] concurrent replay of ${input.clientUuid} (${input.operation}) — the work ran twice`,
      );
      const winner = await db.fieldSubmission.findUniqueOrThrow({
        where: { clientUuid: input.clientUuid },
      });
      return replayOf<T>(winner, payloadHash, input);
    }
    throw error;
  }
}

function replayOf<T>(
  seen: {
    id: string;
    payloadHash: string;
    status: string;
    result: Prisma.JsonValue;
    rejectionReason: string | null;
    operation: string;
  },
  payloadHash: string,
  input: { clientUuid: string; operation: string },
): ReplayedResult<T> {
  // Same id, different content. Not something to answer from the record — the client would be told
  // its second, different write succeeded when nothing of the sort happened.
  if (seen.payloadHash !== payloadHash) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        `This submission reuses an id that was already used for different content ` +
        `(${input.clientUuid}). Nothing was written. Report this — a device is generating ids it has ` +
        `used before, and some of that work may not be where it looks like it is.`,
    });
  }

  return {
    applied: false,
    rejected: seen.status === "rejected",
    result: (seen.result ?? null) as T | null,
    rejectionReason: seen.rejectionReason,
    submissionId: seen.id,
  };
}

async function recordRejection(
  input: { clientUuid: string; userId: string; operation: string; capturedAt?: Date | null },
  payloadHash: string,
  reason: string,
) {
  return db.fieldSubmission.create({
    data: {
      clientUuid: input.clientUuid,
      userId: input.userId,
      operation: input.operation,
      payloadHash,
      status: "rejected",
      rejectionReason: reason,
      capturedAt: input.capturedAt ?? null,
    },
  });
}

/**
 * What this person needs to be told about work they queued.
 *
 * Rejections first and unacknowledged only: an applied write nobody looked at is fine, a refused one
 * nobody looked at is somebody's afternoon that did not happen and they do not know it yet.
 */
export async function pendingSyncOutcomesService(userId: string) {
  const rows = await db.fieldSubmission.findMany({
    where: { userId, acknowledgedAt: null },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    take: 200,
    select: {
      id: true,
      clientUuid: true,
      operation: true,
      status: true,
      rejectionReason: true,
      entityType: true,
      entityId: true,
      capturedAt: true,
      createdAt: true,
    },
  });

  return {
    rejected: rows.filter((row) => row.status === "rejected"),
    applied: rows.filter((row) => row.status === "applied"),
  };
}

/** The client confirming it has shown these outcomes to the person holding the device. */
export async function acknowledgeSyncOutcomesService(userId: string, submissionIds: string[]) {
  if (submissionIds.length === 0) return { acknowledged: 0 };
  const result = await db.fieldSubmission.updateMany({
    // Scoped to the caller: acknowledging is saying "I showed this to somebody", and only the
    // device holding this session can say that about its own user's work.
    where: { id: { in: submissionIds }, userId, acknowledgedAt: null },
    data: { acknowledgedAt: new Date() },
  });
  return { acknowledged: result.count };
}
