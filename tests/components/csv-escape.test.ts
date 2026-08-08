import { describe, expect, it } from "vitest";
import { csvEscape } from "@/components/ui/data-table";

describe("csvEscape", () => {
  it("leaves ordinary values untouched", () => {
    expect(csvEscape("Rosemount 3051S")).toBe("Rosemount 3051S");
  });

  it("quotes values containing a comma so later columns do not shift", () => {
    // A customer literally named this is the realistic case, and getting it wrong silently
    // corrupts every column to the right of it for that row only.
    expect(csvEscape("Smith, Ltd")).toBe('"Smith, Ltd"');
  });

  it("quotes and doubles embedded quotes (RFC 4180)", () => {
    expect(csvEscape('Smith "Manila" Ltd')).toBe('"Smith ""Manila"" Ltd"');
  });

  it("quotes values containing newlines, which pasted addresses carry", () => {
    expect(csvEscape("Unit 5\nLaguna")).toBe('"Unit 5\nLaguna"');
  });

  it("handles a value that is only a quote", () => {
    expect(csvEscape('"')).toBe('""""');
  });

  it("leaves the peso sign alone — it is carried by the UTF-8 BOM, not escaping", () => {
    expect(csvEscape("₱1,234.00")).toBe('"₱1,234.00"');
  });
});
