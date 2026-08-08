import { TOTP, Secret } from "otpauth";
import { describe, expect, it } from "vitest";
import { generateTotpSecret, totpProvisioningUri, verifyTotp } from "@/server/core/auth/totp";

describe("totp", () => {
  it("generates a base32 secret", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+=*$/);
  });

  it("a valid current code verifies successfully", () => {
    const secret = generateTotpSecret();
    const totp = new TOTP({ secret: Secret.fromBase32(secret) });
    expect(verifyTotp(secret, totp.generate())).toBe(true);
  });

  it("an incorrect code fails verification", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, "000000")).toBe(false);
  });

  it("the provisioning URI is a valid otpauth:// URI naming the issuer and account", () => {
    const secret = generateTotpSecret();
    const uri = totpProvisioningUri(secret, "kj@aieselectromech.com");
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain("AIES%20Operations%20Platform");
    expect(uri).toContain("kj%40aieselectromech.com");
  });
});
