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

/**
 * The format guard (docs/DECISIONS.md #48).
 *
 * A counter's identity is `(documentType, scopeKey)` and the scope key is *derived from the format*
 * — so changing a format's shape mints a fresh counter at zero rather than moving the existing one.
 * That is what nearly issued a duplicate `AIESINQ-260001` during the 2026-08-16 rename.
 *
 * The hard part is that it must refuse a *shape change* while still allowing a **new year**, and
 * from the allocator's side those look identical: in both cases the scope key is one it has never
 * seen. These tests pin both halves, because a guard that also blocked January would be worse than
 * no guard — somebody would delete it on 2 January with a customer waiting.
 */
describe("the format guard", () => {
  it("still starts a fresh counter in a new year, which is not a format change", async () => {
    const documentType = await seedTestFormat("AIESTST-{YY}{####}");

    expect(await allocateNumber(documentType, { now: new Date("2026-12-31") })).toBe(
      "AIESTST-260001",
    );
    // A scope the allocator has never seen, under an unchanged format. This must simply work.
    expect(await allocateNumber(documentType, { now: new Date("2027-01-02") })).toBe(
      "AIESTST-270001",
    );
  }, 30_000);

  it("refuses to issue when the format's shape changed under a live counter", async () => {
    const documentType = await seedTestFormat("TST-{YY}{MM}-{####}");
    const issued = await allocateNumber(documentType, { now: new Date("2026-08-15") });
    expect(issued).toBe("TST-2608-0001");

    // Exactly what the rename did to `inquiry`: the month leaves, so the scope key goes from
    // "26:08" to "26" and the new scope has no row.
    await db.numberingFormat.update({
      where: { documentType },
      data: { format: "AIESTST-{YY}{####}" },
    });

    await expect(allocateNumber(documentType, { now: new Date("2026-08-15") })).rejects.toThrow(
      /counter\(s\) are still on/,
    );
    // And it refused *before* consuming anything, so nothing was silently burned.
    const rows = await db.documentSequence.findMany({ where: { documentType } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.counter).toBe(1);
  }, 30_000);

  it("refuses a shape change even when the rendered prefix is identical", async () => {
    // The nastiest version: the number *looks* the same, so nothing on screen suggests a problem —
    // only the scope key moved, from "26" to "26:08".
    const documentType = await seedTestFormat("AIESTST-{YY}{####}");
    await allocateNumber(documentType, { now: new Date("2026-08-15") });

    await db.numberingFormat.update({
      where: { documentType },
      data: { format: "AIESTST-{YY}{MM}{####}" },
    });

    await expect(allocateNumber(documentType, { now: new Date("2026-08-15") })).rejects.toThrow(
      /has changed/,
    );
  }, 30_000);

  it("names the fix in the message, because whoever hits this is mid-task", async () => {
    const documentType = await seedTestFormat("TST-{YY}-{####}");
    await allocateNumber(documentType, { now: new Date("2026-08-15") });
    await db.numberingFormat.update({
      where: { documentType },
      data: { format: "AIESTST-{YY}{####}" },
    });

    await expect(allocateNumber(documentType, { now: new Date("2026-08-15") })).rejects.toThrow(
      /reset-numbering-counters/,
    );
  }, 30_000);

  it("clears once the counters are stamped with the new format", async () => {
    const documentType = await seedTestFormat("TST-{YY}-{####}");
    await allocateNumber(documentType, { now: new Date("2026-08-15") });
    await db.numberingFormat.update({
      where: { documentType },
      data: { format: "AIESTST-{YY}{####}" },
    });

    // What the reconciliation script does: hold the counter at what is in use, and stamp the format.
    await db.documentSequence.updateMany({
      where: { documentType },
      data: { format: "AIESTST-{YY}{####}" },
    });

    expect(await allocateNumber(documentType, { now: new Date("2026-08-15") })).toBe(
      "AIESTST-260002",
    );
  }, 30_000);
});
