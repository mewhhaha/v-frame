import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:43170",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: 'concurrently -k -n host,mfe "vite" "pnpm run serve:mfe"',
    url: "http://127.0.0.1:43170/overlay-lab.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
});
