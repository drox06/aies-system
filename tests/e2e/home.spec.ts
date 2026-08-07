import { expect, test } from "@playwright/test";

test("home page loads and the health check responds", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "AIES Operations Platform" })).toBeVisible();

  const health = await request.get("/api/health");
  expect(health.ok()).toBe(true);
  expect((await health.json()).status).toBe("ok");
});
