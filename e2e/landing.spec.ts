import { test, expect } from "@playwright/test";

test("landing → waitlist submit shows success", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByLabel("Email address")).toBeVisible();

  const email = `e2e+${Date.now()}@mailyn.dev`;
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: /join the waitlist/i }).click();

  await expect(page.getByText(/you're in\. we'll write when mi opens up\./i)).toBeVisible({
    timeout: 10_000,
  });
});

test("waitlist rejects malformed email client-side", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email address").fill("not-an-email");
  await page.getByRole("button", { name: /join the waitlist/i }).click();
  await expect(page.getByText(/something went wrong/i)).toBeVisible();
});
