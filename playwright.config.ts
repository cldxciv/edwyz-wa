import { defineConfig, devices } from "@playwright/test";
import { APP_ENV_KEY, APP_PORT, appServerCommand, appServerEnv } from "./e2e/global-setup";

// E2E_BASE_URL set: test a server someone else started (its settings can't be known, so the promote specs refuse to run).
// Unset: Playwright starts the app itself (webServer below), so the runner owns the app's environment (docs/IG-PAGE-ADS-SPEC.md
// 9.4): GRAPH_BASE_URL at the fake Meta server, SPEND_DRY_RUN=1, PROMOTE_ENABLED=on, never NODE_ENV=production.
const external = (process.env.E2E_BASE_URL ?? "").trim();
const baseURL = external || `http://localhost:${APP_PORT}`;
// Workers load this file too (with TEST_WORKER_INDEX set); they keep the E2E_APP_ENV the runner recorded and start nothing.
const inWorker = process.env.TEST_WORKER_INDEX !== undefined;
const appEnv = external || inWorker ? null : appServerEnv(process.env, new URL(baseURL).origin);
if (!inWorker) {
  // What the app was started with, for e2e/global-setup.ts and e2e/promote-helpers.ts. Never left over from a shell.
  if (appEnv) process.env[APP_ENV_KEY] = JSON.stringify(appEnv);
  else delete process.env[APP_ENV_KEY];
}

export default defineConfig({
  testDir: "./e2e",
  // Starts the fake Meta Graph server on 127.0.0.1 (docs/IG-PAGE-ADS-SPEC.md 9.3), on the port the app was given above.
  globalSetup: "./e2e/global-setup.ts",
  // The app under test, started with the settings the promote specs check. A server already answering on the port stops the
  // run (reuseExistingServer: false), so a server started by hand with other settings is never tested by mistake. The default
  // (E2E_APP_MODE=start) is `next start` of your build, with NODE_ENV=test: run `npm run build` first. E2E_APP_MODE=dev uses
  // `next dev`. Other settings (EDDY_ENABLED, SPEND_ENFORCE and so on) come from your shell or .env as before.
  webServer: appEnv
    ? {
        command: appServerCommand(process.env, APP_PORT),
        url: baseURL,
        reuseExistingServer: false,
        timeout: 240_000,
        env: appEnv,
        stdout: "ignore",
        stderr: "pipe",
      }
    : undefined,
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
