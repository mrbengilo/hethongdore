import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e-selfhost",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: { baseURL: "http://localhost:3184", trace: "retain-on-failure", screenshot: "only-on-failure" },
  reporter: [["list"], ["html", { open: "never" }]],
  webServer: {
    command: "node --require ./tests/tsx-windows-userinfo.cjs --import tsx tests/e2e-selfhost/server.mjs",
    url: "http://localhost:3184",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
