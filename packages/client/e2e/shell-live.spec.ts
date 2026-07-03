/**
 * Live end-to-end smoke of the whole cockpit against a REAL @cm/server.
 *
 * Boots the Fastify backend on a temp port + temp CM_DATA_DIR with CM_FAKE_SDK=1
 * (a deterministic in-process echo — no `claude` subprocess, no auth/network),
 * serving the built SPA at same origin, then drives the UI:
 *   WS connects (hello) → seeded config hydrates → create a project via the UI →
 *   create a chat → the composer sends a user message that appears in the
 *   transcript (and the fake session echoes it back over the WS) → panels +
 *   attention render. Ends by saving .artifacts/shell-live.png.
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
  server = spawn("pnpm", ["--filter", "@cm/server", "exec", "tsx", "src/index.ts"], {
    cwd: repoRoot,
    shell: true,
    env: {
      ...process.env,
      CM_PORT: String(PORT),
      CM_HOST: "127.0.0.1",
      CM_DATA_DIR: dataDir,
      CM_FAKE_SDK: "1",
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

test("live cockpit: connect → create project → chat → send message → panels", async ({ page }) => {
  await page.goto(`${BASE}/`);

  // 1) WS handshake: the top bar reflects a live socket.
  await expect(page.getByText("Connected")).toBeVisible();

  // 2) REST hydrate: the seeded Hivebreak project is present in the sidebar.
  await expect(page.getByText("Hivebreak")).toBeVisible();

  // 3) Create a project via the UI (project selector → "Add project…").
  await page.getByRole("button").filter({ hasText: "Hivebreak" }).first().click();
  await page.getByText(/Add project/).click();

  const projectName = "E2E Project";
  await page.getByPlaceholder("Hivebreak").fill(projectName);
  await page.getByPlaceholder("C:/Users/you/projects/app").fill(repoRoot);
  await page.getByPlaceholder("…/app-worktrees").fill(join(repoRoot, "wt"));
  await page.getByRole("button", { name: "Create project" }).click();

  // The new project becomes active (its name shows in the selector head).
  await expect(page.getByText(projectName)).toBeVisible();

  // 4) Create a chat via the UI. "New chat" now instantly creates + auto-selects
  //    a chat (no dialog) with the default title — the chat view mounts with it.
  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByRole("heading", { name: "New chat" })).toBeVisible();

  // 5) The composer sends a user message that appears in the transcript.
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

  // 6) Panels + attention render.
  await expect(page.getByRole("tab", { name: "Worktrees" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Apps" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "PRs" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Attention/ })).toBeVisible();

  // 7) Snapshot the live shell.
  await page.screenshot({ path: resolve(repoRoot, ".artifacts", "shell-live.png") });
});
