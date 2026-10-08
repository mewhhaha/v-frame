import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // tests/unit holds `node --test` files, which playwright's default match would
  // otherwise pick up and fail to run.
  testMatch: "**/*.spec.ts",
  // Tests in a file share only the fixture server started in beforeAll, which is per worker
  // and never serves two tests at once, so tests can be spread across workers freely.
  fullyParallel: true,
  timeout: 15_000,
  expect: { timeout: 5_000 },
  use: {
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: "**/mobile.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      testIgnore: "**/mobile.spec.ts",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      testIgnore: "**/mobile.spec.ts",
      use: {
        ...devices["Desktop Safari"],
        launchOptions: process.env.VFRAME_WEBKIT_EXECUTABLE_PATH
          ? { executablePath: process.env.VFRAME_WEBKIT_EXECUTABLE_PATH }
          : {},
      },
    },
    {
      name: "mobile-chromium",
      testMatch: ["**/mobile.spec.ts", "**/ssr-state.spec.ts", "**/ssr-assets.spec.ts"],
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "mobile-webkit",
      testMatch: ["**/mobile.spec.ts", "**/ssr-state.spec.ts", "**/ssr-assets.spec.ts"],
      use: {
        ...devices["iPhone 13"],
        launchOptions: process.env.VFRAME_WEBKIT_EXECUTABLE_PATH
          ? { executablePath: process.env.VFRAME_WEBKIT_EXECUTABLE_PATH }
          : {},
      },
    },
  ],
});
