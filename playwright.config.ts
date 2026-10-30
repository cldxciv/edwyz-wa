import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3500";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "test-results/results.json" }]],
  outputDir: "test-results/artifacts",
  use: {
    baseURL,
    // Each runner can pick its own client IP (E2E_IP) so parallel runs do not share one login/signup rate-limit bucket.
    extraHTTPHeaders: process.env.E2E_IP ? { "x-real-ip": process.env.E2E_IP } : undefined,
    channel: "chrome",
    // A production build registers public/sw.js (offline page). page.route() cannot see requests a service worker answers, so
    // specs that mock API calls would silently stop mocking; block it. Its behaviour is unit tested (tests/pwa-service-worker.test.ts).
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1366, height: 800 } } },
    { name: "mobile", use: { ...devices["Pixel 7"], channel: "chrome" }, grep: /@mobile/ },
  ],
});
