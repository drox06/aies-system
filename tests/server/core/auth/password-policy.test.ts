import { describe, expect, it } from "vitest";
import { checkPasswordPolicy } from "@/server/core/auth/password-policy";

describe("checkPasswordPolicy", () => {
  it("rejects passwords shorter than 12 characters, even if complex", () => {
    const result = checkPasswordPolicy("Xk9#mQ2!");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/12 characters/);
  });

  it("rejects a long but low-entropy password", () => {
    const result = checkPasswordPolicy("aaaaaaaaaaaaaaaa");
    expect(result.ok).toBe(false);
  });

  it("rejects a password that is just the account's own email", () => {
    const result = checkPasswordPolicy("kj@aieselectromech.com", ["kj@aieselectromech.com", "KJ"]);
    expect(result.ok).toBe(false);
  });

  it("accepts a long, high-entropy passphrase", () => {
    const result = checkPasswordPolicy("correct-horse-battery-staple-9Q!zv");
    expect(result.ok).toBe(true);
  });
});
