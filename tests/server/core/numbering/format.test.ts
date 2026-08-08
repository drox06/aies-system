import { describe, expect, it } from "vitest";
import { parseFormat } from "@/server/core/numbering/format";

describe("parseFormat", () => {
  it("resolves {YY}{MM} and a zero-padded counter", () => {
    const parsed = parseFormat("INQ-{YY}{MM}-{####}", new Date("2026-08-15"));
    expect(parsed.scopeParts).toEqual(["26", "08"]);
    expect(parsed.counterWidth).toBe(4);
    expect(parsed.render(42)).toBe("INQ-2608-0042");
  });

  it("resolves a {YY}-only format with a 5-digit counter", () => {
    const parsed = parseFormat("SO-{YY}-{#####}", new Date("2026-08-15"));
    expect(parsed.scopeParts).toEqual(["26"]);
    expect(parsed.render(142)).toBe("SO-26-00142");
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
