#!/usr/bin/env node
/**
 * Install Dispatch the way a user does, on THIS machine, and prove the result
 * works — the driver behind `.github/workflows/install-smoke.yml`.
 *
 * WHY THIS EXISTS. Every other check in the repo runs against a source checkout
 * with a warm `node_modules`. Nothing ran `install.sh` / `install.ps1`, nothing
 * ran `tools/install.mjs` past `parseArgs`, nothing started `launch.py`, and
 * nothing booted the server from a RELEASE PAYLOAD — on any OS, and macOS had
 * no CI at all. The failure that motivated it: `curl … | sh` on macOS printed
 * "Downloading the Dispatch release installer…" and exited 0 having installed
 * nothing, because `$TMPDIR` is a symlink there and the installer's entry-point
 * check never matched (see `isEntryPoint()` in `tools/install.mjs`). A unit
 * test now simulates that; only a real runner catches the next one.
 *
 * WHAT IT DOES, in order — the user's sequence, not a convenient one:
 *
 *   1. `--dry-run` of the checkout's installer to learn the channel head.
 *   2. A FIRST install through the bootstrap script (`install.sh`/`.ps1`), of
 *      the release BEFORE the head when the channel has one. That exercises the
 *      published installer and gives step 4 something real to update from.
 *   3. Health, the fresh-install wizard state, and a persistence marker.
 *   4. An UPDATE to the channel head with the checkout's `install.mjs` — the
 *      stop/swap/backup/relink path, on a payload that is genuinely running.
 *   5. Payload layout, launchers, autostart entry.
 *   6. The setup wizard, over the same REST calls the SPA makes.
 *   7. Core features against the installed build: a chat round-trip over the
 *      websocket (`DISPATCH_FAKE_SDK=1`, so no credentials and no network),
 *      models, git, worktrees, terminals, the update surface, the CLI.
 *   8. Stop / start through `launch.py`, and everything is still there.
 *   9. A same-version reinstall: idempotent, prunes to one backup, honours
 *      `--no-autostart`.
 *  10. Stop, and prove it is gone.
 *
 * Every check is recorded rather than thrown, so one red row does not hide the
 * ten behind it; only a failed INSTALL aborts, because nothing after it means
 * anything. The report lands in `$GITHUB_STEP_SUMMARY` when that is set, and in
 * `--report <file>` as JSON for the workflow's issue-filing job.
 *
 * Dependency-free on purpose, like the installer it drives: this runs before
 * the checkout has a `node_modules`.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const IS_WIN = platform() === "win32";
const DEFAULT_REPO = "mdennis281/dispatch";

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const out = {
    root: join(tmpdir(), "dispatch-smoke-root"),
    channel: "unstable",
    previous: "auto",
    repo: process.env.DISPATCH_INSTALL_REPO || DEFAULT_REPO,
    report: undefined,
    /**
     * The workflow installs the Claude Code and Codex CLIs with npm first, so
     * the runtime probe has a real "installed" answer to find. Not asserted on
     * Windows: npm leaves `.cmd` shims there, which neither runtime resolver
     * spawns on purpose (see `fromPath` in services/runtime.ts), so the
     * bundled binary correctly stays in charge and Codex correctly stays absent.
     */
    expectInstalledClis: process.env.SMOKE_EXPECT_INSTALLED_CLIS === "1",
    /**
     * Skip the Start-menu / ~/.local/bin / login-entry work. For a developer
     * running this on a machine with a REAL install: those entries are
     * per-user, not per-root, and the smoke would overwrite them.
     */
    noLaunchers: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    if (arg === "--root") out.root = resolve(value());
    else if (arg === "--channel") out.channel = value();
    else if (arg === "--previous") out.previous = value();
    else if (arg === "--repo") out.repo = value();
    else if (arg === "--report") out.report = resolve(value());
    else if (arg === "--expect-installed-clis") out.expectInstalledClis = true;
    else if (arg === "--no-launchers") out.noLaunchers = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (out.channel !== "stable" && out.channel !== "unstable") {
    throw new Error(`--channel must be stable or unstable (received ${out.channel})`);
  }
  return out;
}

/* --------------------------------------------------------------- results */

const results = [];
const notes = [];
class Abort extends Error {}

