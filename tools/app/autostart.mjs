#!/usr/bin/env node
/**
 * Register the installed Dispatch to come back by itself after a reboot.
 *
 * ── Login-scoped on every platform, deliberately ────────────────────────────
 * What this writes is a PER-USER entry — a Startup shortcut, a LaunchAgent, a
 * systemd *user* unit — and never a machine-wide service. Dispatch's whole job
 * is running agent CLIs out of your home directory: `claude` and `codex` keep
 * their credentials there, `gh` keeps its token there, every worktree it
 * manages is yours, and `config/` lives under your profile. A SYSTEM-scoped
 * service starts before any of that is unlocked and runs as an account that
 * owns none of it, so it would come up looking like a machine with no agents
 * installed at all.
 *
 * The price is that "after a reboot" really means "after you log in". On a
 * headless box reached through a tunnel that is the wrong shape — and the fix
 * is one command (`loginctl enable-linger`, printed below on Linux), not a
 * different install.
 *
 * ── Why an ABSOLUTE interpreter path ────────────────────────────────────────
 * `findPython()` in the installer resolves a PATH *name* (`python3`, `py -3`),
 * which is fine for a command you type. It is not fine here: launchd hands a
 * job `/usr/bin:/bin:/usr/sbin:/sbin` and a systemd user manager little more,
 * so a pyenv, Homebrew or Windows Store interpreter is simply absent from the
 * PATH the entry runs under — and the failure lands at login, unattended, with
 * nothing on screen to read. Every entry below records `sys.executable`.
 *
 * ── Why `--no-window` ───────────────────────────────────────────────────────
 * This starts the SERVER at login, not a browser. Dispatch is a thing you open
 * when you want it; an app that seizes the screen at every login is a thing you
 * uninstall.
 *
 * MIRROR: the on-disk layout here is the one in `paths.mjs` and `launch.py`.
 *
 * Usage:
 *   node tools/app/autostart.mjs --enable  [--target <root>]
 *   node tools/app/autostart.mjs --disable [--target <root>]
 *   node tools/app/autostart.mjs --status  [--target <root>]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, posix as posixPath, win32 as win32Path } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopRoot } from "./paths.mjs";

/** Shared identity: the launchd label, the systemd unit, the .desktop basename. */
export const AUTOSTART_ID = "dispatch";
const LAUNCHD_LABEL = "com.dispatch.app";

/**
 * Describe the autostart entry for a platform WITHOUT touching the disk.
 *
 * Split out from the doing so every entry's shape is testable from one machine:
 * CI is Linux, and a wrong plist key or a mis-split .lnk argument is exactly the
 * kind of bug that otherwise surfaces on somebody else's laptop weeks later.
 * Paths use the explicit `win32`/`posix` joiners rather than the ambient one for
 * the same reason — a Windows plan must come out backslashed even when it was
 * computed on Linux.
 *
 * @param {object} o
 * @param {string} o.platform      `process.platform` value to plan for.
 * @param {string} o.root          install root (holds `app/`, `data/`, `config/`).
 * @param {string} o.interpreter   ABSOLUTE path to the Python that runs the launcher.
 * @param {string} o.home          the user's home directory.
 * @param {object} [o.env]         environment, for XDG_CONFIG_HOME / APPDATA.
 * @param {boolean} [o.systemd]    Linux only: is `systemctl --user` usable here?
 * @param {string} [o.startupDir]  Windows only: the resolved Startup shell folder.
 */
