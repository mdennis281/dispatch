#!/usr/bin/env node
/**
 * Run the Electron shell against THIS checkout instead of the installed payload.
 *
 * Use it to iterate on the shell itself (tray, window, teardown) without
 * publishing. It points `DISPATCH_APP_DIR` at the repo root, so the server it spawns is
 * this checkout's `packages/server/dist` — remember that's the BUILT output, so
 * run `pnpm build` after changing server code.
 *
 * Data still comes from the real `%LOCALAPPDATA%\Dispatch` unless you
 * override DISPATCH_DATA_DIR / DISPATCH_CONFIG_DIR, so treat it as the live store.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopPaths } from "./paths.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const desktopPkg = join(repoRoot, "packages", "desktop");

/**
 * Prefer the branded `Dispatch.exe` when it's installed. Windows derives a
 * window's taskbar identity from the running executable, so launching the raw
 * `electron.exe` here would show (and pin) Electron's icon even though the
 * shortcut is correct — confusing while testing exactly that.
 */
const paths = desktopPaths();
const raw = join(desktopPkg, "node_modules", "electron", "dist", "electron.exe");
const electron = existsSync(paths.exe) ? paths.exe : existsSync(raw) ? raw : "electron";

if (!existsSync(join(repoRoot, "packages", "server", "dist", "index.js"))) {
  console.error("server is not built — run `pnpm build` first.");
  process.exit(1);
}

const child = spawn(electron, [desktopPkg], {
  cwd: desktopPkg,
  stdio: "inherit",
  env: { ...process.env, DISPATCH_APP_DIR: repoRoot },
});
child.on("exit", (code) => process.exit(code ?? 0));
