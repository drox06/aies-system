import { offlineDb, offlineSupported, type OutboxItem, type OutboxStatus } from "./db";

/**
 * specs/04-operations-projects.md §14's outbox, client side.
 *
 * The server half (`field-sync.ts`) makes replays safe. This half decides *when* to replay, and its
 * whole job is to be boring and to lose nothing.
 *
 * ## The rules it follows
 *
 * **Delete only on acknowledgement.** An item leaves the queue when the server has confirmed it by
 * `clientUuid`, never on send and never on a response that might have belonged to something else.
 * The cost of keeping an item too long is one redundant replay, which the server absorbs. The cost
 * of deleting it too early is a technician's work, permanently.
 *
 * **A refusal is not a failure.** A business rule saying no is a final answer and retrying it
 * forever is pointless noise; a lost connection is temporary and retrying is the only correct
 * response. They are different states — `rejected` and `failed` — because treating them alike means
 * either spinning on a refusal or giving up on a network blip.
 *
 * **Sequential, oldest first.** §13's delivery attempts are ordered facts about a day, and replaying
 * them in parallel would let attempt 3 land before attempt 1. Slower, and right.
 */

export interface EnqueueInput {
  procedure: string;
  operation: string;
  payload: unknown;
  label: string;
  attachmentIds?: string[];
}

/** A UUID from the platform's own generator, which every target browser now has. */
function newUuid(): string {
  return crypto.randomUUID();
}

export async function enqueue(input: EnqueueInput): Promise<string> {
  const database = offlineDb();
  const clientUuid = newUuid();

  await database.outbox.add({
    clientUuid,
    procedure: input.procedure,
    operation: input.operation,
    payload: input.payload,
    capturedAt: Date.now(),
    status: "queued",
    attempts: 0,
    lastError: null,
    rejectionReason: null,
    attachmentIds: input.attachmentIds ?? [],
    label: input.label,
  });

  return clientUuid;
}

export async function queueSummary() {
  if (!offlineSupported()) {
    return { queued: 0, failed: 0, rejected: 0, total: 0, oldestCapturedAt: null as number | null };
  }
  const database = offlineDb();
  const all = await database.outbox.toArray();
  const pending = all.filter((item) => item.status !== "rejected");

  return {
    queued: all.filter((item) => item.status === "queued" || item.status === "sending").length,
    failed: all.filter((item) => item.status === "failed").length,
    rejected: all.filter((item) => item.status === "rejected").length,
    total: all.length,
    // How long the oldest unsent thing has been waiting. A queue of two that is four hours old is a
    // worse sign than a queue of twenty from the last ten minutes, and the count alone hides that.
    oldestCapturedAt: pending.length
      ? pending.reduce((min, item) => Math.min(min, item.capturedAt), Infinity)
      : null,
  };
}

export async function listQueue(): Promise<OutboxItem[]> {
  if (!offlineSupported()) return [];
  return offlineDb().outbox.orderBy("capturedAt").toArray();
}

/**
 * How a caller sends one item. Injected rather than imported so this module stays testable without
 * a tRPC client, and so the transport can change without touching the queue's rules.
 *
 * Returning `rejected` means a business rule refused it — final. Throwing means it did not get
 * through — retry later.
 */
export type SendFn = (item: OutboxItem) => Promise<{ rejected?: boolean; reason?: string }>;

export interface DrainResult {
  sent: number;
  rejected: number;
  failed: number;
  /** True when the drain stopped early because the network went away again. */
  interrupted: boolean;
}

/**
 * Sends what is queued, oldest first, stopping at the first transport failure.
 *
 * Stopping matters. If the connection has dropped, the remaining items will fail identically, and
 * marching through fifty of them turns one outage into fifty incremented attempt counters and fifty
 * error strings that all say the same thing. A refusal, by contrast, is specific to its item, so the
 * drain continues past it.
 */
export async function drainOutbox(send: SendFn): Promise<DrainResult> {
  if (!offlineSupported()) return { sent: 0, rejected: 0, failed: 0, interrupted: false };

  const database = offlineDb();
  const result: DrainResult = { sent: 0, rejected: 0, failed: 0, interrupted: false };

  const items = await database.outbox
    .orderBy("capturedAt")
    .filter((item) => item.status === "queued" || item.status === "failed")
    .toArray();

  for (const item of items) {
    await database.outbox.update(item.clientUuid, { status: "sending" satisfies OutboxStatus });

    try {
      const outcome = await send(item);

      if (outcome.rejected) {
        // Kept, not deleted. The technician has to be told what happened to this work, and a row
        // that vanishes tells them nothing. Cleared only when they acknowledge it.
        await database.outbox.update(item.clientUuid, {
          status: "rejected" satisfies OutboxStatus,
          rejectionReason: outcome.reason ?? "Refused by a business rule.",
          lastError: null,
        });
        result.rejected += 1;
        continue;
      }

      await database.transaction("rw", database.outbox, database.attachments, async () => {
        await database.attachments.where("clientUuid").equals(item.clientUuid).delete();
        await database.outbox.delete(item.clientUuid);
      });
      result.sent += 1;
    } catch (error) {
      await database.outbox.update(item.clientUuid, {
        status: "failed" satisfies OutboxStatus,
        attempts: item.attempts + 1,
        lastError: error instanceof Error ? error.message : String(error),
      });
      result.failed += 1;
      result.interrupted = true;
      break;
    }
  }

  return result;
}

/**
 * Clears a refusal the technician has read.
 *
 * The only path by which an unsent item leaves this queue, and it requires a human to have seen it.
 * That is the entire point of the distinction between `rejected` and everything else.
 */
export async function discardRejected(clientUuid: string) {
  const database = offlineDb();
  const item = await database.outbox.get(clientUuid);
  if (!item || item.status !== "rejected") return false;

  await database.transaction("rw", database.outbox, database.attachments, async () => {
    await database.attachments.where("clientUuid").equals(clientUuid).delete();
    await database.outbox.delete(clientUuid);
  });
  return true;
}

/** Puts a failed item back in line — the manual "try again" next to an item that keeps failing. */
export async function requeue(clientUuid: string) {
  const database = offlineDb();
  const item = await database.outbox.get(clientUuid);
  if (!item || item.status === "rejected") return false;
  await database.outbox.update(clientUuid, {
    status: "queued" satisfies OutboxStatus,
    lastError: null,
  });
  return true;
}
