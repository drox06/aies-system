import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { indexEntity, removeFromIndex } from "@/server/core/search/index-service";

const entityType = `test_indexed_${randomUUID().replace(/-/g, "")}`;

afterEach(async () => {
  await db.searchIndex.deleteMany({ where: { entityType } });
});

describe("indexEntity", () => {
  it("creates a row, then updates it in place on a second call", async () => {
    await indexEntity({ entityType, entityId: "e1", title: "Flow Meter FM-100", href: "/x/e1" });
    const first = await db.searchIndex.findUniqueOrThrow({
      where: { entityType_entityId: { entityType, entityId: "e1" } },
    });
    expect(first.title).toBe("Flow Meter FM-100");

    await indexEntity({
      entityType,
      entityId: "e1",
      title: "Flow Meter FM-100 (updated)",
      href: "/x/e1",
    });
    const rows = await db.searchIndex.findMany({ where: { entityType, entityId: "e1" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Flow Meter FM-100 (updated)");
  }, 30_000);
});

describe("removeFromIndex", () => {
  it("removes the row", async () => {
    await indexEntity({ entityType, entityId: "e2", title: "Temp", href: "/x/e2" });
    await removeFromIndex(entityType, "e2");

    const rows = await db.searchIndex.findMany({ where: { entityType, entityId: "e2" } });
    expect(rows).toHaveLength(0);
  }, 30_000);
});