function record(name, ok, detail, ms) {
  results.push({ name, ok, detail: detail ?? "", ms });
  const mark = ok === "skip" ? "-" : ok ? "✓" : "✗";
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ""}${ms !== undefined ? ` (${ms}ms)` : ""}`);
}

/** Run a check; a throw is a failed row, never a crashed job. */
async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    record(name, true, typeof detail === "string" ? detail : "", Date.now() - started);
    return true;
  } catch (error) {
    if (error instanceof Abort) throw error;
    record(name, false, error?.message ?? String(error), Date.now() - started);
    return false;
  }
}

/** A check whose failure makes everything after it meaningless. */
async function hard(name, fn) {
  if (!(await check(name, fn))) throw new Abort(`aborting after: ${name}`);
}

function skip(name, why) {
  record(name, "skip", why);
}

function note(text) {
  notes.push(text);
  console.log(`  note: ${text}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/* ------------------------------------------------------------- processes */

/**
 * Run a child to completion, streaming its output AND keeping it. Output is
 * what the summary quotes when something fails, and what the installer's own
 * progress lines are read from ("stopping the current Dispatch instance…").
 */
function run(command, args, { cwd, env, allowFail = false, timeoutMs = 20 * 60_000, shell = false } = {}) {
  return new Promise((resolveRun, reject) => {
    console.log(`  $ ${command} ${args.join(" ")}`);
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell,
    });
    let out = "";
    const onData = (chunk) => {
      const text = chunk.toString();
      out += text;
      process.stdout.write(text);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    // `exit`, not `close`. The installer starts a DETACHED supervisor, and a
    // release of launch.py that predates its stdio being pointed at /dev/null
    // leaves that supervisor — and the node under it — holding these pipes for
    // as long as the server runs. `close` waits for the pipes; it never came,
    // and the first run of this smoke sat on a finished install for the whole
    // job timeout. Give late output a moment to land, then let the pipes go.
    child.on("exit", (code) => {
      clearTimeout(timer);
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        if (code !== 0 && !allowFail) {
          reject(new Error(`${command} exited ${code}\n${out.slice(-2000)}`));
          return;
        }
        resolveRun({ code, out });
      }, 250);
    });
  });
}

function runQuiet(command, args, options = {}) {
  const r = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, error: r.error };
}

/** Same candidates, same floor, as `findPython()` in the installer. */
function findPython() {
  const candidates = IS_WIN
    ? [["py", ["-3"]], ["python", []], ["python3", []]]
    : [["python3", []], ["python", []]];
  for (const [command, prefix] of candidates) {
    const r = runQuiet(command, [...prefix, "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"]);
    if (!r.error && r.code === 0) return { command, prefix };
  }
  throw new Error("Python 3.10+ not found on PATH");
}

/* ------------------------------------------------------------------- fs */

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function backupDirs(root) {
  const dir = join(root, "backups");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^(?:app|failed)-.+-\d{10,}$/.test(e.name))
    .map((e) => e.name);
}

/* ----------------------------------------------------------------- http */

let base = "";

async function api(method, path, body, { expect } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (expect !== undefined && res.status !== expect) {
    throw new Error(`${method} ${path} → ${res.status} (expected ${expect}): ${text.slice(0, 300)}`);
  }
  return { status: res.status, json, text };
}

const get = (path, opts) => api("GET", path, undefined, opts);
const post = (path, body, opts) => api("POST", path, body ?? {}, opts);
const put = (path, body, opts) => api("PUT", path, body, opts);

async function waitForHealth(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "no response yet";
  while (Date.now() < deadline) {
    try {
      const { status, json } = await get("/api/health");
      if (status === 200 && json?.ok === true) return json;
      last = `${status}: ${JSON.stringify(json)?.slice(0, 300)}`;
    } catch (error) {
      last = error.message;
    }
    await delay(500);
  }
  throw new Error(`/api/health never went green within ${timeoutMs}ms — last: ${last}`);
}

async function portClosed(port, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    } catch {
      return true;
    }
    await delay(500);
  }
  return false;
}

/* ------------------------------------------------------------ releases */

function githubHeaders() {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "dispatch-install-smoke" };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Build stamps (`vyyyy.mm.dd.sssss`) order lexically; anything else is skipped. */
const STAMP = /^v\d{4}\.\d{2}\.\d{2}\.\d{5}$/;

/**
 * The newest release on `channel` that is OLDER than `head` — what the first
 * install uses so the second one is a real update. `null` when the channel has
 * nothing older (a brand-new stable channel), and the update phase is skipped.
 */
