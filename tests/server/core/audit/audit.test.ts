import { describe, expect, it } from "vitest";
import { redactDiff } from "@/server/core/audit/audit";

describe("redactDiff", () => {
  it("redacts known sensitive field names", () => {
    const result = redactDiff({
      passwordHash: { from: "abc", to: "xyz" },
      totpSecret: { from: "secret1", to: "secret2" },
      name: { from: "Old Name", to: "New Name" },
    });

    expect(result).toEqual({
      passwordHash: { from: "[redacted]", to: "[redacted]" },
      totpSecret: { from: "[redacted]", to: "[redacted]" },
      name: { from: "Old Name", to: "New Name" },
    });
  });

  it("passes through a diff with no sensitive fields unchanged", () => {
    const diff = { email: { from: "a@x.com", to: "b@x.com" } };
    expect(redactDiff(diff)).toEqual(diff);
  });

  it("returns undefined for an undefined diff", () => {
    expect(redactDiff(undefined)).toBeUndefined();
  });
});
