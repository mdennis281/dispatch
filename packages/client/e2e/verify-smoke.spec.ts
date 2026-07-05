/**
 * Fast READ-ONLY smoke against an ALREADY-RUNNING @cm/server (default
 * http://127.0.0.1:4319, override with CM_VERIFY_BASE).
 *
 * Unlike shell-live.spec.ts — which boots its own hermetic backend and mutates
 * state (creates a project + chat + message) — this spec spawns nothing and
 * changes nothing. It just asserts the SPA shell renders and hydrates over the
 * live WS. If no server is reachable it SKIPS, so `playwright test` stays green
 * without a running cockpit.
 */
import { test, expect } from "@playwright/test";

const BASE = process.env.CM_VERIFY_BASE ?? "http://127.0.0.1:4319";

async function serverUp(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

test.describe("verify smoke (live server)", () => {
  test.beforeAll(async () => {
    test.skip(!(await serverUp(BASE)), `no claude-manager server at ${BASE} — start it or set CM_VERIFY_BASE`);
  });

  test("app shell renders + hydrates over the live WS", async ({ page }) => {
    await page.goto(`${BASE}/`);

    // Shell chrome is always present (top bar mark).
    await expect(page.getByText("claude-manager")).toBeVisible();

    // WS hydrate flips the top-bar connection pill to "Connected".
    await expect(page.getByText("Connected")).toBeVisible();
  });
});