async function previousRelease(repo, channel, head) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=50`, { headers: githubHeaders() });
  if (!res.ok) throw new Error(`GitHub releases list failed: ${res.status}`);
  const list = await res.json();
  const eligible = list
    .filter((r) => !r.draft && STAMP.test(r.tag_name) && (channel === "unstable" || !r.prerelease))
    .filter((r) => r.assets?.some((a) => a.name === `dispatch-${r.tag_name}.tar.gz`))
    .filter((r) => r.assets?.some((a) => a.name === "install.mjs"))
    .map((r) => r.tag_name)
    .filter((tag) => tag < head)
    .sort()
    .reverse();
  return eligible[0] ?? null;
}

/* ----------------------------------------------------------------- main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { root, channel } = args;
  const installer = join(repoRoot, "tools", "install.mjs");
  const python = findPython();
  const launcher = () => join(root, "app", "tools", "app", "launch.py");
  const launch = (extra, opts = {}) =>
    run(python.command, [...python.prefix, launcher(), ...extra, "--target", root], opts);

  // The env every install and every launched server inherits. `launch.py`
  // passes its whole environment to node, which is how the FAKE SDK reaches the
  // installed payload: the chat round-trip below then proves the whole path
  // from websocket to store without a credential or a network call.
  const env = {
    DISPATCH_FAKE_SDK: "1",
    DISPATCH_INSTALL_NO_OPEN: "1",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    ...(process.env.GITHUB_TOKEN ? { GITHUB_TOKEN: process.env.GITHUB_TOKEN } : {}),
    ...(process.env.GH_TOKEN ? { GH_TOKEN: process.env.GH_TOKEN } : {}),
  };
  Object.assign(process.env, env);
  if (IS_WIN) {
    // A Windows user runs `install.ps1` from PowerShell, where the OS's own
    // `System32\tar.exe` is first on PATH. This job runs under `shell: bash`,
    // where Git for Windows' GNU tar is first — and that one reads `D:\a\…`
    // as a remote host. The checkout's installer copes (see `tar()` in
    // tools/install.mjs); the PUBLISHED installer the bootstrap step downloads
    // may predate that, so give every child the PowerShell user's PATH order.
    const system32 = join(process.env.SystemRoot || "C:\\Windows", "System32");
    process.env.PATH = `${system32};${process.env.PATH ?? ""}`;
  }

  console.log(`smoke: ${platform()}/${process.arch} node ${process.version}, channel=${channel}, root=${root}`);
  if (existsSync(root)) {
    // A previous run's leftover would turn the "fresh install" phase into an update.
    rmSync(root, { recursive: true, force: true });
  }

  /* ---- 1. dry run: the channel head, from the checkout's installer ---- */

  let head = "";
  await hard("installer --dry-run resolves the channel head", async () => {
    const { out } = await run(process.execPath, [installer, "--dry-run", "--channel", channel, "--target", root, "--repo", args.repo], { env });
    head = /^release: (v\S+)/m.exec(out)?.[1] ?? "";
    assert(head, "no `release: v…` line in the dry-run output");
    assert(/verified: sha256 [0-9a-f]{64}/.test(out), "the dry run did not report a verified checksum");
    assert(/dry run complete/.test(out), "the dry run did not report completion");
    assert(!existsSync(join(root, "app")), "a dry run must not create the install");
    return head;
  });
  const headVersion = head.replace(/^v/, "");

  /* ---- 2. first install, through the bootstrap script ---- */

  let previous = null;
  if (args.previous === "none") {
    note("update phase disabled with --previous none");
  } else if (args.previous === "auto") {
    try {
      previous = await previousRelease(args.repo, channel, head);
    } catch (error) {
      note(`could not list releases to pick an older one (${error.message}); the first install will be the head`);
    }
    if (!previous) note(`no release older than ${head} on the ${channel} channel — the update phase is skipped`);
  } else {
    previous = args.previous.startsWith("v") ? args.previous : `v${args.previous}`;
  }
  const firstTag = previous ?? head;

  const launcherArgs = args.noLaunchers ? ["--no-shortcut", "--no-autostart"] : [];
  const bootstrapArgs = [
    ...(previous ? ["--version", previous] : ["--channel", channel]),
    "--target", root,
    "--no-open",
    ...launcherArgs,
    ...(args.repo !== DEFAULT_REPO ? ["--repo", args.repo] : []),
  ];
  let firstOut = "";
  await hard(`bootstrap script installs ${firstTag} (${IS_WIN ? "install.ps1" : "install.sh"})`, async () => {
    const r = IS_WIN
      ? await run("pwsh", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(repoRoot, "install.ps1"), ...bootstrapArgs], { env })
      : await run("sh", [join(repoRoot, "install.sh"), ...bootstrapArgs], { env });
    firstOut = r.out;
    assert(/is installed\./.test(r.out), "the installer did not print its `is installed.` summary");
  });

  await check("current.json describes the first install", () => {
    const stamp = readJson(join(root, "current.json"));
    assert(stamp.tag === firstTag, `tag ${stamp.tag} ≠ ${firstTag}`);
    assert(stamp.version === firstTag.replace(/^v/, ""), `version ${stamp.version}`);
    assert(/^[0-9a-f]{40}$/.test(stamp.sha ?? ""), `sha ${stamp.sha}`);
    assert(stamp.previous === null, `previous should be null on a first install, got ${stamp.previous}`);
    assert(typeof stamp.autostart === "boolean", "autostart not recorded");
    return `${stamp.tag} sha ${stamp.sha.slice(0, 8)} autostart=${stamp.autostart}`;
  });

  let port = 0;
  let firstPid = 0;
  await hard("launch.py wrote runtime.json and the port answers", async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !existsSync(join(root, "runtime.json"))) await delay(500);
    const rt = readJson(join(root, "runtime.json"));
    assert(Number.isInteger(rt.port), "runtime.json has no port");
    port = rt.port;
    base = `http://127.0.0.1:${port}`;
    const health = await waitForHealth();
    firstPid = health.pid;
    return `port ${port}, pid ${health.pid}, version ${health.version ?? "(none)"}`;
  });

  await check("/api/health is ready, not merely alive", async () => {
    const h = (await get("/api/health", { expect: 200 })).json;
    assert(h.status === "ok" && h.spa === true && h.store === true, `health: ${JSON.stringify(h)}`);
    assert(h.problems.length === 0, `problems: ${h.problems.join("; ")}`);
    assert(h.version === firstTag.replace(/^v/, ""), `health.version ${h.version} ≠ ${firstTag}`);
    assert(resolve(h.dataDir).startsWith(resolve(root)), `dataDir ${h.dataDir} is outside the install root`);
    return `version ${h.version}`;
  });

  await check("launch.py --status sees the instance", async () => {
    const { out } = await launch(["--status"], { env });
    assert(/running at http/.test(out), out);
  });

  // The marker: written now, read back after the update. `firstRunDismissed`
  // is the wizard's own first answer, so it lands in the same config file the
  // update must leave alone.
  await check("a setting written before the update (persistence marker)", async () => {
    await post("/api/auth/first-run/dismiss", {}, { expect: 200 });
    const s = (await get("/api/auth/status", { expect: 200 })).json;
    assert(s.firstRunDismissed === true, JSON.stringify(s));
  });

  /* ---- 3. update to the head with the checkout's installer ---- */

  const installerArgs = ["--channel", channel, "--target", root, "--no-open", ...launcherArgs, "--repo", args.repo];
  if (previous) {
    let updateOut = "";
    await hard(`tools/install.mjs updates ${previous} → ${head}`, async () => {
      const r = await run(process.execPath, [installer, ...installerArgs], { env });
      updateOut = r.out;
      assert(/stopping the current Dispatch instance/.test(r.out), "the installer did not stop the running instance first");
      assert(/is installed\./.test(r.out), "no `is installed.` summary");
    });
    await check("the update kept one rollback payload and stamped it", () => {
      const stamp = readJson(join(root, "current.json"));
      assert(stamp.tag === head, `tag ${stamp.tag} ≠ ${head}`);
      assert(stamp.previous && existsSync(stamp.previous), `previous ${stamp.previous} does not exist`);
      const backups = backupDirs(root);
      assert(backups.length === 1, `expected one backup, found ${backups.length}: ${backups.join(", ")}`);
      return stamp.previous;
    });
    await hard("the updated build came up on the same root", async () => {
      const rt = readJson(join(root, "runtime.json"));
      port = rt.port;
      base = `http://127.0.0.1:${port}`;
      const h = await waitForHealth();
      assert(h.version === headVersion, `health.version ${h.version} ≠ ${headVersion}`);
      assert(h.pid !== firstPid, `pid ${h.pid} is the OLD process — the swap left the previous server answering`);
      return `pid ${firstPid} → ${h.pid}`;
    });
    await check("config survived the update (marker still set)", async () => {
      const s = (await get("/api/auth/status", { expect: 200 })).json;
      assert(s.firstRunDismissed === true, JSON.stringify(s));
    });
    await check("no warnings from the update", () => {
      const warnings = updateOut.split(/\r?\n/).filter((l) => /^warning:/.test(l));
      assert(warnings.length === 0, warnings.join(" | "));
    });
  } else {
    skip("update from an older release", "no older release on this channel");
  }

  await check("no warnings from the first install", () => {
    const warnings = firstOut.split(/\r?\n/).filter((l) => /^warning:/.test(l));
    assert(warnings.length === 0, warnings.join(" | "));
  });

  /* ---- 4. payload layout, launchers, autostart ---- */

  const app = join(root, "app");
  await check("payload carries everything the launcher and installer run", () => {
    const required = [
      "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "release-manifest.json",
      "packages/server/dist/index.js", "packages/client/dist/index.html", "packages/client/dist/manifest.webmanifest",
      "packages/shared/dist/index.js", "packages/cli/dist/index.js",
      "packages/server/skills", "packages/server/personas",
      "tools/app/launch.py", "tools/app/autostart.mjs", "tools/app/paths.mjs", "tools/app/create-shortcut.mjs",
      "tools/install.mjs", "install.sh", "install.ps1",
    ];
    const missing = required.filter((p) => !existsSync(join(app, p)));
    assert(missing.length === 0, `missing: ${missing.join(", ")}`);
    if (!existsSync(join(app, "packages/server/instructions"))) {
      note("payload has no packages/server/instructions — a release built before it was added to tools/release/package.mjs");
    }
  });

  await check("native dependencies resolved for this OS/arch", () => {
    const pnpmDir = join(app, "node_modules", ".pnpm");
    const entries = existsSync(pnpmDir) ? readdirSync(pnpmDir) : [];
    const sdk = entries.find((e) => e.startsWith(`@anthropic-ai+claude-agent-sdk-${platform()}-${process.arch}`));
    assert(sdk, `no @anthropic-ai/claude-agent-sdk-${platform()}-${process.arch} under node_modules/.pnpm`);
    const argon = runQuiet(process.execPath, ["-e", "require('@node-rs/argon2')"], { cwd: join(app, "packages", "server") });
    assert(argon.code === 0, `@node-rs/argon2 failed to load: ${argon.out.slice(0, 300)}`);
    return sdk;
  });

  if (args.noLaunchers) {
    skip("launcher and autostart entries", "--no-launchers");
  } else if (IS_WIN) {
    await check("Start-menu shortcut exists and is pinned to this root", () => {
      const lnk = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "Microsoft/Windows/Start Menu/Programs/Dispatch.lnk");
      assert(existsSync(lnk), `${lnk} missing`);
      const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}'); Write-Output $s.TargetPath; Write-Output $s.Arguments`;
      const r = runQuiet("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps]);
      assert(r.code === 0, r.out);
      const [target, arguments_] = r.out.trim().split(/\r?\n/);
      assert(/python/i.test(target ?? ""), `shortcut target ${target}`);
      assert(/launch\.py/.test(arguments_ ?? ""), `shortcut arguments ${arguments_}`);
      if (!/--target/.test(arguments_ ?? "")) note("Start-menu shortcut does not pass --target (installer predates the fix)");
      return arguments_;
    });
  } else {
    await check("~/.local/bin/dispatch launcher exists and reports status", async () => {
      const shim = join(homedir(), ".local", "bin", "dispatch");
      assert(existsSync(shim), `${shim} missing`);
      assert(statSync(shim).mode & 0o111, "shim is not executable");
      const body = readFileSync(shim, "utf8");
      const pinned = /--target/.test(body);
      if (!pinned) note("launcher shim does not pass --target (installer predates the fix)");
      const r = runQuiet(shim, pinned ? ["--status"] : ["--status", "--target", root]);
      assert(r.code === 0 && /running at/.test(r.out), r.out);
      return pinned ? "pinned to root" : "unpinned";
    });
  }

  const autostart = (mode) => runQuiet(process.execPath, [join(app, "tools/app/autostart.mjs"), mode, "--target", root]);
  if (!args.noLaunchers) await check("autostart entry registered by the install, then removed", () => {
    const status = autostart("--status");
    assert(status.code === 0, `--status after install: ${status.out.trim()}`);
    const kind = /registered \((.+?)\)/.exec(status.out)?.[1];
    const off = autostart("--disable");
    assert(off.code === 0, `--disable: ${off.out.trim()}`);
    const after = autostart("--status");
    assert(after.code === 1, `--status after disable should be 1: ${after.out.trim()}`);
    return kind ?? status.out.trim();
  });

  /* ---- 5. the setup wizard, over REST ---- */

  await check("a fresh install owes the wizard", async () => {
    const s = (await get("/api/setup", { expect: 200 })).json;
    assert(s.completed === false, JSON.stringify(s));
  });
  await check("seeded modes and agents, and no project", async () => {
    const modes = (await get("/api/modes", { expect: 200 })).json;
    const agents = (await get("/api/agents", { expect: 200 })).json;
    const projects = (await get("/api/projects", { expect: 200 })).json;
    assert(Array.isArray(modes) && modes.length >= 3, `modes: ${modes?.length}`);
    assert(Array.isArray(agents) && agents.length >= 1, `agents: ${agents?.length}`);
    assert(Array.isArray(projects) && projects.length === 0, `projects: ${projects?.length}`);
    return `${modes.length} modes, ${agents.length} agents`;
  });
  await check("GitHub CLI probe finds gh (and git)", async () => {
    const s = (await get("/api/setup/github", { expect: 200 })).json;
    assert(s.installed === true, `gh not found: ${s.error}`);
    if (s.git) assert(s.git.installed === true, "git not found");
    else note("/api/setup/github has no `git` field (release predates the probe)");
    return `gh ${s.version ?? "?"}, authenticated=${s.authenticated}${s.login ? ` as ${s.login}` : ""}${s.git?.version ? `, git ${s.git.version}` : ""}`;
  });
  await check("runtime probe: installed AND login state, per harness", async () => {
    const r = await get("/api/setup/runtimes");
    if (r.status === 404) {
      note("/api/setup/runtimes is not in this release (predates the login probe)");
      return "skipped";
    }
    assert(r.status === 200, `${r.status}: ${r.text.slice(0, 200)}`);
    const claude = r.json.find((h) => h.kind === "claude");
    assert(claude?.available === true, `claude: ${JSON.stringify(claude)}`);
    assert(claude.path && existsSync(claude.path), `claude binary ${claude.path} does not exist`);
    assert(claude.login.checked === true, `claude login not checked: ${claude.login.error}`);
    // A runner has no Claude login — the probe must SAY so rather than pass.
    assert(claude.login.loggedIn === false, "a CI runner reported a Claude login");
    const codex = r.json.find((h) => h.kind === "codex");
    if (args.expectInstalledClis) {
      assert(claude.source === "installed", `the npm-installed claude should win over the bundled one, got ${claude.source}`);
      assert(codex?.available === true, `codex should be installed on this runner: ${JSON.stringify(codex)}`);
      assert(codex.login.checked === true && codex.login.loggedIn === false, `codex login: ${JSON.stringify(codex.login)}`);
    }
    return `claude ${claude.version} (${claude.source}) login=${claude.login.loggedIn}; codex available=${codex?.available}`;
  });
  await check("harness list and default-harness save", async () => {
    const list = (await get("/api/harnesses", { expect: 200 })).json;
    const claude = list.find((h) => h.kind === "claude");
    assert(claude?.runtime?.available === true, JSON.stringify(list));
    if (args.expectInstalledClis) {
      const codex = list.find((h) => h.kind === "codex");
      assert(codex?.runtime?.available === true, `codex runtime not detected: ${JSON.stringify(codex?.runtime)}`);
    }
    const current = (await get("/api/settings", { expect: 200 })).json;
    await put("/api/settings", { ...current, harness: { ...current.harness, defaultHarness: "claude", defaults: current.harness?.defaults ?? {} } }, { expect: 200 });
    const saved = (await get("/api/settings", { expect: 200 })).json;
    assert(saved.harness?.defaultHarness === "claude", JSON.stringify(saved.harness));
    return `claude ${claude.runtime.version ?? ""} ${claude.runtime.source}`;
  });

  const repoPath = join(root, "smoke-project");
  let projectId = "";
  await check("first project: POST /api/projects with initRepo creates the repo", async () => {
    const r = await post("/api/projects", {
      name: "Smoke",
      repoPath,
      worktreeRoot: join(root, "smoke-worktrees"),
      defaultBranch: "main",
      initRepo: true,
    }, { expect: 201 });
    projectId = r.json.id;
    assert(existsSync(join(repoPath, ".git")), "no .git after initRepo");
    return projectId;
  });
  await check("POST /api/setup/complete finishes the wizard", async () => {
    const s = (await post("/api/setup/complete", {}, { expect: 200 })).json;
    assert(s.completed === true && typeof s.completedAt === "number", JSON.stringify(s));
    const again = (await get("/api/setup", { expect: 200 })).json;
    assert(again.completed === true, JSON.stringify(again));
  });

  /* ---- 6. core features against the installed build ---- */

  // A commit, so worktrees and the git panel have something to look at.
  const git = (a) => runQuiet("git", a, { cwd: repoPath });
  git(["config", "user.email", "smoke@example.com"]);
  git(["config", "user.name", "Install Smoke"]);
  writeFileSync(join(repoPath, "README.md"), "# smoke\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "chore: smoke fixture"]);

  let chatId = "";
  await check("chat round-trip over the websocket (fake SDK echo)", async () => {
    const chat = (await post("/api/chats", { projectId }, { expect: 201 })).json;
    chatId = chat.id;
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws`);
    const events = [];
    let helloVersion;
    const echoed = new Promise((resolveEcho, reject) => {
      const timer = setTimeout(() => reject(new Error(`no echo within 45s; saw ${events.slice(-8).join(", ")}`)), 45_000);
      ws.addEventListener("message", (m) => {
        const evt = JSON.parse(String(m.data));
        events.push(evt.type);
        if (evt.type === "hello") helloVersion = evt.version;
        if (evt.type === "chat-message" && evt.chatId === chatId && JSON.stringify(evt.message).includes("Echo: ping")) {
          clearTimeout(timer);
          resolveEcho();
        }
      });
      ws.addEventListener("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`websocket error: ${e.message ?? e}`));
      });
    });
    await new Promise((r, j) => {
      ws.addEventListener("open", r);
      ws.addEventListener("error", j);
    });
    ws.send(JSON.stringify({ type: "send-message", chatId, text: "ping" }));
    await echoed;
    ws.close();
    const rows = (await get(`/api/chats/${chatId}/messages`, { expect: 200 })).json;
    assert(JSON.stringify(rows).includes("Echo: ping"), "the transcript does not hold the echo");
    if (helloVersion !== undefined) assert(helloVersion === headVersion, `hello.version ${helloVersion} ≠ ${headVersion}`);
    return `${rows.length} rows, hello.version=${helloVersion}`;
  });

  await check("GET /api/models answers", async () => {
    const m = (await get("/api/models", { expect: 200 })).json;
    assert(Array.isArray(m) && m.length > 0, JSON.stringify(m)?.slice(0, 200));
    return `${m.length} models`;
  });

  await check("git panel: status, branches, log", async () => {
    const q = `?repoPath=${encodeURIComponent(repoPath)}`;
    const status = (await get(`/api/git/status${q}`, { expect: 200 })).json;
    const branches = (await get(`/api/git/branches${q}`, { expect: 200 })).json;
    await get(`/api/git/log${q}`, { expect: 200 });
    assert(JSON.stringify(branches).includes("main"), `branches: ${JSON.stringify(branches).slice(0, 200)}`);
    return `status: ${JSON.stringify(status).slice(0, 80)}`;
  });

  await check("worktree create and remove", async () => {
    // `base: "main"` explicitly: the default is `origin/<trunk>`, and this
    // fixture repo has no remote — a real project always does.
    const wt = (await post("/api/worktrees", { projectId, branch: "smoke/worktree", base: "main" }, { expect: 201 })).json;
    assert(wt.path && existsSync(wt.path), `worktree path ${wt.path} missing`);
    await api("DELETE", "/api/worktrees", { worktreePath: wt.path, force: true }, { expect: 204 });
    assert(!existsSync(wt.path), `worktree ${wt.path} still on disk after remove`);
    return wt.path;
  });

  await check("terminal runs a command in the project", async () => {
    const r = (await post("/api/terminals/run", { chatId, name: "smoke", command: "echo smoke-ok", timeoutMs: 30_000 }, { expect: 200 })).json;
    assert((r.output ?? "").includes("smoke-ok"), `output: ${JSON.stringify(r).slice(0, 300)}`);
    return `exit ${r.exitCode}`;
  });

  await check("update surface knows what is installed", async () => {
    const u = (await get("/api/update", { expect: 200 })).json;
    assert(u.supported === true, JSON.stringify(u).slice(0, 200));
    assert(u.installed?.tag === head || u.installed?.version === headVersion, `installed: ${JSON.stringify(u.installed)}`);
    const checked = (await post("/api/update/check", {}, { expect: 200 })).json;
    assert(!checked.error, `check error: ${checked.error}`);
    return `installed ${u.installed?.tag ?? u.installed?.version}, latest ${checked.latest?.tag ?? checked.latest?.version ?? "?"}`;
  });

  await check("the payload's CLI runs", () => {
    const r = runQuiet(process.execPath, [join(app, "packages/cli/dist/index.js"), "--help"]);
    assert(r.code === 0, r.out.slice(0, 300));
  });

  /* ---- 7. stop and start, state intact ---- */

  await check("launch.py --stop shuts the instance down", async () => {
    const { out } = await launch(["--stop"], { env });
    assert(/stopped\./.test(out), out);
    assert(!existsSync(join(root, "runtime.json")), "runtime.json survived the stop");
    assert(await portClosed(port), `port ${port} still answers`);
  });
  await hard("launch.py starts it again", async () => {
    await launch(["--no-window"], { env });
    const rt = readJson(join(root, "runtime.json"));
    port = rt.port;
    base = `http://127.0.0.1:${port}`;
    await waitForHealth();
  });
  await check("setup, project and chat persisted across the restart", async () => {
    const s = (await get("/api/setup", { expect: 200 })).json;
    const projects = (await get("/api/projects", { expect: 200 })).json;
    const chats = (await get("/api/chats", { expect: 200 })).json;
    assert(s.completed === true, JSON.stringify(s));
    assert(projects.length === 1 && projects[0].id === projectId, `projects: ${projects.length}`);
    assert(chats.some((c) => c.id === chatId), "the chat is gone");
  });

  /* ---- 8. same-version reinstall ---- */

  await hard("reinstalling the same version is idempotent", async () => {
    const extra = installerArgs.includes("--no-autostart") ? [] : ["--no-autostart"];
    const r = await run(process.execPath, [installer, ...installerArgs, ...extra], { env });
    assert(/is installed\./.test(r.out), "no `is installed.` summary");
  });
  await check("reinstall pruned to one backup and honoured --no-autostart", async () => {
    const stamp = readJson(join(root, "current.json"));
    assert(stamp.tag === head, `tag ${stamp.tag}`);
    assert(stamp.autostart === false, `autostart ${stamp.autostart}`);
    const backups = backupDirs(root);
    assert(backups.length === 1, `expected one backup after prune, found ${backups.length}: ${backups.join(", ")}`);
    if (!args.noLaunchers) {
      const status = autostart("--status");
      assert(status.code === 1, `autostart should be off: ${status.out.trim()}`);
    }
    return backups[0];
  });
  await check("the reinstalled build is healthy with its data", async () => {
    const rt = readJson(join(root, "runtime.json"));
    port = rt.port;
    base = `http://127.0.0.1:${port}`;
    const h = await waitForHealth();
    const projects = (await get("/api/projects", { expect: 200 })).json;
    assert(projects.length === 1, `projects: ${projects.length}`);
    return `pid ${h.pid}`;
  });

  /* ---- 9. stop, for good ---- */

  await check("final stop, and a second --stop is a no-op", async () => {
    const first = await launch(["--stop"], { env });
    assert(/stopped\./.test(first.out), first.out);
    assert(await portClosed(port), `port ${port} still answers`);
    const second = await launch(["--stop"], { env });
    assert(/not running/.test(second.out), second.out);
  });
}

