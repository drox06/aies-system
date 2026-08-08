import { describe, expect, it } from "vitest";
import { isLockedOut } from "@/server/core/auth/login-throttle";

describe("isLockedOut", () => {
  it("is not locked out when lockedUntil is null", () => {
    expect(isLockedOut({ lockedUntil: null })).toBe(false);
  });

  it("is locked out when lockedUntil is in the future", () => {
    const now = new Date("2026-08-08T10:00:00Z");
    const lockedUntil = new Date("2026-08-08T10:10:00Z");
    expect(isLockedOut({ lockedUntil }, now)).toBe(true);
  });

  it("is not locked out once lockedUntil has passed", () => {
    const now = new Date("2026-08-08T10:15:00Z");
    const lockedUntil = new Date("2026-08-08T10:10:00Z");
    expect(isLockedOut({ lockedUntil }, now)).toBe(false);
  });
});
