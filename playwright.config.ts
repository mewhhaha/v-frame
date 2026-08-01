import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // tests/unit holds `node --test` files, which playwright's default match would
  // otherwise pick up and fail to run.
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  timeout: 15_000,
  expect: { timeout: 5_000 },
  use: {
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
});
