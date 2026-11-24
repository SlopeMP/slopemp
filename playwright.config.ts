import { defineConfig, devices } from "@playwright/test";

const port = process.env["SLOPEMP_TEST_PORT"] ?? "4173";
const baseURL = `http://127.0.0.1:${port}/slopemp/`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] === undefined ? 0 : 2,
  reporter: "list",
  use: { serviceWorkers: "block", trace: "retain-on-failure" },
  webServer: {
    command: "bun run start",
    url: baseURL,
    env: { SLOPEMP_PORT: port },
    reuseExistingServer: true,
  },
  projects: [
    {
      name: "chromium",
      testMatch: "**/*.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL },
    },
    {
      name: "firefox",
      testMatch: "**/*.spec.ts",
      use: { ...devices["Desktop Firefox"], baseURL },
    },
  ],
});
