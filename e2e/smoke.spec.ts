import { test } from "@playwright/test";

// Placeholder until there is a UI to test. The web dashboard is out of scope
// for the MVP (P1 at most), so this stays skipped rather than asserting nothing.
test.skip("smoke: app loads", async ({ page }) => {
  await page.goto("/");
});
