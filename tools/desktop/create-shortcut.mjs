#!/usr/bin/env node
/**
 * Create Start-menu (and optionally Desktop) shortcuts for the installed app.
 *
 * Targets `<root>/shell/claude-manager.exe` — the branded runtime from
 * `install-shell.mjs` — NOT `node_modules/electron/dist/electron.exe`. Windows
 * resolves a pinned taskbar item to the shortcut's target executable, so
 * pointing at the shared Electron binary makes Windows pin Electron's identity
 * and icon regardless of what the `.lnk` says. That is exactly the "pinning
 * reverted my icon" symptom.
 *
 * The exe carries the icon as an embedded resource (rcedit), so IconLocation
 * points at the exe itself rather than a loose file that could go missing.
 *
 * Windows only; a no-op elsewhere.
 *
 * Usage: node tools/desktop/create-shortcut.mjs [--target <root>] [--desktop]
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { desktopPaths } from "./paths.mjs";

const resolveRepoRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
const paths = desktopPaths(args.target ? { ...process.env, CM_HOME: args.target } : process.env);

if (process.platform !== "win32") {
  console.log("not Windows — skipping shortcut creation.");
  process.exit(0);
}

const exe = paths.exe;

if (!existsSync(exe)) {
  console.error(
    `Branded runtime not found at:\n  ${exe}\n\n` +
      `Run \`pnpm desktop:install-shell\` first.`,
  );
  process.exit(1);
}

/**
 * Prefer the published payload; fall back to this checkout so the shortcut is
 * usable before the first publish (e.g. while the desktop package is still
 * uncommitted). The exe — and therefore the taskbar identity and icon — is the
 * same either way, so pinning made now survives the switch to the payload.
 */
const payloadPkg = join(paths.app, "packages", "desktop");
const repoPkg = join(resolveRepoRoot(), "packages", "desktop");
const appPkg = existsSync(payloadPkg) ? payloadPkg : repoPkg;

if (!existsSync(appPkg)) {
  console.error(`No desktop package found at:\n  ${payloadPkg}\n  ${repoPkg}`);
  process.exit(1);
}
if (appPkg === repoPkg) {
  console.log(
    `note: no published payload yet — pointing at this checkout:\n  ${repoPkg}\n` +
      `      Re-run after \`pnpm desktop:publish\` to switch to the installed payload.\n`,
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

const programs = shellFolder("Programs") ?? join(
  process.env.APPDATA ?? join(homedir(), "AppData/Roaming"),
  "Microsoft/Windows/Start Menu/Programs",
);
const targets = [join(programs, "claude-manager.lnk")];
if (args.desktop) {
  const desktop = shellFolder("DesktopDirectory");
  if (desktop && existsSync(desktop)) targets.push(join(desktop, "claude-manager.lnk"));
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
    `$s.TargetPath = ${psq(exe)}`,
    // Quoted inside the argument string so a path with spaces stays one argv entry.
    `$s.Arguments = ${psq(`"${appPkg}"`)}`,
    `$s.WorkingDirectory = ${psq(appPkg)}`,
    `$s.Description = ${psq("claude-manager - local control plane for Claude Code agents")}`,
    // Index 0 = the exe's first embedded icon group, stamped by install-shell.
    `$s.IconLocation = ${psq(`${exe},0`)}`,
    `$s.Save()`,
  ].join("; ");
  execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    stdio: "inherit",
  });
  console.log(`created ${lnk}`);
}

console.log(`\nShortcut launches: ${exe}\n  with app dir: ${appPkg}`);
