import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { allocateNumber } from "@/server/core/numbering/numbering";
import {
  parseQuotationNumber,
  quotationDisplayNumber,
  quoteTypeFromNumber,
  QUOTE_NUMBER_DOCUMENT_TYPES,
  QUOTE_NUMBER_FORMATS,
} from "@/server/core/quotation/quotation-number";

/**
 * The company's own quotation numbering, which replaces Spec.md §5's `QTN-{YY}{MM}-{####}`:
 *
 *   local           AIESLQ260001
 *   indent          AIESIQ260001
 *   after revising  AIESLQ260001REV01
 *
 * The two series are independent and each restarts in January. Those are the properties worth
 * pinning, because both are emergent — they come from the format's `{YY}` scoping the counter, not
 * from code anybody wrote.
 */

const scopeKeys: string[] = [];

afterAll(async () => {
  // Only the sequences these tests advanced; the seeded formats stay.
  await db.documentSequence.deleteMany({ where: { documentType: { in: TEST_TYPES } } });
  await db.numberingFormat.deleteMany({ where: { documentType: { in: TEST_TYPES } } });
  void scopeKeys;
});

const suffix = randomUUID().slice(0, 6);
const TEST_TYPES = [`t_local_${suffix}`, `t_indent_${suffix}`];

describe("quotationDisplayNumber", () => {
  it("leaves the first issue alone", () => {
    // Printing REV00 would invite the question "where is revision zero?".
    expect(quotationDisplayNumber("AIESLQ260001", 0)).toBe("AIESLQ260001");
  });

  it("appends a zero-padded REV from the first revision", () => {
    expect(quotationDisplayNumber("AIESLQ260001", 1)).toBe("AIESLQ260001REV01");
    expect(quotationDisplayNumber("AIESLQ260001", 2)).toBe("AIESLQ260001REV02");
    expect(quotationDisplayNumber("AIESIQ260042", 9)).toBe("AIESIQ260042REV09");
  });

  it("grows rather than truncating past 99 revisions", () => {
    // A negotiation that reaches REV100 has gone badly wrong, but the number must still be honest.
    expect(quotationDisplayNumber("AIESLQ260001", 100)).toBe("AIESLQ260001REV100");
  });

  it("refuses a nonsense revision instead of printing one", () => {
    expect(() => quotationDisplayNumber("AIESLQ260001", -1)).toThrow(/non-negative/);
    expect(() => quotationDisplayNumber("AIESLQ260001", 1.5)).toThrow(/non-negative/);
  });
});

describe("parseQuotationNumber", () => {
  it("round-trips every display form", () => {
    // People search for and quote these at each other on the phone; pasting a revised number must
    // find the quotation rather than nothing.
    for (const [base, revision] of [
      ["AIESLQ260001", 0],
      ["AIESLQ260001", 1],
      ["AIESIQ260123", 12],
    ] as const) {
      const display = quotationDisplayNumber(base, revision);
      expect(parseQuotationNumber(display)).toEqual({ baseNumber: base, revision });
    }
  });

  it("treats an unsuffixed number as revision zero", () => {
    expect(parseQuotationNumber("AIESLQ260001")).toEqual({
      baseNumber: "AIESLQ260001",
      revision: 0,
    });
  });
});

describe("quoteTypeFromNumber", () => {
  it("reads the series off the prefix", () => {
    expect(quoteTypeFromNumber("AIESLQ260001")).toBe("local");
    expect(quoteTypeFromNumber("AIESIQ260001")).toBe("indent");
    expect(quoteTypeFromNumber("QTN-2608-0042")).toBeNull();
  });
});

describe("the seeded formats, against the real numbering service", () => {
  it("produces the company's format exactly", async () => {
    await db.numberingFormat.create({
      data: {
        documentType: TEST_TYPES[0]!,
        format: QUOTE_NUMBER_FORMATS.local,
        label: "test local",
      },
    });

    const first = await allocateNumber(TEST_TYPES[0]!, { now: new Date("2026-03-14T00:00:00Z") });
    // AIESLQ + 26 + 0001 — the company's worked example.
    expect(first).toBe("AIESLQ260001");

    const second = await allocateNumber(TEST_TYPES[0]!, { now: new Date("2026-11-30T00:00:00Z") });
    expect(second).toBe("AIESLQ260002");
  });

  it("restarts the series in January without anybody resetting it", async () => {
    // Emergent from {YY} being part of the counter's scope key, so it is worth proving rather than
    // assuming — a series that silently continued across years would be found in 2027.
    const next = await allocateNumber(TEST_TYPES[0]!, { now: new Date("2027-01-02T00:00:00Z") });
    expect(next).toBe("AIESLQ270001");
  });

  it("keeps the local and indent series completely independent", async () => {
    await db.numberingFormat.create({
      data: {
        documentType: TEST_TYPES[1]!,
        format: QUOTE_NUMBER_FORMATS.indent,
        label: "test indent",
      },
    });

    // Local is already at 0002 for 2026; indent must still start at 0001.
    const indent = await allocateNumber(TEST_TYPES[1]!, { now: new Date("2026-03-14T00:00:00Z") });
    expect(indent).toBe("AIESIQ260001");
  });

  it("maps each quote type to its own document type", () => {
    // One shared document type would interleave the two series, which is the bug this prevents.
    expect(QUOTE_NUMBER_DOCUMENT_TYPES.local).not.toBe(QUOTE_NUMBER_DOCUMENT_TYPES.indent);
  });
});

describe("the seed matches what the code expects", () => {
  it("has both series configured with the company's formats", async () => {
    const rows = await db.numberingFormat.findMany({
      where: { documentType: { in: Object.values(QUOTE_NUMBER_DOCUMENT_TYPES) } },
    });
    const byType = new Map(rows.map((r) => [r.documentType, r.format]));

    expect(byType.get(QUOTE_NUMBER_DOCUMENT_TYPES.local)).toBe(QUOTE_NUMBER_FORMATS.local);
    expect(byType.get(QUOTE_NUMBER_DOCUMENT_TYPES.indent)).toBe(QUOTE_NUMBER_FORMATS.indent);
  });

  it("no longer configures the spec's placeholder format", async () => {
    // Left in place it would be the obvious name to reach for, and would allocate QTN-2608-0001
    // onto a document the company would not recognise.
    const stale = await db.numberingFormat.findUnique({ where: { documentType: "quotation" } });
    expect(stale).toBeNull();
  });
});
