import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  acknowledgeSyncOutcomesService,
  hashPayload,
  pendingSyncOutcomesService,
  runFieldWrite,
} from "@/server/core/operations/field-sync";

/**
 * specs/04-operations-projects.md §14's outbox, against the real database.
 *
 * §20's offline case ends "**replaying the same outbox twice creates no duplicates**", and that is
 * the assertion this file exists for. Everything else in §14 — the Dexie store, the sync indicator,
 * the photo compression — is recoverable if it goes wrong. This is not: a duplicate delivery attempt
 * or a lost afternoon of a technician's work is wrong in the record, permanently, and §14 says so in
 * the strongest language in the spec pack.
 */

const USER = `field-${randomUUID().slice(0, 8)}`;
const uuids: string[] = [];

const uuid = () => {
  const value = randomUUID();
  uuids.push(value);
  return value;
};

afterAll(async () => {
  await db.fieldSubmission.deleteMany({ where: { clientUuid: { in: uuids } } });
});

describe("running a field write once", () => {
  it("does the work the first time", async () => {
    const run = vi.fn().mockResolvedValue({ result: { id: "rec-1" }, entityId: "rec-1" });

    const outcome = await runFieldWrite({
      clientUuid: uuid(),
      userId: USER,
      operation: "test.write",
      payload: { note: "first" },
      run,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(outcome.applied).toBe(true);
    expect(outcome.result).toEqual({ id: "rec-1" });
  });

  /** The sentence §20 names. The whole table exists for this one assertion. */
  it("does not do the work again when the same submission is replayed", async () => {
    const id = uuid();
    const run = vi.fn().mockResolvedValue({ result: { id: "rec-2" }, entityId: "rec-2" });
    const payload = { note: "same" };

    const first = await runFieldWrite({
      clientUuid: id,
      userId: USER,
      operation: "test.write",
      payload,
      run,
    });
    const second = await runFieldWrite({
      clientUuid: id,
      userId: USER,
      operation: "test.write",
      payload,
      run,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    // The replay has to be *usable*, not merely harmless: the client marks its queue item done from
    // this, so answering with nothing would leave the item queued forever.
    expect(second.result).toEqual(first.result);
  });

  it("keeps one row per submission, however many times it is replayed", async () => {
    const id = uuid();
    const run = vi.fn().mockResolvedValue({ result: { ok: true } });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await runFieldWrite({
        clientUuid: id,
        userId: USER,
        operation: "test.write",
        payload: { n: 1 },
        run,
      });
    }

    const rows = await db.fieldSubmission.count({ where: { clientUuid: id } });
    expect(rows).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  /**
   * Key order is not payload identity. A client that rebuilds a queued payload after a reload can
   * easily emit the same data with its keys rearranged, and reporting that as a mismatch would train
   * whoever reads the logs to ignore the one signal that means a real client bug.
   */
  it("treats the same content with reordered keys as the same submission", async () => {
    const id = uuid();
    const run = vi.fn().mockResolvedValue({ result: { ok: true } });

    await runFieldWrite({
      clientUuid: id,
      userId: USER,
      operation: "test.write",
      payload: { a: 1, b: { x: 1, y: 2 } },
      run,
    });
    const replay = await runFieldWrite({
      clientUuid: id,
      userId: USER,
      operation: "test.write",
      payload: { b: { y: 2, x: 1 }, a: 1 },
      run,
    });

    expect(replay.applied).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(hashPayload({ a: 1, b: { x: 1, y: 2 } })).toBe(hashPayload({ b: { y: 2, x: 1 }, a: 1 }));
  });

  /** A reused id carrying different content is a client defect, and answering it from the record would hide it. */
  it("refuses an id reused for different content, and writes nothing", async () => {
    const id = uuid();
    const run = vi.fn().mockResolvedValue({ result: { ok: true } });

    await runFieldWrite({
      clientUuid: id,
      userId: USER,
      operation: "test.write",
      payload: { note: "one" },
      run,
    });

    await expect(
      runFieldWrite({
        clientUuid: id,
        userId: USER,
        operation: "test.write",
        payload: { note: "something else entirely" },
        run,
      }),
    ).rejects.toThrow(/reuses an id/);

    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("§14's conflict policy: never silently discard", () => {
  /**
   * The requirement §14 states in the strongest terms in the spec pack: "losing a technician's
   * afternoon destroys trust in the system permanently. Treat this as a correctness requirement."
   *
   * A `TRPCError` alone does not satisfy it. It lives in a response body, and if the tab closed or
   * the connection dropped while it was in flight, both the refusal *and the fact that the work was
   * ever attempted* are gone.
   */
  it("records a business-rule refusal instead of losing it with the response", async () => {
    const id = uuid();
    const run = vi
      .fn()
      .mockRejectedValue(
        new TRPCError({ code: "BAD_REQUEST", message: "Say why the delivery failed." }),
      );

    await expect(
      runFieldWrite({
        clientUuid: id,
        userId: USER,
        operation: "delivery.attempt",
        payload: { itemDelivered: false },
        run,
      }),
    ).rejects.toThrow(/Say why the delivery failed/);

    const row = await db.fieldSubmission.findUniqueOrThrow({ where: { clientUuid: id } });
    expect(row.status).toBe("rejected");
    expect(row.rejectionReason).toMatch(/Say why the delivery failed/);
  });

  it("replays the refusal rather than re-running work that was already refused", async () => {
    const id = uuid();
    const run = vi
      .fn()
      .mockRejectedValue(new TRPCError({ code: "BAD_REQUEST", message: "No receipt to sign." }));

    await expect(
      runFieldWrite({
        clientUuid: id,
        userId: USER,
        operation: "delivery.complete",
        payload: { x: 1 },
        run,
      }),
    ).rejects.toThrow();

    const replay = await runFieldWrite({
      clientUuid: id,
      userId: USER,
      operation: "delivery.complete",
      payload: { x: 1 },
      run,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(replay.rejected).toBe(true);
    expect(replay.rejectionReason).toMatch(/No receipt to sign/);
  });

  /**
   * A crash is not a decision. Recording it as a rejection would tell the technician their work was
   * refused when the truth is that nobody knows whether it landed — and would stop the retry that is
   * the correct response.
   */
  it("does not record a crash as a rejection", async () => {
    const id = uuid();
    const run = vi.fn().mockRejectedValue(new Error("connection reset"));

    await expect(
      runFieldWrite({
        clientUuid: id,
        userId: USER,
        operation: "test.write",
        payload: { x: 1 },
        run,
      }),
    ).rejects.toThrow(/connection reset/);

    const row = await db.fieldSubmission.findUnique({ where: { clientUuid: id } });
    expect(row).toBeNull();

    // And so the retry runs, which is the whole point of not recording it.
    run.mockResolvedValueOnce({ result: { ok: true } });
    const retry = await runFieldWrite({
      clientUuid: id,
      userId: USER,
      operation: "test.write",
      payload: { x: 1 },
      run,
    });
    expect(retry.applied).toBe(true);
  });
});

describe("telling the technician what happened to their queue", () => {
  it("surfaces unacknowledged refusals, and stops once they are acknowledged", async () => {
    const owner = `field-${randomUUID().slice(0, 8)}`;
    const id = uuid();

    await expect(
      runFieldWrite({
        clientUuid: id,
        userId: owner,
        operation: "progress.log",
        payload: { hours: 8 },
        run: vi
          .fn()
          .mockRejectedValue(new TRPCError({ code: "BAD_REQUEST", message: "Ticket is closed." })),
      }),
    ).rejects.toThrow();

    const before = await pendingSyncOutcomesService(owner);
    expect(before.rejected).toHaveLength(1);
    expect(before.rejected[0]!.rejectionReason).toMatch(/Ticket is closed/);

    await acknowledgeSyncOutcomesService(owner, [before.rejected[0]!.id]);

    const after = await pendingSyncOutcomesService(owner);
    expect(after.rejected).toHaveLength(0);
  });

  /** Acknowledging is "I showed this to somebody", which only the device holding that session can say. */
  it("will not let one user acknowledge another's outcomes", async () => {
    const owner = `field-${randomUUID().slice(0, 8)}`;
    const stranger = `field-${randomUUID().slice(0, 8)}`;
    const id = uuid();

    await runFieldWrite({
      clientUuid: id,
      userId: owner,
      operation: "test.write",
      payload: { x: 1 },
      run: vi.fn().mockResolvedValue({ result: { ok: true } }),
    });

    const result = await acknowledgeSyncOutcomesService(stranger, [
      (await db.fieldSubmission.findUniqueOrThrow({ where: { clientUuid: id } })).id,
    ]);

    expect(result.acknowledged).toBe(0);
    expect((await pendingSyncOutcomesService(owner)).applied).toHaveLength(1);
  });
});