/* --------------------------------------------------------------- report */

function writeReport(args, fatal) {
  const failed = results.filter((r) => r.ok === false);
  const skipped = results.filter((r) => r.ok === "skip");
  const passed = results.filter((r) => r.ok === true);
  const lines = [
    `### Install smoke — ${platform()}/${process.arch}, ${args.channel} channel`,
    "",
    `${failed.length === 0 && !fatal ? "✅" : "❌"} ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped${fatal ? ` — ${fatal}` : ""}`,
    "",
    "| | Check | Detail |",
    "|---|---|---|",
    // A pipe inside a cell would split the table; a look-alike bar keeps the
    // row intact without an escape sequence to get wrong.
    ...results.map((r) => `| ${r.ok === "skip" ? "⏭" : r.ok ? "✅" : "❌"} | ${r.name} | ${String(r.detail).replaceAll("|", "│").replace(/\r?\n/g, " ").slice(0, 400)} |`),
    ...(notes.length ? ["", "Notes:", ...notes.map((n) => `- ${n}`)] : []),
    "",
  ];
  const markdown = lines.join("\n");
  console.log(`\n${markdown}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  if (args.report) {
    mkdirSync(dirname(args.report), { recursive: true });
    writeFileSync(args.report, JSON.stringify({
      platform: platform(), arch: process.arch, node: process.version, channel: args.channel,
      ok: failed.length === 0 && !fatal, fatal: fatal ?? null, results, notes,
    }, null, 2));
  }
  return failed.length === 0 && !fatal;
}

const args = parseArgs(process.argv.slice(2));
let fatal;
try {
  await main();
} catch (error) {
  fatal = error instanceof Abort ? error.message : `crashed: ${error?.stack ?? error}`;
  console.error(`\nsmoke: ${fatal}`);
}
process.exitCode = writeReport(args, fatal) ? 0 : 1;
