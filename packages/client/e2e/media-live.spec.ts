/**
 * The image path, end to end, against a REAL @dispatch/server.
 *
 * WHY AN E2E AND NOT A UNIT TEST: every bug in this area so far has been in the
 * seam, not in a function. The parser was right and nothing rendered it; then
 * the renderer was right and the row it lived on never received the data. The
 * client's vitest runs in `node` with no DOM, so nothing below Playwright can
 * see a thumbnail actually paint.
 *
 * Boots the backend on a temp port + temp DISPATCH_DATA_DIR (same shape as
 * shell-live.spec.ts), SEEDS a chat whose transcript holds `Read` results with
 * image refs and real PNG bytes on disk, then drives the UI:
 *   thumbnails render in the grouped file rows → clicking one opens the viewer →
 *   ← / → walk every image in the CHAT (not just that row's group) → the
 *   buttons disable at the two ends.
 *
 * Screenshots land in .artifacts/ so a human can confirm what the assertions
 * only describe.
 */
import { test, expect } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const clientRoot = resolve(here, "..");
const repoRoot = resolve(clientRoot, "../..");
const distIndex = join(clientRoot, "dist", "index.html");
const artifacts = join(clientRoot, ".artifacts");

const PORT = 40000 + Math.floor(Math.random() * 15000);
const BASE = `http://127.0.0.1:${PORT}`;

const PROJECT_NAME = "Media";
const CHAT_TITLE = "Basement shots";

/**
 * A flat-colour PNG, built by hand.
 *
 * Distinct colours so a wrong image in the viewer is visibly wrong rather than
 * merely unequal, and big enough that a screenshot of the transcript shows a
 * picture rather than a speck.
 */
function png(r: number, g: number, b: number, width = 280, height = 180): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, "latin1"), data])), 0);
    return Buffer.concat([head, data, tail]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  // Raw scanlines: one filter byte then RGB per pixel.
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.concat(Array.from({ length: width }, () => Buffer.from([r, g, b]))),
  ]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  // Stored (uncompressed) deflate blocks — no zlib dependency needed.
  const blocks: Buffer[] = [];
  for (let off = 0; off < raw.length; off += 0xffff) {
    const slice = raw.subarray(off, off + 0xffff);
    const last = off + 0xffff >= raw.length ? 1 : 0;
    const header = Buffer.alloc(5);
    header[0] = last;
    header.writeUInt16LE(slice.length, 1);
    header.writeUInt16LE(~slice.length & 0xffff, 3);
    blocks.push(header, slice);
  }
  let a = 1;
  let bSum = 0;
  for (const byte of raw) {
    a = (a + byte) % 65521;
    bSum = (bSum + a) % 65521;
  }
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(((bSum << 16) | a) >>> 0, 0);
  const idat = Buffer.concat([Buffer.from([0x78, 0x01]), ...blocks, adler]);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The five images the transcript will carry, oldest → newest. */
const SHOTS = [
  { name: "cellar-head.png", rgb: [220, 60, 60] as const },
  { name: "upstair-foot.png", rgb: [60, 200, 90] as const },
  { name: "bsmt-shop.png", rgb: [70, 110, 240] as const },
  { name: "bsmt-plant.png", rgb: [230, 200, 60] as const },
  { name: "bsmt-halfdone.png", rgb: [190, 80, 220] as const },
];

/** Enough prose to push the early images past `TRANSCRIPT_PAGE_SIZE` (150). */
const FILLER_ROWS = 200;

/** Images that land inside the window a chat opens with. */
const IN_WINDOW = 3;

let server: ChildProcess | undefined;
let dataDir: string | undefined;

/**
 * Create the project + chat through the REST API, then write the transcript.
 *
 * The entities go through the API rather than being hand-written as JSON: their
 * schemas carry required fields (`modeId`, `effort`, …) that a fixture would
 * have to mirror and would silently drift from. The MESSAGES are still written
 * directly — those rows are the exact shape the broker persists for a `Read` of
 * an image, verified against a real transcript on disk, and writing them is
 * what makes this a test of the RENDERER rather than of the agent loop.
 */
