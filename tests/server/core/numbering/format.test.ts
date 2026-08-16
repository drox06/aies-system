import { describe, expect, it } from "vitest";
import { parseFormat } from "@/server/core/numbering/format";

describe("parseFormat", () => {
  it("renders the house format the company settled on", () => {
    // `AIES{CODE}-{YY}{####}` — every transaction document since 2026-08-16.
    const parsed = parseFormat("AIESPO-{YY}{####}", new Date("2026-08-15"));
    expect(parsed.scopeParts).toEqual(["26"]);
    expect(parsed.counterWidth).toBe(4);
    expect(parsed.render(1)).toBe("AIESPO-260001");
    // The year is the counter's scope, so the series restarts each January by itself.
    expect(parseFormat("AIESPO-{YY}{####}", new Date("2027-01-02")).render(1)).toBe(
      "AIESPO-270001",
    );
  });

  it("renders the yearless codes, whose counter never resets", () => {
    // An account or supplier code identifies a relationship, not a dated document.
    const parsed = parseFormat("AIESACC-{####}", new Date("2026-08-15"));
    expect(parsed.scopeParts).toEqual([]);
    expect(parsed.render(7)).toBe("AIESACC-0007");
  });

  it("still resolves {MM}, which no format uses since the rename", () => {
    // Kept working because module 07's controlled documents may want it, and dropping a token from
    // the mini-language is a breaking change nobody asked for.
    const parsed = parseFormat("INQ-{YY}{MM}-{####}", new Date("2026-08-15"));
    expect(parsed.scopeParts).toEqual(["26", "08"]);
    expect(parsed.render(42)).toBe("INQ-2608-0042");
  });

  it("resolves arbitrary extra tokens for non-date scopes", () => {
    const parsed = parseFormat("AIES-{DEPT}-{TYPE}-{###}", new Date("2026-08-15"), {
      DEPT: "OPS",
      TYPE: "SOP",
    });
    expect(parsed.scopeParts).toEqual(["OPS", "SOP"]);
    expect(parsed.render(12)).toBe("AIES-OPS-SOP-012");
  });

  it("does not truncate a counter that overflows its configured width", () => {
    const parsed = parseFormat("MTH-{YY}-{###}", new Date("2026-08-15"));
    expect(parsed.render(1234)).toBe("MTH-26-1234");
  });

  it("throws when a non-date token has no value in extra", () => {
    expect(() => parseFormat("AIES-{DEPT}-{###}", new Date())).toThrow(/DEPT/);
  });

  it("throws when the format has no counter token", () => {
    expect(() => parseFormat("INQ-{YY}{MM}", new Date())).toThrow(/no counter token/);
  });
});
