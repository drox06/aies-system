import { describe, expect, it } from "vitest";
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
