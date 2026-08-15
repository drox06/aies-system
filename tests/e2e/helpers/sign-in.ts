import { expect, type Page } from "@playwright/test";
import { Secret, TOTP } from "otpauth";

/**
 * Signs the browser in, second factor and all.
 *
 * This is the piece that was missing. Every screen in the app is behind a mandatory TOTP gate, so
 * until now nothing automated could see any of them — which is why docs/PROGRESS.md has carried a
 * "not visually verified" list since module 00, and why three separate "the service exists but no
 * screen reaches it" bugs survived 600-odd passing unit tests.
 *
 * The code is computed the same way the server verifies it, from the constant secret seeded by
 * `scripts/seed-e2e-user.ts`.
 */

export const E2E_EMAIL = "e2e@e2e.local";
const E2E_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

export function currentTotpCode(): string {
  return new TOTP({
    issuer: "AIES Operations Platform",
    secret: Secret.fromBase32(E2E_TOTP_SECRET),
  }).generate();
}

export async function signIn(page: Page): Promise<void> {
  const password = process.env.E2E_PASSWORD ?? "E2ePassw0rd!Aies";

  await page.goto("/login");
  await page.getByLabel("Email").fill(E2E_EMAIL);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  // The form asks for the second factor only after the password is accepted, so this also asserts
  // the password half worked.
  const codeField = page.getByLabel("Authenticator code");
  await expect(codeField).toBeVisible();

  await codeField.fill(currentTotpCode());
  await page.getByRole("button", { name: "Verify" }).click();

  // Landing anywhere other than the app means a first-run gate caught us — a seeded account with
  // `mustChangePassword` still set, most likely. Fail here rather than in whichever test runs first.
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page).not.toHaveURL(/\/change-password/);
  await expect(page).not.toHaveURL(/\/enroll-totp/);
}
