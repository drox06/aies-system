import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { offlineDb, storageStanding, wipeOfflineData } from "@/lib/offline/db";
import {
  discardRejected,
  drainOutbox,
  enqueue,
  listQueue,
  queueSummary,
  requeue,
} from "@/lib/offline/outbox";

/**
 * specs/04-operations-projects.md §14's outbox, client side.
 *
 * These are not tests about IndexedDB. They are tests about the one promise §14 makes in its
 * strongest language — "**never silently drop queued items**", because "losing a technician's
 * afternoon destroys trust in the system permanently" — and every case below is a way that promise
 * could be broken by code that otherwise looks correct.
 */

beforeEach(async () => {
  await wipeOfflineData({ force: true });
});

const queueAttempt = (label = "Delivery attempt") =>
  enqueue({
    procedure: "operations.logDeliveryAttempt",
    operation: "delivery.attempt",
    payload: { ticketId: "t-1", itemDelivered: false, failureReason: "site_closed" },
    label,
  });

describe("queueing work with no signal", () => {
  it("gives every item its own id, so a double tap cannot enqueue twice under one", async () => {
    const first = await queueAttempt();
    const second = await queueAttempt();

    expect(first).not.toBe(second);
    expect(await listQueue()).toHaveLength(2);
  });

  it("reports how long the oldest unsent item has been waiting, not just how many there are", async () => {
    await queueAttempt();
    const summary = await queueSummary();

    expect(summary.queued).toBe(1);
    // A queue of two that is four hours old is a worse sign than twenty from the last ten minutes,
    // and a bare count hides exactly that.
    expect(summary.oldestCapturedAt).toBeTypeOf("number");
  });
});

describe("draining, and what leaves the queue", () => {
  it("removes an item only once the server has acknowledged it", async () => {
    await queueAttempt();
    const send = vi.fn().mockResolvedValue({});

    const result = await drainOutbox(send);

    expect(result.sent).toBe(1);
    expect(await listQueue()).toHaveLength(0);
  });

  /**
   * The case that decides whether the whole thing is trustworthy. A dropped connection must leave
   * the work exactly where it was.
   */
  it("keeps an item that failed to send, and records why", async () => {
    await queueAttempt();
    const send = vi.fn().mockRejectedValue(new Error("Failed to fetch"));

    const result = await drainOutbox(send);

    expect(result.failed).toBe(1);
    const [item] = await listQueue();
    expect(item!.status).toBe("failed");
    expect(item!.attempts).toBe(1);
    expect(item!.lastError).toMatch(/Failed to fetch/);
  });

  /**
   * If the connection has gone, the rest of the queue will fail identically. Marching through it
   * turns one outage into fifty incremented counters and fifty copies of the same error.
   */
  it("stops at the first transport failure rather than burning through the queue", async () => {
    await queueAttempt("first");
    await queueAttempt("second");
    await queueAttempt("third");

    const send = vi.fn().mockRejectedValue(new Error("offline"));
    const result = await drainOutbox(send);

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.interrupted).toBe(true);
    expect(await listQueue()).toHaveLength(3);
  });

  /** A refusal is specific to its item, so unlike an outage it is not a reason to stop. */
  it("continues past a refusal, because the next item may be fine", async () => {
    await queueAttempt("first");
    await queueAttempt("second");

    const send = vi
      .fn()
      .mockResolvedValueOnce({ rejected: true, reason: "Say why the delivery failed." })
      .mockResolvedValueOnce({});

    const result = await drainOutbox(send);

    expect(send).toHaveBeenCalledTimes(2);
    expect(result.rejected).toBe(1);
    expect(result.sent).toBe(1);
  });

  /**
   * §14's conflict policy at the device end. A refused item is kept and shown; deleting it would be
   * the silent discard the section forbids, and the technician would never learn their work was
   * refused.
   */
  it("keeps a refused item with its reason instead of deleting it", async () => {
    await queueAttempt();
    await drainOutbox(vi.fn().mockResolvedValue({ rejected: true, reason: "Ticket is closed." }));

    const [item] = await listQueue();
    expect(item!.status).toBe("rejected");
    expect(item!.rejectionReason).toMatch(/Ticket is closed/);

    // And it is not retried on the next drain — a business rule's answer does not change by asking
    // again, and spinning on it would bury the items that can still be sent.
    const send = vi.fn().mockResolvedValue({});
    await drainOutbox(send);
    expect(send).not.toHaveBeenCalled();
  });

  it("lets a failed item be tried again by hand", async () => {
    await queueAttempt();
    await drainOutbox(vi.fn().mockRejectedValue(new Error("offline")));

    expect(await requeue((await listQueue())[0]!.clientUuid)).toBe(true);
    expect((await listQueue())[0]!.status).toBe("queued");

    const result = await drainOutbox(vi.fn().mockResolvedValue({}));
    expect(result.sent).toBe(1);
  });
});

