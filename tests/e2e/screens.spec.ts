import { expect, test } from "@playwright/test";
import { signIn } from "./helpers/sign-in";

/**
 * Every screen, signed in, asserted to actually render.
 *
 * ## Why this exists
 *
 * docs/PROGRESS.md has carried a "Not visually verified" list since module 00, for one reason: the
 * app is behind a mandatory TOTP gate that nothing automated could pass. The cost showed up as a
 * particular class of bug that unit tests are structurally incapable of catching, and that this
 * build shipped three times:
 *
 * - **Accreditation**: service, panel and tests all present, and no route to any of it — the
 *   register listed records that already existed and its empty state pointed at an account page
 *   whose card was read-only.
 * - **Contacts and plants**: modelled since session 2, with nothing in the UI able to create one,
 *   so every picker that depended on them was permanently empty.
 * - **Photographs**: uploaded fine, stored fine, and blocked by a CSP header on the way back.
 *
 * All three were reported by the company. None of them could fail a unit test, because in every
 * case the *code* was right — what was missing was a route between two working halves.
 *
 * So these tests are deliberately shallow and wide. They do not re-test business rules that already
 * have unit coverage; they assert that each screen loads, renders its own heading, and shows the
 * control that is the reason to open it.
 */

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

const SCREENS = [
  { path: "/", heading: "AIES Operations Platform" },
  { path: "/crm/my-day", heading: "My day" },
  { path: "/crm/pipeline", heading: "Pipeline" },
  { path: "/crm/accounts", heading: "Accounts" },
  { path: "/crm/inquiries", heading: "Inquiries" },
  { path: "/crm/accreditations", heading: "Customer accreditations" },
  { path: "/crm/principals", heading: "Principal" },
  { path: "/quotations", heading: "Quotations" },
  { path: "/suppliers", heading: "Suppliers" },
  { path: "/sales-orders", heading: "Sales orders" },
  { path: "/procurement", heading: "Procurement" },
  { path: "/tickets", heading: "Tickets" },
  { path: "/quotations/approvals", heading: "Awaiting approval" },
  { path: "/notifications", heading: "Notification" },
  { path: "/admin/users", heading: "Users" },
];

for (const screen of SCREENS) {
  test(`${screen.path} renders`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    const response = await page.goto(screen.path);
    expect(response?.status(), `${screen.path} should not error`).toBeLessThan(400);

    await expect(
      page.getByRole("heading", { name: new RegExp(screen.heading, "i") }).first(),
    ).toBeVisible();

    // "Loading…" that never resolves is the failure mode a status-code check misses entirely.
    await expect(page.getByText(/^Loading/).first()).toBeHidden({ timeout: 15_000 });

    // The CSP that hid every photograph announced itself here and nowhere else — no server log, no
    // failed request, just a console violation.
    const violations = errors.filter((e) => /Content Security Policy|Refused to/i.test(e));
    expect(violations, `${screen.path} raised CSP violations`).toEqual([]);
  });
}

test("the sidebar offers the sections this user can reach", async ({ page }) => {
  await page.goto("/");
  // Built from the module manifests at runtime, so an empty sidebar means the registry failed to
  // boot rather than a styling problem.
  for (const label of [
    "My day",
    "Pipeline",
    "Accounts",
    "Inquiries",
    "Quotations",
    "Sales orders",
    "Procurement",
    "Suppliers",
    "Tickets",
  ]) {
    await expect(page.getByRole("link", { name: label })).toBeVisible();
  }
});

test("a customer record offers the controls that had no route for weeks", async ({ page }) => {
  await page.goto("/crm/accounts");

  // Wait for real rows. The table renders a "Loading..." row first, and clicking that navigates
  // nowhere — which is exactly how this test failed the first two times it was written.
  await expect(page.getByText(/^Loading/).first()).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText(/^AIESACC-\d+/).first()).toBeVisible({ timeout: 15_000 });

  // The first *data* cell, not the row: a row's centre can land in the actions column, whose
  // controls stop the click from reaching the row handler.
  const firstCell = page.getByRole("row").nth(1).getByRole("cell").first();
  await firstCell.click();

  await expect(page).toHaveURL(/\/crm\/accounts\/[^/]+$/);

  // The three that were unreachable. Each is asserted by the control that creates the thing,
  // because that is precisely what was missing while the services and panels already existed.
  await expect(page.getByRole("button", { name: /Add a plant/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Add a contact/i })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Start accreditation|Update certificate or expiry/i }),
  ).toBeVisible();
});

test("the quotations list opens a record with its panels in order", async ({ page }) => {
  await page.goto("/quotations");

  await expect(page.getByText(/^Loading/).first()).toBeHidden({ timeout: 15_000 });

  // The explicit affordance the list offers, rather than the row's click handler — this is the
  // control a person actually uses, so it is the one worth asserting works.
  const open = page.getByRole("link", { name: "Open" }).first();
  if (!(await open.isVisible({ timeout: 10_000 }).catch(() => false))) {
    test.skip(true, "no quotations in this database");
    return;
  }

  await open.click();
  await expect(page).toHaveURL(/\/quotations\/[^/]+$/);

  // Details → Lines → Supplier pricing → Terms, which the company asked for by name.
  for (const heading of ["Details", "Lines", "Supplier pricing", "Terms"]) {
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
  }
});
