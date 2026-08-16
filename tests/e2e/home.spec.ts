import { expect, test } from "@playwright/test";

test("unauthenticated access to / redirects to /login, and the health check responds", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);

  /**
   * The brand is the logo lockup, not a text heading.
   *
   * This asserted a heading reading "AIES Operations Platform" until 2026-08-16. That heading was
   * replaced by the full-colour lockup when the auth screens were restyled (commit 61f13f0), and the
   * test has been failing ever since — unnoticed, because the e2e suite was not run again until
   * module 04 session 3. A red suite nobody runs is worth less than no suite at all: it trains
   * whoever finally runs it to assume the failure is pre-existing and skip past it.
   *
   * So this now asserts the thing that is actually on the page and actually matters — the brand is
   * present, and the two fields a person needs to sign in.
   */
  await expect(page.getByRole("img", { name: "AIES Electromechanical Corporation" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();

  const health = await request.get("/api/health");
  expect(health.ok()).toBe(true);
  expect((await health.json()).status).toBe("ok");
});
