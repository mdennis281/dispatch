/**
 * Live end-to-end smoke of the whole cockpit against a REAL @dispatch/server.
 *
 * Boots the Fastify backend on a temp port + temp DISPATCH_DATA_DIR with DISPATCH_FAKE_SDK=1
 * (a deterministic in-process echo — no `claude` subprocess, no auth/network),
 * serving the built SPA at same origin, then drives the UI:
 *   WS connects (hello) → the FIRST-RUN SETUP WIZARD walks auth → gh → harness →
 *   first project → create a chat → the composer sends a user message that
 *   appears in the transcript (and the fake session echoes it back over the WS)
 *   → panels + attention render. Ends by saving .artifacts/shell-live.png.
 *
 * The wizard is not an extra step bolted on to this test — it is the only way a
 * project comes to exist on a fresh dataDir. Nothing is seeded any more (see
 * server `seed.ts`), so this is exactly what a new install does, end to end.
 *
 * It is NOT the safety net for first run, though, and must not be mistaken for
 * one: this spec is deliberately excluded from CI (`.github/workflows/ci.yml`
 * says why), so on a pull request nobody runs it. The pieces of first run that
 * genuinely need a guard — the probe gate and its fail-open store — are covered
 * in `src/stores/setup.test.ts`, which is in the vitest suite CI does run.
 */
import { test, expect } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const clientRoot = resolve(here, "..");
const repoRoot = resolve(clientRoot, "../..");
const distIndex = join(clientRoot, "dist", "index.html");

const PORT = 40000 + Math.floor(Math.random() * 15000);
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcess | undefined;
let dataDir: string | undefined;

async function waitForHealth(url: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`server never became healthy at ${url}: ${String(lastErr)}`);
}

test.beforeAll(async () => {
  // The SPA must be built (served statically by the backend at same origin).
  expect(existsSync(distIndex), `built SPA missing at ${distIndex} — run vite build first`).toBe(true);

  dataDir = mkdtempSync(join(tmpdir(), "cm-e2e-"));
  server = spawn("pnpm", ["--filter", "@dispatch/server", "exec", "tsx", "src/index.ts"], {
    cwd: repoRoot,
    shell: true,
    env: {
      ...process.env,
      DISPATCH_PORT: String(PORT),
      DISPATCH_HOST: "127.0.0.1",
      DISPATCH_DATA_DIR: dataDir,
      DISPATCH_FAKE_SDK: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (d) => process.stdout.write(`[server] ${d}`));
  server.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

  await waitForHealth(BASE);
});

test.afterAll(async () => {
  if (server?.pid) {
    // Kill the whole tree (pnpm → tsx → node) on Windows.
    spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  }
  if (dataDir) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
});

test("live cockpit: set up → create project → chat → send message → panels", async ({ page }) => {
  await page.goto(`${BASE}/`);

  // 1) First run: the wizard owns the window. Nothing is seeded, so this is
  //    what a brand-new install actually shows.
  await expect(page.getByRole("heading", { name: "Protect Dispatch" })).toBeVisible();

  // 2) Auth is optional — "keep it off" is an answer, not a skip.
  await page.getByRole("button", { name: "Keep authentication off" }).click();

  // 3) gh is PROBED. Whether this machine has it is not this test's business:
  //    the step is non-blocking either way, so match both labels.
  await expect(page.getByRole("heading", { name: "GitHub CLI" })).toBeVisible();
  await page.getByRole("button", { name: /^Continue/ }).click();

  // 4) The agent runtime step BLOCKS on having one. Claude Code always resolves
  //    (the SDK bundles its own runtime), so it is preselected and Continue is
  //    live — if that ever stops being true this assertion is the alarm.
  await expect(page.getByRole("heading", { name: "Agent runtime" })).toBeVisible();
  const continueHarness = page.getByRole("button", { name: "Continue" });
  await expect(continueHarness).toBeEnabled();
  await continueHarness.click();

  // 5) The last step is the real project page, and finishing it is what marks
  //    the install set up.
  await expect(page.getByRole("heading", { name: "Your first project" })).toBeVisible();

  const projectName = "E2E Project";
  await page.getByPlaceholder("Acme Billing").fill(projectName);
  await page.getByPlaceholder(/projects\/acme-billing|acme-billing/).fill(repoRoot);
  await page.getByRole("button", { name: "Create without AI" }).click();

  // The wizard is gone and the shell is live with the new project active.
  await expect(page.getByRole("heading", { name: "Your first project" })).toBeHidden();
  await expect(page.getByText("Connected")).toBeVisible();
  await expect(page.getByText(projectName)).toBeVisible();

  // 6) Create a chat via the UI. "New chat" now instantly creates + auto-selects
  //    a chat (no dialog) with the default title — the chat view mounts with it.
  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByRole("heading", { name: "New chat" })).toBeVisible();

  // 7) The composer sends a user message that appears in the transcript.
  const msg = "Hello from the E2E harness";
  const editor = page.locator(".ProseMirror");
  await editor.click();
  await page.keyboard.type(msg);
  await page.getByRole("button", { name: "Send" }).click();

  // User row lands (proves send-message → WS → store → transcript).
  await expect(page.getByText(msg, { exact: true })).toBeVisible();
  // The fake session echoes it back over the WS (proves the full round-trip
  // through chat-message events into the messages store, not just optimistic UI).
  await expect(page.getByText(`Echo: ${msg}`, { exact: true })).toBeVisible();

  // 8) Panels + attention render.
  await expect(page.getByRole("tab", { name: "Worktrees" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Apps" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "PRs" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Attention/ })).toBeVisible();

  // 9) Snapshot the live shell.
  await page.screenshot({ path: resolve(repoRoot, ".artifacts", "shell-live.png") });
});
