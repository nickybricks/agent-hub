import { test, expect } from "@playwright/test";

const email = process.env.E2E_USER_EMAIL;
const password = process.env.E2E_USER_PASSWORD;

test.describe("sign-in → /app", () => {
  test.skip(
    !email || !password,
    "Set E2E_USER_EMAIL and E2E_USER_PASSWORD in .env.local to run this test.",
  );

  test("password sign-in lands on /app", async ({ page }) => {
    await page.goto("/login");

    await page.getByPlaceholder("you@example.com").fill(email!);
    await page.getByPlaceholder("Password").fill(password!);
    await page.getByRole("button", { name: /^sign in$/i }).click();

    await page.waitForURL("**/app", { timeout: 15_000 });
    await expect(page).toHaveURL(/\/app(\/|$)/);
  });
});