async function seed(dir: string): Promise<{ chatId: string }> {
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
    return (await res.json()) as Record<string, unknown>;
  };

  const project = await post("/api/projects", {
    name: PROJECT_NAME,
    repoPath: join(dir, "repo"),
    worktreeRoot: "wt",
  });
  const chat = await post("/api/chats", {
    projectId: project.id,
    title: CHAT_TITLE,
  });
  const chatId = String(chat.id);

  // Leave OURS as the only project. The server seeds a demo one on a fresh data
  // dir, and with two the sidebar shows whichever is active — which meant the
  // test had to drive the project switcher to find its own chat, and that was
  // the one intermittently-failing step in the whole spec. One project is one
  // less thing for the UI to be mid-transition about.
  const projects = (await (await fetch(`${BASE}/api/projects`)).json()) as { id: string }[];
  for (const other of projects) {
    if (other.id === project.id) continue;
    await fetch(`${BASE}/api/projects/${other.id}`, { method: "DELETE" });
  }

  const chatDir = join(dir, "chats", chatId);
  const assetsDir = join(chatDir, "assets");
  mkdirSync(assetsDir, { recursive: true });

  const rows: unknown[] = [];
  let seq = 0;
  const now = 1_700_000_000_000;
  const push = (row: Record<string, unknown>): void => {
    seq += 1;
    rows.push({ id: `r${seq}`, chatId, ts: now + seq * 1000, turn: 1, ...row });
  };

  // The first two reads are separated by prose, so each renders as its own
  // single-image card. The last three are consecutive, so the transcript groups
  // them into one card — which is what exercises the tiled contact-sheet
  // layout. This mirrors the shape of a real session.
  SHOTS.forEach((shot, i) => {
    const asset = `${shot.name.replace(/\.png$/, "")}-${i}.png`;
    writeFileSync(join(assetsDir, asset), png(...shot.rgb));

    if (i < 2) push({ kind: "assistant", text: `Here is ${shot.name}:` });
    else if (i === 2) {
      // Push the first two images clear of the 150-row transcript WINDOW. A
      // gallery derived from the loaded rows reported a total that measured how
      // far the human had scrolled; this is what makes that visible to a test.
      for (let f = 0; f < FILLER_ROWS; f += 1) push({ kind: "assistant", text: `filler ${f}` });
      push({ kind: "assistant", text: "Now the rooms:" });
    }
    push({
      kind: "tool_use",
      toolUseId: `tu${i}`,
      name: "Read",
      input: { file_path: `claude/shots/${shot.name}` },
    });
    push({
      kind: "tool_result",
      toolUseId: `tu${i}`,
      ok: true,
      content: [{ type: "image", media_type: "image/png", asset: `assets/${asset}` }],
      images: [
        { id: `img${i}`, path: `assets/${asset}`, mimeType: "image/png", width: 280, height: 180 },
      ],
    });
  });

  const jsonl = rows.map((r) => JSON.stringify(r)).join(String.fromCharCode(10));
  writeFileSync(join(chatDir, "messages.jsonl"), jsonl + String.fromCharCode(10));
  return { chatId };
}

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
  expect(existsSync(distIndex), `built SPA missing at ${distIndex} — run vite build first`).toBe(true);

  dataDir = mkdtempSync(join(tmpdir(), "cm-media-e2e-"));
  mkdirSync(artifacts, { recursive: true });

  server = spawn("pnpm", ["--filter", "@dispatch/server", "exec", "tsx", "src/index.ts"], {
    cwd: repoRoot,
    shell: true,
    env: {
      ...process.env,
      DISPATCH_PORT: String(PORT),
      DISPATCH_HOST: "127.0.0.1",
      DISPATCH_DATA_DIR: dataDir,
      // A temp CONFIG dir too, not just data. `config/` is shared between every
      // instance on this machine, so inheriting it means inheriting the human's
      // auth settings — and the run stops at a sign-in page.
      DISPATCH_CONFIG_DIR: join(dataDir, "config"),
      DISPATCH_FAKE_SDK: "1",
    },
    // stdin PIPED, not ignored: the server treats a closed stdin as "my parent
    // is gone, shut down", and "ignore" hands it a already-ended stream.
    stdio: ["pipe", "pipe", "pipe"],
    // Its own process group off Windows, so `killTree` can take the whole tree
    // down rather than orphaning the node under the pnpm shim.
    detached: process.platform !== "win32",
  });
  server.stdout?.on("data", (d) => process.stdout.write(`[server] ${d}`));
  server.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

  await waitForHealth(BASE);
  // Seeded AFTER boot: the entities are created through the API, so the server
  // has to be up. The message rows land straight on disk and are picked up on
  // the next read of the transcript.
  await seed(dataDir);
});

