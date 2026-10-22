#!/usr/bin/env node
/**
 * Move an install from the pre-rename root to the new one:
 * `%LOCALAPPDATA%\claude-manager` → `%LOCALAPPDATA%\dispatch` (and the
 * XDG / macOS equivalents).
 *
 * ── Why a rename and then a rebuild, rather than a copy ─────────────────────
 * `data/` is gigabytes of chat transcripts, and copying it needs that much free
 * space on a disk that is often short of it. A same-volume rename moves the
 * whole root in one directory-entry update and costs nothing. What a rename
 * cannot carry is `app/node_modules`: pnpm's Windows junctions hold ABSOLUTE
 * targets, so after the move every one of them points into a directory that no
 * longer exists. The payload is therefore rebuilt in the new root by the same
 * machinery that built it — `install.mjs` for a release install, `publish.mjs`
 * for a checkout build — and the stale one is kept aside until that succeeds,
 * so a failed rebuild still leaves something to roll back to.
 *
 * NOT rewritten: paths inside chat transcripts and `state.db`. Those name the
 * repo checkouts the chats worked in, which are not moving.
 *
 * Usage:
 *   node tools/app/migrate-home.mjs [--dry-run] [--from <old root>] [--to <new root>]
 *                                   [--version <tag>] [--no-start]
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertAppStopped } from "./build-payload.mjs";
import { localDataDir } from "./paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

/** The pre-rename directory name. This tool is the one place it belongs. */
export const LEGACY_NAME = "claude-manager";
export const NEW_NAME = "dispatch";

/**
 * Regenerable directories the move deletes rather than carries: `backups/` and
 * `failed/` are old payloads (~350 MB each) and `staging/` is an upgrade's
 * scratch clone. Their node_modules junctions point into the OLD root too, so
 * after the rename they are not even usable as rollback targets.
 */
export const REGENERABLE = ["backups", "staging", "failed"];

/** The root-level JSON files whose fields may embed the old absolute root. */
export const STATE_FILES = ["current.json", "runtime.json", "upgrade.json", "update.json"];

/** Where the stale payload waits while the new one is built. */
const ASIDE = "app.pre-migrate";