export function autostartPlan({
  platform,
  root,
  interpreter,
  home,
  env = {},
  systemd = false,
  startupDir,
}) {
  if (platform === "win32") {
    const p = win32Path;
    const launcher = p.join(root, "app", "tools", "app", "launch.py");
    const dir =
      startupDir ??
      p.join(
        env.APPDATA ?? p.join(home, "AppData", "Roaming"),
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup",
      );
    return {
      platform,
      // A Startup-folder shortcut, because Task Manager's Startup tab lists one
      // beside the registry Run entries: this stays something the user can find
      // and switch off without knowing Dispatch wrote it. A Scheduled Task is
      // invisible there, and the only version of one that beats this — a
      // trigger at boot rather than at logon — needs an elevated install and a
      // stored password to run as you.
      kind: "startup-shortcut",
      path: p.join(dir, "Dispatch.lnk"),
      dir,
      launcher,
      target: interpreter,
      args: [launcher, "--no-window", "--target", root],
      workingDirectory: p.dirname(launcher),
    };
  }

  const p = posixPath;
  const launcher = p.join(root, "app", "tools", "app", "launch.py");
  const args = [launcher, "--no-window", "--target", root];

  if (platform === "darwin") {
    return {
      platform,
      kind: "launch-agent",
      label: LAUNCHD_LABEL,
      path: p.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
      launcher,
      args,
      contents: plist({ interpreter, args, root }),
    };
  }

  const configHome = env.XDG_CONFIG_HOME || p.join(home, ".config");
  if (systemd) {
    return {
      platform,
      kind: "systemd-user",
      unit: `${AUTOSTART_ID}.service`,
      path: p.join(configHome, "systemd", "user", `${AUTOSTART_ID}.service`),
      launcher,
      args,
      contents: systemdUnit({ interpreter, launcher, root }),
    };
  }
  return {
    platform,
    // The FALLBACK on Linux, not the first choice: an XDG autostart entry only
    // fires inside a graphical desktop session, and a fair share of Dispatch
    // installs are a headless box reached through a reverse proxy. A user unit
    // starts on any login, and with lingering enabled, at boot.
    kind: "xdg-autostart",
    path: p.join(configHome, "autostart", `${AUTOSTART_ID}.desktop`),
    launcher,
    args,
    contents: desktopEntry({ interpreter, args }),
  };
}

/** XML text escape — a home directory may legitimately contain `&`. */
const xml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "apos" }[c]};`,
  );

function plist({ interpreter, args, root }) {
  const argv = [interpreter, ...args].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <!-- No KeepAlive, on purpose: launch.py spawns a DETACHED supervisor and then
       exits 0. With KeepAlive, launchd reads that exit as a crash and respawns
       it forever, fighting the supervisor that is already up. Restarting the
       server is the supervisor's job; starting it once is launchd's. -->
  <key>KeepAlive</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${xml(`${root}/app`)}</string>
  <key>StandardOutPath</key>
  <string>${xml(`${root}/autostart.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(`${root}/autostart.log`)}</string>
</dict>
</plist>
`;
}

/** systemd takes a double-quoted argument; `\` and `"` are the two escapes. */
const unitQuote = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function systemdUnit({ interpreter, launcher, root }) {
  const run = (extra) => [interpreter, launcher, ...extra, "--target", root].map(unitQuote).join(" ");
  return `[Unit]
Description=Dispatch - local agent control plane
Documentation=https://github.com/mdennis281/dispatch
After=default.target

[Service]
# oneshot + RemainAfterExit, because ExecStart RETURNS: launch.py detaches a
# supervisor and exits as soon as the server answers. Under the default
# Type=simple, systemd reads that exit as the end of the service and tears the
# unit down while Dispatch is still running. Holding the unit "active" is also
# what makes ExecStop reachable, and ExecStop is the graceful path that stops
# agents and subApps at logout instead of orphaning them on their ports.
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${root}/app
ExecStart=${run(["--no-window"])}
ExecStop=${run(["--stop"])}

[Install]
WantedBy=default.target
`;
}

/**
 * An `Exec=` argument, escaped for the desktop-entry spec.
 *
 * Two separate layers, and missing either one corrupts the command:
 *
 * 1. Inside a quoted argument, `"`, `` ` ``, `$` and `\` take a backslash. The
 *    reserved set that FORCES quoting is wider than whitespace — `&`, `;`, `|`,
 *    `<`, `>`, `*`, `?`, `#`, `~`, `(`, `)` all count.
 * 2. `%` introduces a FIELD CODE (`%u`, `%f`, `%i`…), so a literal one has to
 *    be written `%%` whether or not the argument is quoted. A single `%` in a
 *    path is either silently eaten or gets the whole entry rejected, and paths
 *    do contain them — a percent-encoded directory name is enough.
 */
