import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // Not verified in parallel: the suite needs the wrangler dev server (webServer below),
  // which could not be started when this was evaluated. Tests keep no per-file state, so
  // true is probably safe; try it where the server runs.
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
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        launchOptions: process.env.VFRAME_WEBKIT_EXECUTABLE_PATH
          ? { executablePath: process.env.VFRAME_WEBKIT_EXECUTABLE_PATH }
          : {},
      },
    },
  ],
});
