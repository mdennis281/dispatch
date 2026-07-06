/**
 * Reusable headless-Chromium page factory + a numbered `shot()` helper for the
 * claude-manager verification harness.
 *
 * It drives an ALREADY-RUNNING @cm/server (default http://127.0.0.1:4319) and
 * writes labeled PNGs to an output dir. It NEVER spawns or stops the server —
 * unlike packages/client/scripts/shot.mjs (which boots a `vite preview`) this is
 * meant for fast, tab-free verification against the live cockpit.
 *
 * New flows are a few lines — see tools/verify/shot.mjs `FLOWS`.
 */
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdirSync, statSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../..");
export const DEFAULT_BASE = "http://127.0.0.1:4319";

/**
 * `@playwright/test` is a devDependency of @cm/client and lives in pnpm's virtual
 * store, so it does NOT resolve from the repo root. Resolve it *from the client
 * package* and dynamic-import the file URL — no root-level dependency needed.
 */
async function loadChromium() {
  const clientRequire = createRequire(resolve(repoRoot, "packages/client/package.json"));
  const pwUrl = pathToFileURL(clientRequire.resolve("@playwright/test")).href;
  // @playwright/test is CJS: when dynamic-imported the named `chromium` export may
  // not be statically detected, so fall back to the default (module.exports) shape.
  const mod = await import(pwUrl);
  const chromium = mod.chromium ?? mod.default?.chromium;
  if (!chromium) throw new Error("could not load `chromium` from @playwright/test");
  return chromium;
}

/** Fetch /api/health; throw a clear, actionable error if the server isn't up. */
export async function assertServerUp(base) {
  try {
    const res = await fetch(`${base}/api/health`);
    if (res.ok) return;
    throw new Error(`health ${res.status}`);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(
      `claude-manager server not reachable at ${base} (${why}). ` +
        `Start it (pnpm start) or pass --base <url>.`,
    );
  }
}

/**
 * Launch a headless browser + page and return a small harness:
 *   { page, shot, close, dir, base, saved }
 * `shot(name, opts?)` writes a numbered PNG (`NN-name.png`), prints + records the
 * path/size, and returns the path. `opts` is forwarded to page.screenshot (e.g.
 * `{ fullPage: true }` or `{ clip }`).
 */
export async function createHarness({ base = DEFAULT_BASE, out, scale = 2, viewport } = {}) {
  const dir = resolve(out ?? resolve(repoRoot, ".verify-shots"));
  mkdirSync(dir, { recursive: true });

  const chromium = await loadChromium();
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: viewport ?? { width: 1440, height: 900 },
    deviceScaleFactor: scale,
    colorScheme: "dark",
  });
  const page = await context.newPage();

  let n = 0;
  const saved = [];
  async function shot(name, opts = {}) {
    n += 1;
    const label = String(name).replace(/[^a-z0-9._-]+/gi, "-");
    const file = join(dir, `${String(n).padStart(2, "0")}-${label}.png`);
    await page.screenshot({ path: file, ...opts });
    const bytes = statSync(file).size;
    saved.push({ file, bytes });
    console.log(`[verify] saved ${file} (${bytes} bytes)`);
    return file;
  }

  async function close() {
    await context.close();
    await browser.close();
  }

  return { browser, context, page, shot, close, dir, base, saved };
}

/* --------------------------------------------------------------- flow helpers */

/** Navigate to the app; wait for the shell, then a SOFT wait for WS "Connected". */
export async function gotoApp(page, base, timeout = 20_000) {
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  await page.getByText("claude-manager").first().waitFor({ timeout });
  // WS hydrate is best-effort — screenshot even if it stays "Connecting…".
  await page
    .getByText("Connected")
    .first()
    .waitFor({ timeout: 8_000 })
    .catch(() => {});
  // Let fonts + reveal animations settle.
  await page.waitForTimeout(500);
}

/** Click the first chat in the sidebar; resolves false when there are none. */
export async function selectFirstChat(page, timeout = 15_000) {
  const row = page.getByTestId("chat-row").first();
  try {
    await row.waitFor({ timeout });
  } catch {
    return false;
  }
  await row.click();
  // The transcript scroller mounts once a chat is active.
  await page
    .locator("[data-transcript]")
    .first()
    .waitFor({ timeout: 8_000 })
    .catch(() => {});
  await page.waitForTimeout(400);
  return true;
}

