import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config for the Dispatch SPA driven against a LIVE @dispatch/server.
 *
 * The spec spawns the real Fastify backend itself (temp port + temp DISPATCH_DATA_DIR
 * + DISPATCH_FAKE_SDK) so the whole run is hermetic — no shared dev server, no real
 * `claude` subprocess. There is no `webServer` block: the test owns the process
 * lifecycle so it can inject per-run env.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
    ...devices["Desktop Chrome"],
  },
});