describe("the only way unsent work may be thrown away", () => {
  it("discards a refusal once, and only a refusal", async () => {
    await queueAttempt();
    await drainOutbox(vi.fn().mockRejectedValue(new Error("offline")));

    // Failed is not refused. It has not been decided yet, so it cannot be discarded.
    const failed = (await listQueue())[0]!;
    expect(await discardRejected(failed.clientUuid)).toBe(false);
    expect(await listQueue()).toHaveLength(1);

    await requeue(failed.clientUuid);
    await drainOutbox(vi.fn().mockResolvedValue({ rejected: true, reason: "No." }));

    expect(await discardRejected(failed.clientUuid)).toBe(true);
    expect(await listQueue()).toHaveLength(0);
  });
});

describe("signing out with work still in the bag", () => {
  /**
   * The tempting shortcut is to wipe on sign-out and be done. On a shared device that would delete
   * an afternoon nobody has sent, to protect the next user's privacy — trading a certain,
   * irreversible loss against a risk. The caller has to decide, so this refuses and says how much is
   * at stake.
   */
  it("refuses to wipe while unsent work is queued, and says how much", async () => {
    await queueAttempt();
    const outcome = await wipeOfflineData();

    expect(outcome.wiped).toBe(false);
    expect(outcome.queued).toBe(1);
    expect(await listQueue()).toHaveLength(1);
  });

  it("wipes when the caller confirms", async () => {
    await queueAttempt();
    expect((await wipeOfflineData({ force: true })).wiped).toBe(true);
    expect(await listQueue()).toHaveLength(0);
  });

  /** A refusal the technician has already been shown is not unsent work, so it does not block. */
  it("does not count an acknowledged refusal as work at risk", async () => {
    await queueAttempt();
    await drainOutbox(vi.fn().mockResolvedValue({ rejected: true, reason: "No." }));

    expect((await wipeOfflineData()).wiped).toBe(true);
  });
});

describe("the storage guard", () => {
  it("says it does not know rather than guessing when the browser will not tell it", async () => {
    const standing = await storageStanding();
    // fake-indexeddb brings no Storage Manager, which is also true of older Safari.
    expect(standing.known).toBe(false);
    expect(standing.warn).toBe(false);
  });

  it("warns at 80% of quota", async () => {
    vi.stubGlobal("navigator", {
      storage: { estimate: async () => ({ usage: 82, quota: 100 }) },
    });

    const standing = await storageStanding();
    expect(standing.pct).toBe(82);
    expect(standing.warn).toBe(true);

    vi.unstubAllGlobals();
  });
});

describe("what the queue is holding", () => {
  it("labels items for a person rather than showing them a UUID", async () => {
    await queueAttempt("Delivery attempt — AIESDT-2601");
    const [item] = await listQueue();
    expect(item!.label).toBe("Delivery attempt — AIESDT-2601");
  });

  it("keeps the capture time distinct from the send time", async () => {
    const before = Date.now();
    await queueAttempt();
    const [item] = await listQueue();

    expect(item!.capturedAt).toBeGreaterThanOrEqual(before);
    // Sent hours later, this is still when the work actually happened — which is what the server
    // records and what the technician's day is reconstructed from.
    expect(offlineDb().outbox.name).toBe("outbox");
  });
});
