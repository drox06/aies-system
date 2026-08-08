import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { emit, isValidEventName } from "@/server/core/events/emit";

describe("isValidEventName", () => {
  it("accepts entity.verb_past_tense snake_case names", () => {
    expect(isValidEventName("sales_order.created")).toBe(true);
    expect(isValidEventName("quotation.approved")).toBe(true);
    expect(isValidEventName("user.role_assigned")).toBe(true);
  });

  it("rejects camelCase, missing dot, or uppercase", () => {
    expect(isValidEventName("salesOrder.created")).toBe(false);
    expect(isValidEventName("sales_order_created")).toBe(false);
    expect(isValidEventName("SalesOrder.Created")).toBe(false);
    expect(isValidEventName("")).toBe(false);
  });
});

describe("emit", () => {
  it("writes an EventOutbox row inside the given transaction", async () => {
    const requestId = `test-${randomUUID()}`;

    await db.$transaction(async (tx) => {
      await emit(tx, "user.created", { userId: "u1" }, { actorId: "actor1", requestId });
    });

    const rows = await db.eventOutbox.findMany({ where: { requestId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toBe("user.created");
    expect(rows[0]?.payload).toEqual({ userId: "u1" });
    expect(rows[0]?.relayedAt).toBeNull();

    await db.eventOutbox.deleteMany({ where: { requestId } });
  }, 30_000);

  it("rejects an invalid event name before writing anything", async () => {
    const requestId = `test-${randomUUID()}`;

    await expect(
      db.$transaction(async (tx) => {
        await emit(tx, "NotAValidName", {}, { requestId });
      }),
    ).rejects.toThrow(/snake_case/);

    const rows = await db.eventOutbox.findMany({ where: { requestId } });
    expect(rows).toHaveLength(0);
  }, 30_000);

  it("rolls back alongside the business change it accompanies on later failure", async () => {
    const requestId = `test-${randomUUID()}`;

    await expect(
      db.$transaction(async (tx) => {
        await emit(tx, "user.created", { userId: "u2" }, { requestId });
        throw new Error("simulated failure after emit");
      }),
    ).rejects.toThrow("simulated failure after emit");

    const rows = await db.eventOutbox.findMany({ where: { requestId } });
    expect(rows).toHaveLength(0);
  }, 30_000);
});