/**
 * The RightPanel tab strip, discovered LIVE (scoped to the right-hand `aside`) so
 * flows cover whatever tabs render today AND any added later (e.g. a Memory tab).
 */
export function panelTabs(page) {
  return page.locator("aside").last().getByRole("tab");
}

/**
 * Ensure a chat is open so the ChatView + RightPanel render. A chat is often
 * already active on load (the RightPanel tabs are the tell); only then do we fall
 * back to clicking the first chat row. Resolves false when there are no chats.
 */
export async function ensureChatOpen(page) {
  if ((await panelTabs(page).count()) > 0) return true;
  return selectFirstChat(page);
}

/* --------------------------------------------------------------- REST helpers */

/** Small JSON fetch against the running server's REST API. Throws on non-2xx. */
export async function api(base, path, { method = "GET", body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} → ${res.status} ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const listChats = (base, projectId) =>
  api(base, `/api/chats${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
export const createChat = (base, params) =>
  api(base, "/api/chats", { method: "POST", body: params });
export const deleteChat = (base, id) =>
  api(base, `/api/chats/${encodeURIComponent(id)}`, { method: "DELETE" });
export const readMessages = (base, id) =>
  api(base, `/api/chats/${encodeURIComponent(id)}/messages`);
export const listMemory = (base, projectId) =>
  api(base, `/api/projects/${encodeURIComponent(projectId)}/memory`);
export const deleteMemory = (base, projectId, name) =>
  api(base, `/api/projects/${encodeURIComponent(projectId)}/memory/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });

/* ------------------------------------------------------------- drive a chat */

/** Count `result` rows (turn-done signals) currently in a chat's transcript. */
async function resultCount(base, chatId) {
  const rows = await readMessages(base, chatId).catch(() => []);
  return rows.filter((r) => r.kind === "result").length;
}

/**
 * Poll the transcript until a NEW `result` row appears beyond `sinceResults`
 * (the turn finished → the session is idle) or `timeoutMs` elapses. Returns the
 * final message list. Never throws on timeout — the caller inspects the rows.
 */
export async function waitForChatIdle(base, chatId, sinceResults, timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rows = await readMessages(base, chatId).catch(() => []);
    const results = rows.filter((r) => r.kind === "result").length;
    if (results > sinceResults) return rows;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return readMessages(base, chatId).catch(() => []);
}

/** Select a specific chat row in the sidebar by its title text. */
export async function selectChatByTitle(page, title, timeout = 15_000) {
  const row = page.getByTestId("chat-row").filter({ hasText: title }).first();
  await row.waitFor({ timeout });
  await row.click();
  await page.locator("[data-transcript]").first().waitFor({ timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(400);
}

/** Type `text` into the composer's TipTap editor and send it (⌘/Ctrl+↵). */
export async function typeAndSend(page, text) {
  // TipTap renders a ProseMirror contenteditable inside the composer's `.cm-prose`.
  const box = page.locator('.cm-prose [contenteditable="true"]').first();
  await box.waitFor({ timeout: 10_000 });
  await box.click();
  await box.pressSequentially(text, { delay: 4 });
  await page.keyboard.press("Control+Enter");
}

/**
 * End-to-end "drive a chat": type `prompt` into the open chat, send it, wait for
 * the turn to finish (a new `result` row), and return the final transcript rows.
 * The chat must already be selected/open (see selectChatByTitle / ensureChatOpen).
 */
export async function driveChat(page, base, chatId, prompt, { timeoutMs = 120_000 } = {}) {
  const before = await resultCount(base, chatId);
  await typeAndSend(page, prompt);
  const rows = await waitForChatIdle(base, chatId, before, timeoutMs);
  return rows;
}

/** Compact one transcript row to a readable line for console/report scraping. */
export function summarizeRow(r) {
  if (r.kind === "assistant") return `assistant: ${(r.text ?? "").slice(0, 200)}`;
  if (r.kind === "tool_use") return `tool_use: ${r.name}(${JSON.stringify(r.input).slice(0, 160)})`;
  if (r.kind === "tool_result")
    return `tool_result[${r.ok ? "ok" : "ERR"}]: ${JSON.stringify(r.content).slice(0, 200)}`;
  if (r.kind === "permission") return `permission: ${r.toolName} → ${r.decision}`;
  if (r.kind === "result") return `result[${r.isError ? "error" : "ok"}]`;
  if (r.kind === "user") return `user: ${(r.text ?? "").slice(0, 120)}`;
  return `${r.kind}`;
}
