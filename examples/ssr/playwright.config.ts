import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:44500",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm run test:workers",
    env: { XDG_CONFIG_HOME: ".wrangler" },
    url: "http://127.0.0.1:44500",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
});
