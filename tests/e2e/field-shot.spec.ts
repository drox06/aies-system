import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/sign-in";

/**
 * A look at §14's delivery mode on a phone-sized viewport.
 *
 * Two assertions and a screenshot for the review pass. `/field` is the one screen built specifically
 * for a device nobody has run the app on, and shipping it to a driver without anybody having seen it
 * render would be the same mistake as trusting a service because its unit tests pass.
 */
test("delivery mode, phone size", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);

  await page.goto("/field");
  await expect(page.getByText("Deliveries")).toBeVisible();

  // The persistent indicator §14 asks for. It must always say one or the other — that is the whole
  // point of it being persistent rather than a spinner.
  const bar = page.locator("header");
  await expect(bar).toContainText(/Everything sent|waiting to send/);

  // The two halves of the indicator must not contradict each other. "Everything sent" beside a
  // button reading "Sending…" is the bug this assertion exists to stop coming back.
  await expect(bar).not.toContainText(/Everything sent[\s\S]*Sending…/);

  // Wait for the run to actually load rather than screenshotting the spinner.
  await expect(page.getByText("Loading your run…")).toBeHidden({ timeout: 15_000 });

  // Into the gitignored results directory: a screenshot is evidence for whoever ran it, not a
  // repo artefact that goes stale the next time the screen changes.
  await page.screenshot({ path: "test-results/field-mode-phone.png", fullPage: true });
});