/**
 * Kill the spawned server AND its children, on whichever OS this is.
 *
 * `pnpm → tsx → node` is a tree, so killing the pid we hold leaves the actual
 * server holding the port. Windows needs `taskkill /T`; elsewhere the shell is
 * a process-group leader, so a negative pid signals the whole group. Both are
 * best-effort — a failure here must not fail the suite.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // No process group (or already gone) — fall back to the child itself.
    try {
      child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  }
}

test.afterAll(async () => {
  if (server) killTree(server);
  if (dataDir) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
});

/**
 * Open the seeded chat and wait for its transcript.
 *
 * Clicked rather than deep-linked: the SPA has no URL routing — which surface
 * is showing is store state — so `/chat/<id>` is a 404 from Fastify, not a
 * route the app would pick up.
 */
async function openChat(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(`${BASE}/`);
  await expect(page.getByText("Connected")).toBeVisible();

  // A fresh config dir means a first run, which greets you with the "Protect
  // Dispatch" dialog over everything — dismiss it or every later click hits its
  // scrim. WAIT for it rather than probe once: the dialog mounts a beat after the WS
  // connects, so an immediate isVisible() says "no" and every later click then
  // lands on its scrim. A bounded click that swallows the timeout is a no-op
  // when the dialog never appears.
  await page
    .getByRole("button", { name: "Keep authentication off" })
    .click({ timeout: 10_000 })
    .catch(() => {});

  // Ours is the only project (see `seed`), so its chats are always the listed
  // ones — no switcher to drive, nothing to be mid-transition about.
  const chat = page.getByText(CHAT_TITLE).first();
  await expect(chat, "seeded chat is not listed in the sidebar").toBeVisible({
    timeout: 15_000,
  });
  await chat.click({ timeout: 10_000 });

  // Wait on an IMAGE, not on prose. Transcript rows use `content-visibility`,
  // so text that has scrolled out of view is genuinely not in the DOM — a
  // getByText on the oldest message is a race against where the view landed.
  await expect(page.locator("figure img").first()).toBeVisible({ timeout: 20_000 });
}

/**
 * Scroll the transcript to the top so every row is materialized.
 *
 * Driven from the DOM rather than by `mouse.wheel`, which depends on what the
 * cursor happens to be over and made this intermittently miss rows. Repeated
 * because `content-visibility` materializes rows as they approach the viewport,
 * which grows `scrollHeight` — one pass to the top is not necessarily the top.
 */
async function revealAll(page: import("@playwright/test").Page): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    const atTop = await page.evaluate(() => {
      const scroller = Array.from(document.querySelectorAll<HTMLElement>("*"))
        .filter((el) => el.scrollHeight > el.clientHeight + 50)
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (!scroller) return true;
      const was = scroller.scrollTop;
      scroller.scrollTop = 0;
      return was === 0;
    });
    await page.waitForTimeout(200);
    if (atTop && i > 0) break;
  }
  await page.waitForTimeout(300);
}

