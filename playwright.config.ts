import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  outputDir: "outputs/playwright-results",
  reporter: [["list"], ["html", { outputFolder: "outputs/playwright-report", open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:8788",
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node tests/helpers/e2e-server.mjs",
    url: "http://127.0.0.1:8788/api/shift-assignments?storeId=s1&date=2099-01-01",
    timeout: 180_000,
    reuseExistingServer: false,
  },
});
