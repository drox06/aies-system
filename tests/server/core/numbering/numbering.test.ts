import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { allocateNumber, previewNumber } from "@/server/core/numbering/numbering";

const testDocumentTypes: string[] = [];

afterEach(async () => {
  if (testDocumentTypes.length > 0) {
    await db.documentSequence.deleteMany({ where: { documentType: { in: testDocumentTypes } } });
    await db.numberingFormat.deleteMany({ where: { documentType: { in: testDocumentTypes } } });
    testDocumentTypes.length = 0;
  }
});

async function seedTestFormat(format: string): Promise<string> {
  const documentType = `test_${randomUUID().replace(/-/g, "")}`;
  await db.numberingFormat.create({ data: { documentType, format, label: "Test" } });
  testDocumentTypes.push(documentType);
  return documentType;
}

describe("allocateNumber", () => {
  it("allocates sequential numbers within the same scope", async () => {
    const documentType = await seedTestFormat("TST-{YY}-{###}");
    const now = new Date("2026-08-15");

    const first = await allocateNumber(documentType, { now });
    const second = await allocateNumber(documentType, { now });
    const third = await allocateNumber(documentType, { now });

    expect([first, second, third]).toEqual(["TST-26-001", "TST-26-002", "TST-26-003"]);
  }, 30_000);

  it("starts a fresh counter in a different scope (e.g. a new month)", async () => {
    const documentType = await seedTestFormat("TST-{YY}{MM}-{###}");

    const august = await allocateNumber(documentType, { now: new Date("2026-08-31") });
    const september = await allocateNumber(documentType, { now: new Date("2026-09-01") });

    expect(august).toBe("TST-2608-001");
    expect(september).toBe("TST-2609-001");
  }, 30_000);

  it("throws for an unconfigured document type", async () => {
    await expect(allocateNumber("no_such_type_xyz")).rejects.toThrow(/No numbering format/);
  }, 30_000);

  it("50 concurrent allocations produce 50 unique, sequential numbers (specs/00-foundation.md §11)", async () => {
    const documentType = await seedTestFormat("TST-{YY}-{#####}");
    const now = new Date("2026-08-15");

    const results = await Promise.all(
      Array.from({ length: 50 }, () => allocateNumber(documentType, { now })),
    );

    expect(new Set(results).size).toBe(50); // all unique

    const counters = results.map((n) => Number(n.split("-")[2])).sort((a, b) => a - b);
    expect(counters).toEqual(Array.from({ length: 50 }, (_, i) => i + 1)); // 1..50, no gaps or reorders
  }, 30_000);
});

describe("previewNumber", () => {
  it("shows the next number without consuming it", async () => {
    const documentType = await seedTestFormat("TST-{YY}-{###}");
    const now = new Date("2026-08-15");

    const preview1 = await previewNumber(documentType, { now });
    const preview2 = await previewNumber(documentType, { now });
    expect(preview1).toBe("TST-26-001");
    expect(preview2).toBe("TST-26-001"); // unchanged — nothing was consumed

    const allocated = await allocateNumber(documentType, { now });
    expect(allocated).toBe("TST-26-001"); // matches what was previewed

    const preview3 = await previewNumber(documentType, { now });
    expect(preview3).toBe("TST-26-002");
  }, 30_000);
});
