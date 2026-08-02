#!/usr/bin/env node
/**
 * Install the branded Electron runtime — the app's own `claude-manager.exe`.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Windows identifies a taskbar item by the TARGET EXECUTABLE of its shortcut,
 * not by the shortcut's icon. Launching the shared `node_modules/electron/dist/
 * electron.exe` therefore makes Windows pin *Electron* — which is why pinning
 * "reverts" the icon the moment you do it. Nothing you set on the `.lnk` can
 * override that; the app needs an exe of its own.
 *
 * So: copy Electron's `dist/` to `<root>/shell/`, rename the binary, and stamp
 * the icon + version strings into it with rcedit. Electron finds its resources
 * relative to the exe, so a rename inside its own dist folder is all it takes.
 *
 * Copying (~270 MB) rather than renaming in place is deliberate — `node_modules/
 * electron` lives in pnpm's content-addressed store and is shared with every
 * other project on the machine. Writing there would be a fine way to corrupt an
 * unrelated app's Electron install.
 *
 * Idempotent: re-running with the same Electron version is a no-op unless
 * `--force`. Only needed again when Electron itself is upgraded.
 *
 * Usage: node tools/desktop/install-shell.mjs [--target <root>] [--force]
 */
import { cp, mkdir, rename, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopPaths } from "./paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

function parseArgs(argv) {
  const args = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") args.force = true;
    else if (a === "--target") args.target = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

/** Prefer the installed payload's Electron; fall back to this checkout's. */
function findElectronDist(paths) {
  const candidates = [
    join(paths.app, "packages", "desktop", "node_modules", "electron"),
    join(repoRoot, "packages", "desktop", "node_modules", "electron"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "dist", "electron.exe")) || existsSync(join(c, "dist", "electron"))) {
      return c;
    }
  }
  throw new Error(
    `Electron not found. Looked in:\n${candidates.map((c) => `  ${c}`).join("\n")}\n\n` +
      `Run \`pnpm install\` (or publish the payload) first.`,
  );
}

function portAlive(port) {
  return new Promise((res) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    const done = (v) => {
      sock.destroy();
      res(v);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    setTimeout(() => done(false), 1500);
  });
}

/** The exe can't be replaced while it's running — Windows holds a hard lock. */
async function assertNotRunning(paths) {
  if (!existsSync(paths.runtime)) return;
  try {
    const rt = JSON.parse(await readFile(paths.runtime, "utf8"));
    if (rt.port && (await portAlive(rt.port))) {
      throw new Error(
        `the desktop app is running (pid ${rt.pid}). Quit it from the tray and re-run.`,
      );
    }
  } catch (err) {
    if (err.message.includes("running")) throw err;
    /* unreadable marker => stale; continue */
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = desktopPaths(args.target ? { ...process.env, CM_HOME: args.target } : process.env);
  const electronPkg = findElectronDist(paths);
  const version = JSON.parse(await readFile(join(electronPkg, "package.json"), "utf8")).version;
  const marker = join(paths.shell, ".electron-version");

  console.log(`electron: ${version}`);
  console.log(`source  : ${join(electronPkg, "dist")}`);
  console.log(`shell   : ${paths.shell}\n`);

  const installed = existsSync(marker) ? (await readFile(marker, "utf8")).trim() : null;
  if (installed === version && existsSync(paths.exe) && !args.force) {
    console.log(`already installed (${version}) — nothing to do. Use --force to rebuild.`);
    return;
  }

  await assertNotRunning(paths);

  console.log("copying Electron runtime (~270 MB, one time per version)...");
  await rm(paths.shell, { recursive: true, force: true });
  await mkdir(dirname(paths.shell), { recursive: true });
  await cp(join(electronPkg, "dist"), paths.shell, { recursive: true });

  const original = join(paths.shell, process.platform === "win32" ? "electron.exe" : "electron");
  if (existsSync(original)) await rename(original, paths.exe);
  if (!existsSync(paths.exe)) throw new Error(`renamed binary missing: ${paths.exe}`);

  if (process.platform === "win32") {
    // Resolve rcedit from the desktop package — pnpm doesn't hoist it to root.
    const requireFrom = createRequire(join(repoRoot, "packages", "desktop", "package.json"));
    // rcedit v5 exposes a named `rcedit` export, not a callable module object.
    const mod = requireFrom("rcedit");
    const rcedit = typeof mod === "function" ? mod : mod.rcedit;
    if (typeof rcedit !== "function") {
      throw new Error(`unexpected rcedit export shape: ${Object.keys(mod).join(", ")}`);
    }
    const icon = join(repoRoot, "packages", "desktop", "assets", "icon.ico");
    if (!existsSync(icon)) {
      throw new Error(`icon.ico missing — run \`pnpm --filter @cm/desktop icon\` first.`);
    }
    console.log("stamping icon + version info...");
    await rcedit(paths.exe, {
      icon,
      "version-string": {
        ProductName: "claude-manager",
        FileDescription: "claude-manager — local control plane for Claude Code agents",
        CompanyName: "claude-manager",
        LegalCopyright: "",
        OriginalFilename: "claude-manager.exe",
        InternalName: "claude-manager",
      },
    });
  }

  await writeFile(marker, version);
  console.log(`\ninstalled ${paths.exe}`);
  console.log(`Re-run \`pnpm desktop:shortcut\` so the shortcut points at it.`);
}

main().catch((err) => {
  console.error(`\ninstall-shell failed: ${err.message}`);
  process.exitCode = 1;
});