test("a Read of an image shows a thumbnail in the transcript", async ({ page }) => {
  await openChat(page);

  // The bug: the row rendered a filename and a line count, and the image the
  // agent had plainly just looked at appeared nowhere.
  await revealAll(page);
  const thumbs = page.locator("figure img");
  await expect(thumbs.first()).toBeVisible();
  await expect(thumbs).toHaveCount(SHOTS.length);

  await page.screenshot({ path: join(artifacts, "media-transcript.png"), fullPage: false });

  // The three consecutive reads collapse into ONE card of tiles rather than
  // three stacked cards — the layout that makes a set readable.
  const group = page.getByText(`${SHOTS.length - 2} images`);
  await group.scrollIntoViewIfNeeded();
  await expect(group).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(artifacts, "media-group.png"), fullPage: false });
});

test("the gallery is the whole chat, not the loaded window", async ({ page }) => {
  await openChat(page);

  // NO scrolling back: only the tail of the transcript is loaded, so only the
  // last three images exist as rows at all.
  await expect(page.locator("figure img")).toHaveCount(IN_WINDOW);

  await page.locator("figure img").first().click();
  const viewer = page.getByRole("dialog", { name: "Media viewer" });
  await expect(viewer).toBeVisible();

  // …and yet the viewer knows about all five, and places this one correctly.
  // Before the server answered this, it said "1/3".
  await expect(viewer.getByTestId("viewer-position")).toHaveText(
    `${SHOTS.length - IN_WINDOW + 1}/${SHOTS.length}`,
  );
  await expect(viewer.getByRole("button", { name: "Previous" })).toBeEnabled();
});

test("clicking a thumbnail opens the viewer on THAT image", async ({ page }) => {
  await openChat(page);

  await revealAll(page);
  await page.locator("figure img").nth(2).click();
  const viewer = page.getByRole("dialog", { name: "Media viewer" });
  await expect(viewer).toBeVisible();
  // Third of five, counted across the whole chat rather than within its row.
  await expect(viewer.getByTestId("viewer-position")).toHaveText("3/5");

  await page.screenshot({ path: join(artifacts, "media-viewer.png") });
});

test("arrows walk every image in the chat, and stop at both ends", async ({ page }) => {
  await openChat(page);

  await revealAll(page);
  await page.locator("figure img").first().click();
  const viewer = page.getByRole("dialog", { name: "Media viewer" });
  const position = viewer.getByTestId("viewer-position");
  const prev = viewer.getByRole("button", { name: "Previous" });
  const next = viewer.getByRole("button", { name: "Next" });

  // At the oldest image, Previous is dead — and must NOT close the viewer,
  // which is what pressing it used to do.
  await expect(position).toHaveText("1/5");
  await expect(prev).toBeDisabled();
  await prev.click({ force: true });
  await expect(viewer).toBeVisible();
  await expect(position).toHaveText("1/5");

  for (let i = 2; i <= SHOTS.length; i += 1) {
    await next.click();
    await expect(position).toHaveText(`${i}/5`);
    await expect(viewer).toBeVisible();
  }

  // At the newest, Next is dead — and pressing it must do NOTHING. A disabled
  // Button has `pointer-events: none`, so the click passes through it; if the
  // row underneath doesn't swallow it, it reaches the scrim and closes the
  // viewer. That is the original bug, reappearing exactly at the boundary.
  await expect(next).toBeDisabled();
  await next.click({ force: true });
  await expect(viewer).toBeVisible();
  await expect(position).toHaveText(`${SHOTS.length}/${SHOTS.length}`);

  // Keyboard agrees with the buttons.
  await page.keyboard.press("ArrowLeft");
  await expect(position).toHaveText("4/5");
  await expect(viewer).toBeVisible();

  // Escape is what closes it.
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
});
