import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { indexEntity } from "@/server/core/search/index-service";
import { search } from "@/server/core/search/query";

const entityType = `test_search_${randomUUID().replace(/-/g, "")}`;

afterEach(async () => {
  await db.searchIndex.deleteMany({ where: { entityType } });
});

describe("search", () => {
  it("finds an indexed entity by full-text match", async () => {
    await indexEntity({
      entityType,
      entityId: "e1",
      title: "Rosemount Pressure Transmitter",
      body: "3051S series, water treatment plant",
      href: "/x/e1",
    });

    const results = await search("pressure transmitter");
    expect(results.some((r) => r.entityId === "e1")).toBe(true);
  }, 30_000);

  it("falls back to pg_trgm fuzzy matching when full-text finds nothing (typo tolerance)", async () => {
    await indexEntity({
      entityType,
      entityId: "e2",
      title: "Endress+Hauser Promag Flowmeter",
      href: "/x/e2",
    });

    // "Promag" misspelled as "Promg" — full-text plainto_tsquery won't match this at all, so it
    // must be the fuzzy fallback that finds it.
    const results = await search("Promg flowmeter");
    expect(results.some((r) => r.entityId === "e2")).toBe(true);
  }, 30_000);

  it("returns nothing for an empty query without touching the database", async () => {
    expect(await search("")).toEqual([]);
    expect(await search("   ")).toEqual([]);
  });

  it("merges results from registered SearchProviders and deduplicates by entityType+entityId", async () => {
    await indexEntity({
      entityType,
      entityId: "shared1",
      title: "Duplicate Widget",
      href: "/x/shared1",
    });

    const providerSearch = vi.fn().mockResolvedValue([
      {
        entityType,
        entityId: "shared1",
        title: "Duplicate Widget (from provider)",
        href: "/x/shared1",
      },
      {
        entityType,
        entityId: "provider-only",
        title: "Provider Only Result",
        href: "/x/provider-only",
      },
    ]);

    const results = await search("widget", 20, {
      searchProviders: [{ entityType, label: "Test", search: providerSearch }],
    });

    const ids = results.map((r) => r.entityId);
    expect(ids).toContain("provider-only");
    expect(ids.filter((id) => id === "shared1")).toHaveLength(1); // deduplicated, not doubled
  }, 30_000);
});