export function parseArgs(argv) {
  const out = { dryRun: false, start: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // `pnpm app:migrate-home -- --dry-run` forwards the separator itself.
    if (a === "--") continue;
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--no-start") out.start = false;
    else if (a === "--from" || a === "--to" || a === "--version") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${a} requires a value`);
      out[a.slice(2)] = v;
    } else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/** The old and new roots. `DISPATCH_HOME` is deliberately ignored — it names ONE root. */
export function resolveRoots(args, env = process.env) {
  const local = localDataDir(env);
  return {
    from: resolve(args.from ?? join(local, LEGACY_NAME)),
    to: resolve(args.to ?? join(local, NEW_NAME)),
  };
}

/** Same path, compared the way the filesystem does (case-insensitively on Windows). */
function samePath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Replace a leading `from` root in every string inside `value`, returning the
 * new value and the dotted paths of the fields that changed. Prefix-only and
 * bounded by a separator, so `C:\x\claude-manager-old` is not mistaken for a
 * path under `C:\x\claude-manager`.
 */
export function rewriteRootPaths(value, from, to, path = "") {
  const changed = [];
  const fold = (s) => (process.platform === "win32" ? s.toLowerCase() : s);
  const walk = (v, at) => {
    if (typeof v === "string") {
      const head = v.slice(0, from.length);
      const next = v[from.length];
      if (fold(head) === fold(from) && (next === undefined || next === "\\" || next === "/")) {
        changed.push(at || "(root)");
        return to + v.slice(from.length);
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((item, i) => walk(item, `${at}[${i}]`));
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v).map(([k, item]) => [k, walk(item, at ? `${at}.${k}` : k)]),
      );
    }
    return v;
  };
  return { value: walk(value, path), changed };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * How the payload was installed, which decides how it gets rebuilt. A checkout
 * build has a `.git`; a release install has a `tag` in its stamp. Anything else
 * cannot be reproduced and the move is refused before anything changes.
 */
export function payloadKind(root, versionOverride) {
  const stamp = readJson(join(root, "current.json")) ?? {};
  if (existsSync(join(root, "app", ".git"))) {
    if (!stamp.sha) return { kind: "unknown", why: "app/ is a checkout but current.json has no sha" };
    return { kind: "checkout", sha: stamp.sha };
  }
  const tag = versionOverride ?? stamp.tag;
  if (tag) {
    const repo = /github\.com\/([^/]+\/[^/]+)\/releases/.exec(stamp.source ?? "")?.[1];
    return { kind: "release", tag, repo, autostart: stamp.autostart };
  }
  return { kind: "unknown", why: "current.json names neither a release tag nor a checkout sha" };
}

/** Bytes on disk under `dir`, never following links — junctions are not ours to count. */
export function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          total += lstatSync(p).size;
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  }
  return total;
}

export function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * Which path is stopping the rename. Windows refuses to rename a directory
 * while any handle (or any process's working directory) is open beneath it, and
 * says only EPERM/EBUSY — not which file. So probe: rename each entry to a
 * sibling and straight back, descending into the first one that refuses. Every
 * probe that succeeds is undone immediately, so nothing is left changed.
 */
export function findLockedPath(dir, depth = 0) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    const probe = `${p}.lock-probe-${process.pid}`;
    try {
      renameSync(p, probe);
    } catch {
      if (e.isDirectory() && depth < 12) return findLockedPath(p, depth + 1) ?? p;
      return p;
    }
    // If this fails we have genuinely moved something, and the error must say so.
    renameSync(probe, p);
  }
  return null;
}

function narrate(log, n, total, title) {
  log(`\n[${n}/${total}] ${title}`);
}

/**
 * The rebuild command for this payload. Run from THIS checkout's tooling, never
 * the payload's: the payload is the thing being replaced.
 */
export function rebuildCommand(kind, to, { start }) {
  if (kind.kind === "release") {
    return [
      process.execPath,
      [
        join(repoRoot, "tools", "install.mjs"),
        "--version",
        kind.tag,
        ...(kind.repo ? ["--repo", kind.repo] : []),
        "--target",
        to,
        "--no-open",
        ...(start ? [] : ["--no-start"]),
      ],
    ];
  }
  return [
    process.execPath,
    [join(repoRoot, "tools", "app", "publish.mjs"), "--ref", kind.sha, "--target", to],
  ];
}

/** Shortcut fields that mark a `.lnk` as belonging to the old install. */
export function isStaleShortcut({ name, target = "", args = "", workdir = "" }, from) {
  if (name.toLowerCase() === `${LEGACY_NAME}.lnk`) return true;
  const text = `${target} ${args} ${workdir}`.toLowerCase();
  // The old Electron shell, whatever root it lived under.
  if (text.includes(`${LEGACY_NAME}.exe`)) return true;
  return text.includes(from.toLowerCase());
}

/** Every .lnk in Startup and Start Menu\Programs, with what it runs. Windows only. */
function listShortcuts() {
  const ps = [
    "$sh = New-Object -ComObject WScript.Shell",
    "$dirs = @([Environment]::GetFolderPath('Startup'), [Environment]::GetFolderPath('Programs'))",
    "$out = foreach ($d in $dirs) { if ($d -and (Test-Path $d)) { Get-ChildItem -LiteralPath $d -Filter *.lnk -Recurse | ForEach-Object { $l = $sh.CreateShortcut($_.FullName); [pscustomobject]@{ path = $_.FullName; name = $_.Name; target = $l.TargetPath; args = $l.Arguments; workdir = $l.WorkingDirectory } } } }",
    "ConvertTo-Json -InputObject @($out) -Compress",
  ].join("; ");
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`could not list shortcuts: ${r.stderr.trim()}`);
  const text = r.stdout.trim();
  return text ? JSON.parse(text) : [];
}

/**
 * The child's environment, minus the in-app updater's `DISPATCH_INSTALL_*`.
 * Those are exported by a self-update and inherited by every agent session the
 * updated app starts, so running this from inside Dispatch would otherwise hand
 * install.mjs a `PREFER_HEAD` and swap the named tag for the channel head.
 */
function childEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("DISPATCH_INSTALL_")),
  );
}

function runNode(cmd, cmdArgs, log) {
  log(`  $ ${[cmd, ...cmdArgs].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`);
  const r = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    cwd: repoRoot,
    env: childEnv(),
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`${basename(cmdArgs[0])} exited ${r.status ?? r.signal ?? r.error?.message}`);
  }
}

function findPython() {
  const candidates =
    process.platform === "win32"
      ? [["py", ["-3"]], ["python", []], ["python3", []]]
      : [["python3", []], ["python", []]];
  for (const [cmd, prefix] of candidates) {
    const r = spawnSync(cmd, [...prefix, "--version"], { stdio: "ignore", windowsHide: true });
    if (r.status === 0) return [cmd, prefix];
  }
  throw new Error("Python 3.10+ was not found on PATH");
}

/**
 * Plan and (unless `dryRun`) perform the move. Returns the process exit code.
 * `env` and `log` are injectable so the test can drive it against temp dirs.
 */
export async function main(argv = process.argv.slice(2), { env = process.env, log = console.log } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    log(
      "Usage: node tools/app/migrate-home.mjs [--dry-run] [--from <old root>] [--to <new root>]\n" +
        "                                       [--version <tag>] [--no-start]",
    );
    return 0;
  }
  const { from, to } = resolveRoots(args, env);
  const dry = args.dryRun;
  const say = (msg) => log(dry ? `  (dry-run) ${msg}` : `  ${msg}`);

  log(`Moving the Dispatch install root${dry ? " — DRY RUN, nothing will be changed" : ""}`);
  log(`  from: ${from}`);
  log(`  to  : ${to}`);

  // ── Preconditions. All checked before anything is touched. ────────────────
  const refuse = (msg) => {
    log(`\nREFUSED: ${msg}\nNothing was changed.`);
    return 1;
  };
  if (samePath(from, to)) return refuse("--from and --to are the same directory.");
  if (isInside(to, from) || isInside(from, to)) return refuse("one root is inside the other.");
  if (!existsSync(from) || !statSync(from).isDirectory()) {
    return refuse(`there is no install at ${from} to move.`);
  }
  let replaceEmptyTarget = false;
  if (existsSync(to)) {
    if (!statSync(to).isDirectory() || readdirSync(to).length > 0) {
      return refuse(
        `${to} already exists and is not empty. Move it out of the way (or pass --to)\n` +
          `  rather than have this merge two installs.`,
      );
    }
    replaceEmptyTarget = true;
  }
  if (!existsSync(dirname(to))) return refuse(`${dirname(to)} does not exist.`);
  if (statSync(from).dev !== statSync(dirname(to)).dev) {
    return refuse(
      `${from} and ${dirname(to)} are on different volumes, so this would be a copy of\n` +
        `  the whole data dir rather than a rename. Pass a --to on the same volume.`,
    );
  }
  if (isInside(process.cwd(), from)) {
    return refuse(`this shell's working directory is inside ${from}, which locks it. cd out first.`);
  }
  try {
    await assertAppStopped({ runtime: join(from, "runtime.json") });
  } catch (err) {
    return refuse(err.message);
  }
  const kind = payloadKind(from, args.version);
  if (kind.kind === "unknown") {
    return refuse(`cannot tell how ${join(from, "app")} was installed (${kind.why}), so it could not be rebuilt.`);
  }

  const [rebuildCmd, rebuildArgs] = rebuildCommand(kind, to, args);
  const rollbackRename =
    process.platform === "win32"
      ? `Rename-Item -LiteralPath "${to}" -NewName "${basename(from)}"`
      : `mv "${to}" "${from}"`;
  const TOTAL = 6;

  // ── 1. Rename ──────────────────────────────────────────────────────────────
  narrate(log, 1, TOTAL, "Rename the root (same volume: no data is copied)");
  say(`rename ${from}`);
  say(`    -> ${to}`);
  if (!dry) {
    try {
      if (replaceEmptyTarget) rmdirSync(to);
      renameSync(from, to);
    } catch (err) {
      if (replaceEmptyTarget && !existsSync(to)) {
        try {
          // Put back the empty directory we removed, so "nothing changed" holds.
          mkdirSync(to);
        } catch {
          /* best effort */
        }
      }
      const locked = err.code === "EXDEV" ? null : findLockedPath(from);
      log(`\nFAILED: could not rename the root (${err.code ?? err.message}).`);
      if (locked) {
        log(`  Locked: ${locked}`);
        log(`  Something still has it open — a terminal cd'd there, an editor, an`);
        log(`  antivirus scan, or a leftover node/python process. Close it and re-run.`);
      }
      log(`Nothing was changed.`);
      return 1;
    }
  }

  // From here on, a failure leaves the root at `to`, and the way back is to rename it.
  const fail = (step, err, extra = "") => {
    log(`\nFAILED at step ${step}: ${err.message}`);
    if (extra) log(extra);
    log(`\nTo roll back to the old location:`);
    log(`  ${rollbackRename}`);
    return 1;
  };

  // ── 2. State files ─────────────────────────────────────────────────────────
  narrate(log, 2, TOTAL, "Rewrite root paths in the state files");
  try {
    for (const name of STATE_FILES) {
      const file = join(dry ? from : to, name);
      if (!existsSync(file)) continue;
      const json = readJson(file);
      if (json === null) {
        say(`${name}: unreadable, left alone`);
        continue;
      }
      const { value, changed } = rewriteRootPaths(json, from, to);
      if (!changed.length) {
        say(`${name}: nothing to rewrite`);
        continue;
      }
      say(`${name}: rewrite ${changed.join(", ")}`);
      if (!dry) writeFileSync(join(to, name), `${JSON.stringify(value, null, 2)}\n`);
    }
  } catch (err) {
    return fail(2, err);
  }

  // ── 3. Rebuild the payload ─────────────────────────────────────────────────
  narrate(
    log,
    3,
    TOTAL,
    kind.kind === "release"
      ? `Reinstall release ${kind.tag} into the new root (its node_modules junctions point at the old one)`
      : `Rebuild checkout sha ${kind.sha.slice(0, 12)} into the new root (its node_modules junctions point at the old one)`,
  );
  const app = join(to, "app");
  const aside = join(to, ASIDE);
  say(`move app/ aside to ${ASIDE}/ (kept until the rebuild succeeds)`);
  if (dry) log(`  (dry-run) $ ${[rebuildCmd, ...rebuildArgs].join(" ")}`);
  else {
    let movedAside = false;
    try {
      if (existsSync(app)) {
        renameSync(app, aside);
        movedAside = true;
      }
      runNode(rebuildCmd, rebuildArgs, log);
    } catch (err) {
      let restored = "";
      if (movedAside) {
        try {
          if (existsSync(app)) rmSync(app, { recursive: true, force: true });
          renameSync(aside, app);
          restored = `\nThe original app/ was put back, so the rename below restores a working install.`;
        } catch (restoreErr) {
          restored =
            `\nCOULD NOT put the original app/ back (${restoreErr.message}).\n` +
            `  Before renaming back: delete ${app} and rename ${aside} to app.`;
        }
      }
      return fail(3, err, restored);
    }
  }

  // ── 4. Regenerable directories ─────────────────────────────────────────────
  narrate(log, 4, TOTAL, "Delete regenerable directories (old payloads and scratch builds)");
  let freed = 0;
  for (const name of [ASIDE, ...REGENERABLE]) {
    // In a dry run the payload has not moved aside yet; size the live `app/`.
    const sized = join(dry ? from : to, dry && name === ASIDE ? "app" : name);
    if (!existsSync(sized)) continue;
    const bytes = dirSize(sized);
    freed += bytes;
    say(`delete ${join(to, name)}  (${formatBytes(bytes)})`);
    if (!dry) {
      try {
        rmSync(join(to, name), { recursive: true, force: true });
      } catch (err) {
        log(`  warning: could not delete ${name}/ (${err.message}) — remove it by hand.`);
      }
    }
  }
  say(`freed ~${formatBytes(freed)}`);

  // ── 5. Shortcuts and autostart ─────────────────────────────────────────────
  narrate(log, 5, TOTAL, "Recreate shortcuts and the login entry; remove the stale ones");
  try {
    if (kind.kind === "checkout") {
      // A release reinstall already recreated both (install.mjs does it for
      // every install); a checkout build is published without either.
      const shortcut = [process.execPath, [join(repoRoot, "tools", "app", "create-shortcut.mjs"), "--target", to]];
      const autostart = [
        process.execPath,
        [join(repoRoot, "tools", "app", "autostart.mjs"), "--enable", "--target", to, ...(args.start ? [] : ["--no-activate"])],
      ];
      for (const [cmd, cmdArgs] of [shortcut, autostart]) {
        if (dry) log(`  (dry-run) $ ${[cmd, ...cmdArgs].join(" ")}`);
        else runNode(cmd, cmdArgs, log);
      }
    } else {
      say("Start-menu shortcut and login entry: recreated by install.mjs in step 3");
    }
    if (process.platform === "win32") {
      const stale = listShortcuts().filter((s) => isStaleShortcut(s, from));
      if (!stale.length) say("no stale shortcuts found");
      for (const s of stale) {
        say(`remove ${s.path}  (runs ${s.target} ${s.args})`.trimEnd());
        if (!dry) rmSync(s.path, { force: true });
      }
    }
  } catch (err) {
    // Past the point of rolling back: the new payload is built and the old one
    // deleted. A missing shortcut is fixed by re-running the shortcut tools.
    log(`\nwarning: ${err.message}`);
    log(`  The install itself has moved. Recreate the launcher with:`);
    log(`    pnpm app:shortcut -- --target "${to}"`);
    log(`    pnpm app:autostart -- --enable --target "${to}"`);
  }

  // ── 6. Start ───────────────────────────────────────────────────────────────
  narrate(log, 6, TOTAL, "Start Dispatch from the new root");
  if (!args.start) say("skipped (--no-start)");
  else if (kind.kind === "release") say("started by install.mjs in step 3");
  else {
    const launcher = join(to, "app", "tools", "app", "launch.py");
    if (dry) log(`  (dry-run) $ python ${launcher} --no-window --target ${to}`);
    else {
      try {
        const [py, prefix] = findPython();
        const r = spawnSync(py, [...prefix, launcher, "--no-window", "--target", to], { stdio: "inherit" });
        if (r.status !== 0) throw new Error(`launch.py exited ${r.status}`);
      } catch (err) {
        log(`  warning: could not start it (${err.message}). Start it from the Start menu, or: pnpm app`);
      }
    }
  }

  log(
    dry
      ? `\nDry run complete. Nothing was changed.`
      : `\nDone. Dispatch now lives in ${to}.`,
  );
  return 0;
}

// Compared as file URLs — `import.meta.url` is `file:///C:/...` on Windows.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`\nmigrate-home failed: ${err.message}`);
      process.exitCode = 1;
    },
  );
}
