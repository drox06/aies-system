import { describe, expect, it } from "vitest";
import { formatDate, formatDateISO, formatDateTime, formatMoney } from "@/lib/format";

describe("formatMoney", () => {
  it("renders PHP with the peso sign, thousands separators and 2dp (Spec.md §6.6)", () => {
    // Intl uses a narrow no-break space in some ICU versions; normalise whitespace before asserting.
    expect(formatMoney(1234567.89).replace(/\s/g, "")).toBe("₱1,234,567.89");
  });

  it("always shows 2 decimal places, so a column of money lines up", () => {
    expect(formatMoney(5).replace(/\s/g, "")).toBe("₱5.00");
    expect(formatMoney(5.1).replace(/\s/g, "")).toBe("₱5.10");
  });

  it("accepts the string form Prisma Decimal serialises to, without losing digits", () => {
    expect(formatMoney("1234567.89").replace(/\s/g, "")).toBe("₱1,234,567.89");
  });

  it("renders an em dash rather than ₱0.00 for missing values", () => {
    // "No price yet" and "free" are different facts; showing zero for the first is a real error.
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(undefined)).toBe("—");
    expect(formatMoney("")).toBe("—");
    expect(formatMoney("not-a-number")).toBe("—");
  });

  it("never emits a bare number without its currency (Spec.md §6.6)", () => {
    expect(formatMoney(10)).toMatch(/₱/);
    expect(formatMoney(10, "USD")).toMatch(/\$/);
  });

  it("handles negatives, which billing credits produce", () => {
    expect(formatMoney(-1500).replace(/\s/g, "")).toContain("1,500.00");
  });
});

describe("formatDate", () => {
  it("renders DD MMM YYYY (Spec.md §6.6)", () => {
    expect(formatDate("2026-08-08T02:00:00.000Z")).toBe("08 Aug 2026");
  });

  it("is fixed to Asia/Manila regardless of the runtime's own timezone", () => {
    // 2026-08-08T20:00Z is already 09 Aug in Manila (UTC+8). A viewer's local zone must never
    // change which day a delivery or SLA deadline falls on.
    expect(formatDate("2026-08-08T20:00:00.000Z")).toBe("09 Aug 2026");
    // And just before the boundary it is still the 8th.
    expect(formatDate("2026-08-08T15:59:00.000Z")).toBe("08 Aug 2026");
  });

  it("accepts a Date as well as a string", () => {
    expect(formatDate(new Date("2026-01-31T04:00:00.000Z"))).toBe("31 Jan 2026");
  });

  it("returns an em dash for missing or unparseable values", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("nonsense")).toBe("—");
  });
});

describe("formatDateTime", () => {
  it("renders 24-hour time in Manila", () => {
    expect(formatDateTime("2026-08-08T02:30:00.000Z")).toBe("08 Aug 2026, 10:30");
  });
});

describe("formatDateISO", () => {
  it("exports ISO date parts in Manila terms, matching what the screen showed", () => {
    expect(formatDateISO("2026-08-08T20:00:00.000Z")).toBe("2026-08-09");
    expect(formatDateISO("2026-08-08T15:59:00.000Z")).toBe("2026-08-08");
  });

  it("returns an empty string for missing values so a CSV cell is blank, not '—'", () => {
    expect(formatDateISO(null)).toBe("");
  });
});