const EXEC_RESERVED = /[\s"'\\`$<>~|&;*?#()]/;
const execArg = (a) => {
  const escaped = String(a).replace(/(["\\`$])/g, "\\$1");
  const withCodes = EXEC_RESERVED.test(a) ? `"${escaped}"` : escaped;
  return withCodes.replace(/%/g, "%%");
};

function desktopEntry({ interpreter, args }) {
  const exec = [interpreter, ...args].map(execArg).join(" ");
  return `[Desktop Entry]
Type=Application
Name=Dispatch
Comment=Local agent control plane
Exec=${exec}
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
`;
}

// ------------------------------------------------------------------ runtime

/**
 * The interpreter the entry records, as an absolute path.
 *
 * Windows prefers `pythonw.exe`: this fires at login, and `python.exe` would
 * put a console window on the desktop of every session and leave it there for
 * as long as the launcher runs.
 */
export function resolveInterpreter(candidates = defaultPythonCandidates()) {
  for (const [command, prefix] of candidates) {
    try {
      const exe = execFileSync(command, [...prefix, "-c", "import sys; print(sys.executable)"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (!exe) continue;
      if (process.platform === "win32") {
        const windowless = win32Path.join(dirname(exe), "pythonw.exe");
        if (existsSync(windowless)) return windowless;
      }
      return exe;
    } catch {
      // Try the next name; the throw below is the report.
    }
  }
  throw new Error("Python 3.10+ is required by the Dispatch launcher but was not found on PATH");
}

function defaultPythonCandidates() {
  return process.platform === "win32"
    ? [
        ["py", ["-3"]],
        ["python", []],
        ["python3", []],
      ]
    : [
        ["python3", []],
        ["python", []],
      ];
}

function hasSystemd() {
  const probe = spawnSync("systemctl", ["--user", "--version"], {
    stdio: "ignore",
    windowsHide: true,
  });
  return probe.status === 0;
}

/** `[Environment]::GetFolderPath` — never a guessed path; OneDrive redirects these. */
function windowsStartupDir() {
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath('Startup')"],
      { encoding: "utf8" },
    ).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** Build the plan for THIS machine. */
export function currentPlan({ root, interpreter } = {}) {
  return autostartPlan({
    platform: process.platform,
    root: root ? resolve(root) : desktopRoot(),
    interpreter: interpreter ?? resolveInterpreter(),
    home: homedir(),
    env: process.env,
    systemd: process.platform === "linux" ? hasSystemd() : false,
    startupDir: process.platform === "win32" ? windowsStartupDir() : undefined,
  });
}

/** Quote a value as a PowerShell single-quoted literal (see create-shortcut.mjs). */
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Write the entry and tell the OS about it.
 *
 * `activate` reflects whether the caller also started Dispatch. It only reaches
 * systemd, where `enable --now` is what leaves the unit ACTIVE so its ExecStop
 * can run at logout; passing it under `--no-start` would start the app the
 * caller just said not to start.
 */
export function enableAutostart(plan, { activate = true, log = console.log } = {}) {
  mkdirSync(dirname(plan.path), { recursive: true });

  if (plan.kind === "startup-shortcut") {
    const icon = windowsIcon(plan);
    const script = [
      `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psq(plan.path)})`,
      `$s.TargetPath = ${psq(plan.target)}`,
      // Each path quoted inside the argument string, so a profile directory with
      // a space in it stays one argv entry.
      `$s.Arguments = ${psq(plan.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" "))}`,
      `$s.WorkingDirectory = ${psq(plan.workingDirectory)}`,
      `$s.Description = ${psq("Start Dispatch when you log in")}`,
      ...(icon ? [`$s.IconLocation = ${psq(`${icon},0`)}`] : []),
      `$s.Save()`,
    ].join("; ");
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: "inherit",
    });
    log(`autostart: ${plan.path}`);
    log("  Turn it off in Task Manager > Startup apps, or reinstall with --no-autostart.");
    return plan;
  }

  writeFileSync(plan.path, plan.contents, "utf8");

  if (plan.kind === "launch-agent") {
    const domain = `gui/${process.getuid?.() ?? ""}`;
    // bootout-then-bootstrap, not `load -w`: launchd caches a job's definition,
    // so re-running the installer over a changed plist would otherwise keep
    // launching the old one. Booting out a job that was never loaded fails, and
    // that is the ordinary first-install path — hence the swallow.
    quiet("launchctl", ["bootout", `${domain}/${plan.label}`]);
    const loaded = spawnSync("launchctl", ["bootstrap", domain, plan.path], { stdio: "inherit" });
    if (loaded.status !== 0) quiet("launchctl", ["load", "-w", plan.path]);
    log(`autostart: ${plan.path}`);
    log(`  Turn it off with: launchctl bootout ${domain}/${plan.label}`);
    return plan;
  }

  if (plan.kind === "systemd-user") {
    quiet("systemctl", ["--user", "daemon-reload"]);
    const enable = spawnSync(
      "systemctl",
      ["--user", "enable", ...(activate ? ["--now"] : []), plan.unit],
      { stdio: "inherit" },
    );
    if (enable.status !== 0) throw new Error(`systemctl --user enable ${plan.unit} failed`);
    log(`autostart: ${plan.path}`);
    log(
      "  This starts Dispatch when you LOG IN. For a headless box that should come\n" +
        "  up at boot instead, run once:  loginctl enable-linger $USER",
    );
    return plan;
  }

  chmodSync(plan.path, 0o755);
  log(`autostart: ${plan.path}`);
  log("  (no systemd --user here, so this only fires inside a desktop session)");
  return plan;
}

/**
 * Remove the entry. Idempotent: nothing registered is a success, not an error.
 *
 * The service-manager calls are made UNCONDITIONALLY, never gated on the file
 * still being there. What actually starts Dispatch on Linux is the symlink
 * `systemctl enable` drops in `default.target.wants/`, and on macOS the job
 * launchd has already loaded — deleting the unit or the plist by hand leaves
 * both behind, and that is exactly the state someone is in when they reach for
 * `--disable` a second time. `quiet()` swallows the "no such unit" that the
 * ordinary already-clean path produces.
 */
export function disableAutostart(plan, { log = console.log, runQuiet = quiet } = {}) {
  const existed = existsSync(plan.path);
  if (plan.kind === "launch-agent") {
    runQuiet("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}/${plan.label}`]);
  } else if (plan.kind === "systemd-user") {
    // `disable --now` and not just `disable`: leaving the unit active would let
    // its ExecStop stop Dispatch at the next logout, long after the user asked
    // for autostart to be gone.
    runQuiet("systemctl", ["--user", "disable", "--now", plan.unit]);
  }
  rmSync(plan.path, { force: true });
  if (plan.kind === "systemd-user") runQuiet("systemctl", ["--user", "daemon-reload"]);
  log(existed ? `autostart removed: ${plan.path}` : "autostart was not registered.");
  return existed;
}

/** A best-effort side call whose failure is not the caller's problem. */
function quiet(command, args) {
  try {
    spawnSync(command, args, { stdio: "ignore", windowsHide: true });
  } catch {
    // The enable/disable result is judged by the file, not by this.
  }
}

/**
 * The icon for the Startup shortcut, when the payload has one built. Cosmetic
 * only — Task Manager's Startup tab shows it beside the entry.
 */
function windowsIcon(plan) {
  const app = win32Path.resolve(plan.launcher, "..", "..", "..");
  const candidate = win32Path.join(app, "packages", "client", "dist", "icons", "favicon.ico");
  return existsSync(candidate) ? candidate : null;
}

// ---------------------------------------------------------------------- CLI

export function parseArgs(argv) {
  const out = { mode: "status", activate: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--enable") out.mode = "enable";
    else if (arg === "--disable") out.mode = "disable";
    else if (arg === "--status") out.mode = "status";
    else if (arg === "--no-activate") out.activate = false;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--target") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--target requires a value");
      out.target = value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(
      "Start Dispatch when you log in.\n\n" +
        "Usage: node tools/app/autostart.mjs [--enable|--disable|--status] [--target <root>]\n",
    );
    return 0;
  }
  const plan = currentPlan({ root: args.target });
  if (args.mode === "enable") {
    enableAutostart(plan, { activate: args.activate });
    return 0;
  }
  if (args.mode === "disable") {
    disableAutostart(plan);
    return 0;
  }
  if (!existsSync(plan.path)) {
    console.log(`autostart: not registered (a ${plan.kind} would live at ${plan.path})`);
    return 1;
  }
  console.log(`autostart: registered (${plan.kind})\n  ${plan.path}`);
  if (plan.contents && readFileSync(plan.path, "utf8") !== plan.contents) {
    console.log("  note: the entry on disk differs from what this build would write.");
  }
  return 0;
}

// Only when run directly. `resolve` on both sides so a `node tools/app/…` and a
// `node /abs/tools/app/…` invocation compare equal.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
