/**
 * Screenshot harness — serves the built SPA with `vite preview` and captures the
 * shell at 1440×900 (2× for crispness) into Dispatch/.artifacts/shell.png.
 *
 *   node scripts/shot.mjs
 *
 * Requires a prior `pnpm build` (dist/) and the Playwright chromium browser
 * (`pnpm exec playwright install chromium`).
 */
import { preview } from "vite";
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, "..");
const artifactsDir = resolve(clientRoot, "../../.artifacts");
const outPath = resolve(artifactsDir, "shell.png");
const PORT = 4321;

async function main() {
  if (!existsSync(resolve(clientRoot, "dist/index.html"))) {
    throw new Error("dist/ not found — run `pnpm --filter @dispatch/client build` first.");
  }
  mkdirSync(artifactsDir, { recursive: true });

  const server = await preview({
    root: clientRoot,
    preview: { port: PORT, strictPort: true, host: "127.0.0.1" },
  });
  const url = server.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${PORT}/`;
  console.log(`[shot] preview at ${url}`);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: "dark",
    });
    await page.goto(url, { waitUntil: "networkidle" });
    // Let fonts settle + syntax highlighter + reveal animations finish.
    await page.waitForSelector("text=Dispatch", { timeout: 15_000 });
    await page.waitForTimeout(700);
    // Frame the crown-jewel content: put the first code block ~130px below the
    // transcript top so the assistant markdown + highlighted code + tool cards +
    // permission card read together (rather than the auto-scrolled bottom).
    await page.evaluate(() => {
      const sc = document.querySelector("[data-transcript]");
      const code = sc?.querySelector("pre");
      if (sc && code) {
        const scTop = sc.getBoundingClientRect().top;
        const cTop = code.getBoundingClientRect().top;
        sc.scrollTop += cTop - scTop - 130;
      }
    });
    await page.waitForTimeout(350);
    await page.screenshot({ path: outPath });
    console.log(`[shot] saved ${outPath}`);
  } finally {
    await browser.close();
    await server.httpServer?.close?.();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("[shot] failed:", err);
    process.exit(1);
  },
);
