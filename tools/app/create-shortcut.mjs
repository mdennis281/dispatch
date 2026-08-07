#!/usr/bin/env node
/**
 * Create a Start-menu (and optionally Desktop) shortcut that boots Dispatch.
 *
 * ── What it targets, and why that's fine now ────────────────────────────────
 * `pythonw.exe`, running `tools/app/launch.py`. No binary is built, copied or
 * stamped: the old flow shipped a 270MB renamed Electron with the icon written
 * into it by rcedit, purely because Windows resolves a PINNED TASKBAR item to
 * its target executable and would otherwise pin "Electron", icon and all.
 *
 * That constraint doesn't apply here, because this shortcut is not the thing
 * you pin to the taskbar. It starts the server and hands off to Chromium, and
 * the INSTALLED PWA is what gets a taskbar identity — Chrome mints its own
 * AppUserModelID, shortcut and icon when you install it, which is a better
 * version of what rcedit was faking. Use this to launch; use Chrome's
 * "Install Dispatch" once, and pin that.
 *
 * A Start-menu entry does honour a .lnk's IconLocation, so the tile looks
 * right regardless.
 *
 * `pythonw` and not `python`: the launcher's detached half is a long-lived
 * supervisor, and `python.exe` would leave a console window open for its
 * entire lifetime.
 *
 * Windows only; a no-op elsewhere.
 *
 * Usage: node tools/app/create-shortcut.mjs [--target <root>] [--desktop]
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { desktopPaths } from "./paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

function parseArgs(argv) {
  const args = { desktop: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--desktop") args.desktop = true;
    else if (a === "--target") args.target = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const paths = desktopPaths(
  args.target ? { ...process.env, DISPATCH_HOME: args.target } : process.env,
);

if (process.platform !== "win32") {
  console.log("not Windows — skipping shortcut creation.");
  process.exit(0);
}

/** The interpreter the shortcut runs. Windowless variant when one exists. */
function findPythonw() {
  let exe;
  for (const cmd of ["python", "python3", "py"]) {
    try {
      exe = execFileSync(cmd, ["-c", "import sys; print(sys.executable)"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (exe) break;
    } catch {
      /* try the next name */
    }
  }
  if (!exe) {
    console.error(
      "Python not found on PATH.\n" +
        "  Dispatch's launcher is a Python script (it supervises the server and\n" +
        "  opens the PWA window via pwa-launcher). Install Python 3.10+ and retry.",
    );
    process.exit(1);
  }
  const windowless = join(dirname(exe), "pythonw.exe");
  return existsSync(windowless) ? windowless : exe;
}

const python = findPythonw();

// Warn early rather than let the shortcut fail silently on first click.
try {
  execFileSync(python.replace(/pythonw\.exe$/i, "python.exe"), ["-c", "import pwa_launcher"], {
    stdio: "ignore",
  });
} catch {
  console.log(
    "note: `pwa_launcher` isn't importable by this interpreter.\n" +
      "      The shortcut will start the server but can't open the app window.\n" +
      "      Fix with:  pip install pwa-launcher\n",
  );
}

/**
 * Prefer the published payload's launcher; fall back to this checkout so the
 * shortcut works before the first publish. The payload is a real git checkout,
 * so it carries its own copy of this tooling.
 */
const payloadLauncher = join(paths.app, "tools", "app", "launch.py");
const repoLauncher = join(repoRoot, "tools", "app", "launch.py");
const launcher = existsSync(payloadLauncher) ? payloadLauncher : repoLauncher;
if (!existsSync(launcher)) {
  console.error(`No launcher found at:\n  ${payloadLauncher}\n  ${repoLauncher}`);
  process.exit(1);
}
if (launcher === repoLauncher) {
  console.log(
    `note: no published payload yet — pointing at this checkout:\n  ${repoRoot}\n` +
      `      Re-run after \`pnpm app:publish\` to switch to the installed payload.\n`,
  );
}

/**
 * The icon, rendered by `packages/client/scripts/generate-brand.mjs`. Prefer the
 * payload's built copy (stable across publishes, since publish rebuilds in
 * place); fall back to the checkout's `public/`.
 */
const iconCandidates = [
  join(paths.app, "packages", "client", "dist", "icons", "favicon.ico"),
  join(repoRoot, "packages", "client", "dist", "icons", "favicon.ico"),
  join(repoRoot, "packages", "client", "public", "icons", "favicon.ico"),
];
const icon = iconCandidates.find((p) => existsSync(p));
if (!icon) {
  console.log(
    "note: no favicon.ico found — the shortcut will use Python's icon.\n" +
      "      Generate it with:  pnpm --filter @dispatch/client brand\n",
  );
}

/**
 * Ask Windows where these folders actually are rather than assuming
 * `%USERPROFILE%\Desktop` — OneDrive (and any roaming profile policy) redirects
 * them, and writing to the stale location fails with DirectoryNotFound.
 */
function shellFolder(name) {
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::GetFolderPath('${name}')`],
    { encoding: "utf8" },
  ).trim();
  return out || null;
}

const programs =
  shellFolder("Programs") ??
  join(
    process.env.APPDATA ?? join(homedir(), "AppData/Roaming"),
    "Microsoft/Windows/Start Menu/Programs",
  );
const targets = [join(programs, "Dispatch.lnk")];
if (args.desktop) {
  const desktop = shellFolder("DesktopDirectory");
  if (desktop && existsSync(desktop)) targets.push(join(desktop, "Dispatch.lnk"));
  else console.log(`note: no Desktop folder found (${desktop ?? "unresolved"}) — skipping.\n`);
}

/**
 * Quote a value as a PowerShell SINGLE-quoted literal (doubling any `'`).
 *
 * Not `JSON.stringify`: PowerShell's double-quoted strings treat `\` as a
 * literal character, not an escape, so a JSON-escaped Windows path like
 * `"C:\\Users\\..."` lands wrong, and an embedded `\"` terminates the string
 * early and becomes a parse error. Single quotes also suppress `$` expansion.
 */
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

// PowerShell's WScript.Shell is the only dependency-free way to write a .lnk.
for (const lnk of targets) {
  const ps = [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psq(lnk)})`,
    `$s.TargetPath = ${psq(python)}`,
    // Quoted inside the argument string so a path with spaces stays one argv entry.
    `$s.Arguments = ${psq(`"${launcher}"`)}`,
    `$s.WorkingDirectory = ${psq(dirname(launcher))}`,
    `$s.Description = ${psq("Dispatch - local control plane for Claude Code agents")}`,
    ...(icon ? [`$s.IconLocation = ${psq(`${icon},0`)}`] : []),
    `$s.Save()`,
  ].join("; ");
  execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    stdio: "inherit",
  });
  console.log(`created ${lnk}`);
}

console.log(`\nShortcut runs: ${python}\n  ${launcher}`);
console.log(
  `\nFirst run: click it, then use Chrome's "Install Dispatch" (the icon in the\n` +
    `address bar). Pin THAT to the taskbar — an installed PWA carries its own\n` +
    `identity and icon, which a shortcut to an interpreter cannot.`,
);
