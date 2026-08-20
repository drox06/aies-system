import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { previewExportService } from "@/server/core/finance/export-service";
import {
  EXPORT_DATASETS,
  EXPORT_PRESETS,
  PRESET_COLUMNS,
  buildCsv,
  checkRepeat,
  contentHash,
  csvField,
} from "@/server/core/finance/export-rules";

/**
 * §8's accounting export.
 *
 * The clause carrying the weight is *"so the same period is not exported twice unnoticed"*.
 * Double-posting a month is not caught by the accounting package — it balances perfectly and simply
 * says the company earned twice what it did.
 */
describe("the CSV itself", () => {
  it("escapes a value that would otherwise shift every column after it", () => {
    /*
      "Santos, Reyes & Co." is not an edge case in the Philippines. An unescaped comma moves every
      subsequent column one to the left, and the receiving package imports that without complaint —
      the amount lands in the tax field and the totals still add up.
    */
    expect(csvField("Santos, Reyes & Co.")).toBe('"Santos, Reyes & Co."');
    expect(csvField('He said "fine"')).toBe('"He said ""fine"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
  });

  it("writes an empty cell for absent values rather than the word undefined", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("writes dates as plain days, which every package accepts", () => {
    expect(csvField(new Date("2026-08-20T09:30:00Z"))).toBe("2026-08-20");
  });

  it("builds a header row and one line per record, in the preset's order", () => {
    const csv = buildCsv("generic", "expenses", [
      { number: "AIESEXP-260001", vendorName: "Acme Rentals", amount: 12000 },
    ]);
    const [header, first] = csv.trim().split("\n");
    expect(header?.startsWith("expense_number,")).toBe(true);
    expect(first?.startsWith("AIESEXP-260001,")).toBe(true);
  });

  it("ends with a newline, because some importers drop the last row without one", () => {
    expect(buildCsv("generic", "payments", [{ reference: "x" }]).endsWith("\n")).toBe(true);
  });

  it("has a column set for every preset and dataset", () => {
    // A missing combination would throw at export time, on a screen somebody reaches once a month.
    for (const preset of EXPORT_PRESETS) {
      for (const dataset of EXPORT_DATASETS) {
        expect(PRESET_COLUMNS[preset][dataset].length, `${preset}/${dataset}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("exporting the same period twice", () => {
  const hash = contentHash("some,rows\n1,2\n");

  it("says so when nothing has been exported yet", () => {
    expect(checkRepeat([], hash).seenBefore).toBe(false);
  });

  /**
   * The dangerous repeat: same period, same figures, posted again.
   *
   * Warned rather than refused. A second export is often legitimate — the accountant lost the file —
   * and a flat refusal is worked around by exporting under a different name, which loses the record
   * entirely.
   */
  it("warns that an unchanged period would double the month", () => {
    const check = checkRepeat([{ contentHash: hash, exportedAt: "2026-08-01" }], hash);
    expect(check.seenBefore).toBe(true);
    expect(check.identical).toBe(true);
    expect(check.message).toMatch(/double the month/);
  });

  /**
   * The other repeat, which needs different advice.
   *
   * A month re-exported after a late invoice was added is a genuine change, and the answer is to post
   * the difference or reverse the earlier entry — not to add the whole month again.
   */
  it("distinguishes a period whose figures have since changed", () => {
    const check = checkRepeat(
      [{ contentHash: contentHash("older,rows\n"), exportedAt: "2026-08-01" }],
      hash,
    );
    expect(check.seenBefore).toBe(true);
    expect(check.identical).toBe(false);
    expect(check.message).toMatch(/changed since/);
  });

  it("hashes the same content to the same value and different content differently", () => {
    expect(contentHash("a,b\n1,2\n")).toBe(contentHash("a,b\n1,2\n"));
    expect(contentHash("a,b\n1,2\n")).not.toBe(contentHash("a,b\n1,3\n"));
  });

  it("notices a change of one centavo", () => {
    // The whole point is catching a month that looks the same and is not.
    expect(contentHash("total\n1000.00\n")).not.toBe(contentHash("total\n1000.01\n"));
  });
});

/**
 * Why an empty period is empty.
 *
 * The screen said *"Nothing to export for this period"* for two opposite situations: nothing exists
 * in these dates, and records exist but nobody has approved them. Those need completely different
 * actions — change the dates, or go and approve some bills — and the company hit the first one
 * because the screen defaults to last month and every record they had made was dated that morning.
 *
 * Tested through the service rather than a rule, because the distinction *is* a query: it is the
 * difference between "no rows matched" and "rows matched and were filtered", which no pure function
 * can know. This is also the shape docs/DECISIONS.md #133 is about — the pure half was already
 * right, and nothing tested the half that talks to the database.
 */
describe("an empty export says which kind of empty", () => {
  const suffix = randomUUID().slice(0, 8);
  const supplierIds: string[] = [];
  const invoiceIds: string[] = [];

  afterAll(async () => {
    await db.supplierInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await db.supplier.deleteMany({ where: { id: { in: supplierIds } } });
  });

  it("counts what is present but unapproved, rather than reporting a bare nothing", async () => {
    const supplier = await db.supplier.create({
      data: { code: `EXPT-${randomUUID().slice(0, 10)}`, name: `Export Supply ${suffix}` },
    });
    supplierIds.push(supplier.id);

    // Two bills inside the window, neither approved. §8 exports only approved and paid — an
    // unapproved bill is money AIES has not agreed to pay, and posting it would be wrong.
    const day = new Date("2026-04-15");
    for (const ref of ["EXPT-1", "EXPT-2"]) {
      const row = await db.supplierInvoice.create({
        data: {
          number: `EXPT-${randomUUID().slice(0, 10)}`,
          supplierId: supplier.id,
          supplierRef: `${ref}-${suffix}`,
          invoiceDate: day,
          amount: "1000.00",
          status: "matched",
          recordedById: `exp-${suffix}`,
        },
      });
      invoiceIds.push(row.id);
    }

    const preview = await previewExportService({
      dataset: "supplier_bills",
      preset: "generic",
      periodStart: new Date("2026-04-01"),
      periodEnd: new Date("2026-04-30"),
    });

    expect(preview.rowCount).toBe(0);
    // The whole point: the screen can now say "two are waiting for approval" instead of "nothing",
    // which is the difference between a dead end and an instruction.
    expect(preview.empty?.excludedByStatus).toBe(2);
  }, 60_000);

  it("carries the date of the most recent record, so somebody can be pointed at it", async () => {
    const supplier = await db.supplier.create({
      data: { code: `EXPT2-${randomUUID().slice(0, 9)}`, name: `Export Supply 2 ${suffix}` },
    });
    supplierIds.push(supplier.id);

    const approved = await db.supplierInvoice.create({
      data: {
        number: `EXPT2-${randomUUID().slice(0, 9)}`,
        supplierId: supplier.id,
        supplierRef: `EXPT2-${suffix}`,
        invoiceDate: new Date("2026-07-10"),
        amount: "5000.00",
        status: "approved",
        recordedById: `exp-${suffix}`,
      },
    });
    invoiceIds.push(approved.id);

    // A period deliberately before anything exists — the "you are looking at the wrong month" case.
    const preview = await previewExportService({
      dataset: "supplier_bills",
      preset: "generic",
      periodStart: new Date("2020-01-01"),
      periodEnd: new Date("2020-01-31"),
    });

    expect(preview.rowCount).toBe(0);
    expect(preview.empty?.latestRecordAt).not.toBeNull();
  }, 60_000);

  it("says nothing about emptiness when the export is not empty", async () => {
    const supplier = await db.supplier.create({
      data: { code: `EXPT3-${randomUUID().slice(0, 9)}`, name: `Export Supply 3 ${suffix}` },
    });
    supplierIds.push(supplier.id);

    const row = await db.supplierInvoice.create({
      data: {
        number: `EXPT3-${randomUUID().slice(0, 9)}`,
        supplierId: supplier.id,
        supplierRef: `EXPT3-${suffix}`,
        invoiceDate: new Date("2026-06-15"),
        amount: "7000.00",
        status: "approved",
        recordedById: `exp-${suffix}`,
      },
    });
    invoiceIds.push(row.id);

    const preview = await previewExportService({
      dataset: "supplier_bills",
      preset: "generic",
      periodStart: new Date("2026-06-01"),
      periodEnd: new Date("2026-06-30"),
    });

    expect(preview.rowCount).toBeGreaterThan(0);
    // Null, not an empty object. The two counts are only paid for when the answer is needed.
    expect(preview.empty).toBeNull();
  }, 60_000);
});
