import { Secret, TOTP } from "otpauth";

const ISSUER = "AIES Operations Platform";

export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export function totpProvisioningUri(secretBase32: string, accountLabel: string): string {
  const totp = new TOTP({
    issuer: ISSUER,
    label: accountLabel,
    secret: Secret.fromBase32(secretBase32),
  });
  return totp.toString();
}

/** One step of clock drift tolerance either side (±30s), per RFC 6238 common practice. */
export function verifyTotp(secretBase32: string, token: string): boolean {
  const totp = new TOTP({ issuer: ISSUER, secret: Secret.fromBase32(secretBase32) });
  const delta = totp.validate({ token, window: 1 });
  return delta !== null;
}
