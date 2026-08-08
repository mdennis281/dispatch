#!/usr/bin/env node
/**
 * Upgrade the running installed instance to a new commit, unattended, with a
 * rollback that survives the upgrade killing its own parent.
 *
 * `publish.mjs` already ships a payload safely, but it refuses to run while the
 * app is up — it builds IN PLACE, so publishing under a live server would swap
 * the code out from under running agents. That is the right call for a manual
 * ship. It is also why "update the app" currently means: stop, wait out a
 * multi-minute build, start. This does the same job with the downtime cut to
 * the swap itself, and without a human watching.
 *
 * ── The shape of the problem ────────────────────────────────────────────────
 * Four constraints drive every decision below.
 *
 * 1. THE BUILD MUST NOT TOUCH THE LIVE PAYLOAD. A failed build is the common
 *    case (a bad merge, a lockfile drift), and it must cost nothing. So the
 *    build happens in a separate `staging/` clone the running app has never
 *    heard of, and the live payload is not touched until a build has already
 *    succeeded AND passed `verifyPayload`. Fail before the swap and the running
 *    instance never notices.
 *
 * 2. THE UPGRADE OUTLIVES THE SERVER IT KILLS. This is the subtle one. Stopping
 *    Dispatch runs `services.dispose()` -> `runner.stopAll()`, which tree-kills
 *    every subApp the runner spawned. An upgrade launched from inside Dispatch
 *    IS such a process — so the moment it asks the server to stop, the server
 *    kills it, halfway through, with the payload moved aside and nothing left
 *    running to put it back. That is the one failure that loses the app.
 *
 *    So the swap runs DETACHED: this script re-spawns itself with
 *    DETACHED_PROCESS (or `start_new_session`), fully decoupled stdio, and its
 *    parent exits immediately. Its console is gone, so it narrates to
 *    `upgrade.log` and records machine-readable state in `upgrade.json` — those
 *    files ARE the progress UI, and the evidence if it dies mid-swap.
 *
 *    "Detached" is weaker than it sounds on Windows: libuv sets
 *    DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP but NOT
 *    CREATE_BREAKAWAY_FROM_JOB, and it does not sever the ppid link — and
 *    `tree-kill`, which is what stopAll() uses, runs `taskkill /pid X /T /F`,
 *    which walks exactly that link. The child is therefore a kill-tree
 *    descendant of its parent for as long as the parent lives. So the child
 *    WAITS FOR ITS PARENT TO EXIT (`--parent-pid`) before it issues the stop,
 *    and refuses to proceed if it doesn't. Relying on "the parent exits a few
 *    milliseconds later" was a race: the parent's last act is a console.log,
 *    and a caller that captured that pipe without draining it makes that write
 *    block forever.
 *
 * 3. GOING BACK MUST NOT DEPEND ON A BUILD. The old payload is MOVED aside, not
 *    deleted or rebuilt — a directory rename, already built, already verified.
 *    Rollback is the same rename in reverse. `publish.mjs`'s rollback has to
 *    re-run install+build and can therefore fail a second time; this one cannot.
 *
 * 4. THE PORT IS NOT THE LIFECYCLE. `app.close()` stops the LISTENER first and
 *    only then runs the onClose hook that disposes the services
 *    (packages/server/src/app.ts). So a dead port is the start of teardown, not
 *    the end of it: the node process is still alive with a cwd inside
 *    `app/packages/server`, launch.py's supervisor is still alive with a cwd of
 *    `app/`, and subApps are still being torn down — for up to 25s more. A
 *    rename of `app/` in that window fails EPERM on Windows, because a process
 *    holding a cwd inside a directory tree pins it. So every wait-for-stop here
 *    waits for the SUPERVISOR to exit (runtime.json gone, or its `supervisor`
 *    pid dead), which is the same signal launch.py's own `start()` uses.
 *
 * ── Sequence ────────────────────────────────────────────────────────────────
 *      stage    build <root>/staging at the target sha        (live app up)
 *      detach   re-spawn self, parent returns                 (live app up)
 *      wait     until the parent process is gone              (live app up)
 *      verify   re-check staging is complete                  (live app up)
 *      stop     launch.py --stop, then wait out the supervisor (downtime starts)
 *      swap     app -> backups/app-<sha>-<ts>;  staging -> app
 *      start    launch.py --no-window on the SAME port        (downtime ends)
 *      gate     poll /api/health until ok AND it is the NEW process
 *      keep     stamp current.json; recycle the old payload as next staging
 *   or revert   new payload -> failed/;  backup -> app;  start; gate again
 *
 * ── One backup generation, deliberately ─────────────────────────────────────
 * `backups/` holds ONE payload at a time in normal use: the success path
 * recycles `backups/app-*` straight back into `staging/` (it is already a
 * populated clone, which is what makes the next build incremental), and the
 * next upgrade's `git checkout --force` overwrites it. `--keep-backup` opts out
 * and leaves it under `backups/`, but nothing prunes what accumulates then.
 * This is not a history — it is the one rename that undoes the last swap.
 *
 * DATA IS NEVER IN THE BLAST RADIUS. `data/` and `config/` are siblings of
 * `app/`, and the server reaches them through DISPATCH_DATA_DIR / _CONFIG_DIR
 * (see launch.py). Every move here is confined to `app/`, `staging/`, and
 * `backups/`. No chat, checkpoint or setting is read, written or moved.
 *
 * Usage:
 *   node tools/app/upgrade.mjs [--ref <git-ref>] [--target <root>]
 *                              [--dry-run] [--stage-only] [--status]
 *                              [--recover] [--keep-backup]
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  readdirSync,
  statSync,
  appendFileSync,
  openSync,
  closeSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { desktopPaths } from "./paths.mjs";
import {
  assertNodeVersion,
  buildInto,
  capture,
  portAlive,
  prepareClone,
  run,
  verifyPayload,
} from "./build-payload.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

const IS_WIN = process.platform === "win32";

/**
 * How long to wait for the SUPERVISOR to exit after `--stop`.
 *
 * Not the port — see constraint 4 in the header. The arithmetic: the supervisor
 * notices the stop sentinel within ~1s, asks the server to shut down, then
 * gives it STOP_TIMEOUT_S (25s in launch.py) before killing it, and only then
 * drops runtime.json and exits. 60s is that plus room for a slow teardown.
 */
const STOP_TIMEOUT_MS = 60_000;
/** Gap between supervisor-exit polls. Cheap: one small file read plus a signal 0. */
const STOP_POLL_MS = 400;
/** How long to wait for a started server to report healthy. */
const HEALTH_TIMEOUT_MS = 120_000;
/** Gap between health polls. */
const HEALTH_INTERVAL_MS = 750;
/**
 * With the supervisor confirmed gone, nothing of OURS holds a handle inside
 * `app/` any more — so these retries are not a teardown budget (they were never
 * big enough to be one), they are slack for an AV scanner or the search indexer
 * that grabbed a directory handle a moment after the owning process died.
 */
const RENAME_ATTEMPTS = 12;
const RENAME_BACKOFF_MS = 750;
/**
 * How long the detached child waits for its parent to exit before refusing to
 * start. See constraint 2: while the parent lives, the child is a
 * `taskkill /T` descendant of it, and the stop we are about to issue is what
 * fires that taskkill.
 */
const PARENT_EXIT_TIMEOUT_MS = 30_000;
/**
 * Rotate `upgrade.log` past this. One upgrade appends a full `pnpm install`
 * plus a vite build; unrotated it is the biggest file in the deployment root
 * within a month.
 */
const LOG_MAX_BYTES = 2_000_000;

/** Phases that mean the payload may not be where the launcher expects it. */
// `relinking` belongs here: the payload is already in place but its
// node_modules are mid-repair, so an install interrupted there leaves `app/`
// present and unstartable — which is precisely the state that needs --recover
// rather than a cheerful "payload: present".
const UNSAFE_PHASES = new Set([
  "stopping",
  "swapping",
  "relinking",
  "starting",
  "restoring",
  "rolling-back",
]);

/* ------------------------------------------------------------------ args */

/**
 * A flag that takes a value must GET one, and must not swallow the next flag.
 *
 * `--ref` last on the line, or `--target --dry-run`, otherwise reads as
 * undefined / `"--dry-run"` and fails much later with an error about a git ref
 * or a directory — nowhere near the typo. `backsync.mjs` guards its own flags
 * the same way, for the same reason.
 */
function need(value, flag) {
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

const asInt = (v) => {
  const n = Number.parseInt(v ?? "", 10);
  // `--port` with a missing value used to yield NaN, and `NaN ?? fallback` is
  // NaN — so the probe port became NaN and the gate failed into a full,
  // needless rollback. Anything unparseable is "not given".
  return Number.isFinite(n) ? n : undefined;
};
const validPid = (n) => Number.isInteger(n) && n > 0;
const validPort = (n) => Number.isInteger(n) && n > 0 && n < 65536;

function parseArgs(argv) {
  const args = {
    ref: "HEAD",
    dryRun: false,
    stageOnly: false,
    status: false,
    recover: false,
    keepBackup: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--stage-only") args.stageOnly = true;
    else if (a === "--status") args.status = true;
    else if (a === "--recover") args.recover = true;
    else if (a === "--keep-backup") args.keepBackup = true;
    else if (a === "--ref") args.ref = need(argv[++i], a);
    else if (a === "--target") args.target = need(argv[++i], a);
    // Internal: the detached half. Never typed by a human.
    else if (a === "--swap") args.swap = true;
    else if (a === "--sha") args.sha = need(argv[++i], a);
    else if (a === "--subject") args.subject = need(argv[++i], a);
    else if (a === "--port") args.port = asInt(need(argv[++i], a));
    else if (a === "--old-pid") args.oldPid = asInt(need(argv[++i], a));
    else if (a === "--parent-pid") args.parentPid = asInt(need(argv[++i], a));
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

/* ---------------------------------------------------------------- paths+ */

function upgradePaths(paths) {
  return {
    ...paths,
    staging: join(paths.root, "staging"),
    failed: join(paths.root, "failed"),
    state: join(paths.root, "upgrade.json"),
    log: join(paths.root, "upgrade.log"),
    lock: join(paths.root, "upgrade.lock"),
  };
}

/* ------------------------------------------------------------------ log */

/**
 * The detached half has no console, so everything it says goes to a file.
 * Attached, it goes to both — the log is the record either way, and a human
 * watching `--stage-only` still wants to see the build.
 */
function makeLogger(p, { alsoConsole }) {
  mkdirSync(p.root, { recursive: true });
  rotateLog(p);
  return (chunk) => {
    const text = String(chunk);
    try {
      appendFileSync(p.log, text);
    } catch {
      /* a full or locked disk must not abort an upgrade mid-swap */
    }
    if (alsoConsole) process.stdout.write(text);
  };
}

/** Keep one previous generation. Anything cleverer needs a reason to exist. */
function rotateLog(p) {
  try {
    if (statSync(p.log).size < LOG_MAX_BYTES) return;
    rmSync(`${p.log}.1`, { force: true });
    renameSync(p.log, `${p.log}.1`);
  } catch {
    /* no log yet, or something has it open — never a reason to fail an upgrade */
  }
}

const say = (log) => (msg) => log(`[${new Date().toISOString()}] ${msg}\n`);

/**
 * Record a fatal from the ATTACHED half where a human can actually find it.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Every refusal before `makeLogger` (below the arg parse, the node-version
 * assert, the git probes, the bootstrap guard, the lock) went to `console.error`
 * and NOWHERE else. Run from a terminal that is fine. Run from the app — which
 * is the whole point of a live self-upgrade — and stderr is inherited from
 * `launch.py` under `pythonw`, which has no console: the explanation is written
 * to a handle that discards it. `upgrade.log` stayed empty and `--status` said
 * "no upgrade has been run", so the one question that mattered — WHY did it
 * refuse — had no answer anywhere on the machine.
 *
 * On 2026-08-08 that hid a guard that was working perfectly and naming its own
 * one-line remedy: the installed payload predated the readiness probe. The
 * upgrade had been "crashing instantly" for days.
 *
 * NOTE it records `lastError` and never touches `phase`. Phase describes what
 * has MOVED on disk, and a throw here usually means nothing has; overwriting a
 * real `swapping` with a cheerful `refused` would turn a recoverable install
 * into a lie. Non-destructive by construction.
 */
function reportFatal(p, err) {
  const stamp = new Date().toISOString();
  const message = err?.message ?? String(err);
  const detail = err?.stack ?? message;
  try {
    mkdirSync(p.root, { recursive: true });
    rotateLog(p);
    appendFileSync(p.log, `[${stamp}] UPGRADE FAILED (nothing was swapped)\n${detail}\n\n`);
  } catch {
    /* an unwritable state dir must not replace the error with its own */
  }
  writeState(p, { lastError: message, lastErrorAt: stamp });
  // Still say it on the console: attached from a terminal, this is the copy a
  // human is actually looking at.
  console.error(`\nupgrade failed: ${message}`);
  console.error(`\n  recorded in : ${p.log}`);
  console.error(`  or run      : node tools/app/upgrade.mjs --status`);
}

/* ---------------------------------------------------------------- state */

function readState(p) {
  try {
    return JSON.parse(readFileSync(p.state, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Record where the upgrade got to. Written on every transition so a crash
 * leaves a readable answer to "what state is my install in", which — with the
 * payload possibly renamed — is otherwise guesswork.
 */
function writeState(p, patch) {
  const prev = readState(p) ?? {};
  const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
  try {
    writeFileSync(p.state, JSON.stringify(next, null, 2));
  } catch {
    /* best effort */
  }
  return next;
}

/**
 * The published stamp, guarded.
 *
 * A truncated `current.json` — one power loss during a previous publish's
 * `writeFileSync` is enough — used to throw from the statement immediately
 * after the stop, which meant the outer catch declared STUCK with the app
 * switched off and `app/` perfectly intact. The stamp only feeds a backup
 * directory NAME; it is never worth an outage.
 */
function readStamp(p) {
  try {
    const st = JSON.parse(readFileSync(p.stamp, "utf8"));
    return st && typeof st === "object" ? st : {};
  } catch {
    return {};
  }
}

/* ----------------------------------------------------------------- locks */

/**
 * One upgrade at a time. Two concurrent swaps would race on the same three
 * directory names and could leave the payload under `backups/` with nothing at
 * `app/` — and the success path's `rmSync(staging)` would delete the other
 * upgrade's in-flight build. `wx` gives us the atomic create-or-fail this needs.
 */
function acquireLock(p) {
  mkdirSync(p.root, { recursive: true });
  try {
    const fd = openSync(p.lock, "wx");
    closeSync(fd);
  } catch {
    return false;
  }
  stampLock(p, process.pid);
  return true;
}

/**
 * Point the lock at the process that is actually doing the work.
 *
 * The attached half takes the lock and then hands off to a detached child and
 * exits — so for the entire multi-minute swap the lock named a process that no
 * longer existed, and every concurrent upgrade read it as stale and barged in.
 * The parent re-stamps it with the child's pid the moment it has one, and the
 * child re-stamps it again as its first act, closing the gap in between.
 */
function stampLock(p, pid) {
  try {
    writeFileSync(p.lock, JSON.stringify({ pid, at: new Date().toISOString() }));
  } catch {
    /* best effort — a lock we cannot write is a lock we cannot honour */
  }
}

function releaseLock(p) {
  try {
    rmSync(p.lock, { force: true });
  } catch {
    /* best effort */
  }
}

/** Is the pid recorded in the lock still alive? A crashed upgrade leaves a stale one. */
function lockIsStale(p) {
  let pid;
  try {
    ({ pid } = JSON.parse(readFileSync(p.lock, "utf8")));
  } catch {
    // Absent or unreadable: there is nothing here to respect.
    return true;
  }
  if (!validPid(pid)) return true;
  return !pidAlive(pid);
}

/* ------------------------------------------------------------------ pids */

/**
 * Does this pid still exist? Signal 0 tests for existence without delivering
 * anything. EPERM means the process is there and belongs to somebody else —
 * ALIVE, not gone; reading it as gone is how a lock becomes a no-op. Mirrors
 * `defaultIsPidAlive` in packages/server/src/services/runner.ts.
 */
function pidAlive(pid) {
  if (!validPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Block until the parent process is gone. See constraint 2: until it is, this
 * process is a `taskkill /T` descendant of it, and the very next thing we do is
 * trigger the tree-kill that walks that link.
 */
async function awaitParentGone(pid, { tell }) {
  if (!validPid(pid)) return true; // not told who the parent is — nothing to wait on
  const deadline = Date.now() + PARENT_EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(200);
  }
  tell(`parent pid ${pid} is STILL ALIVE after ${PARENT_EXIT_TIMEOUT_MS / 1000}s`);
  return false;
}

/* ---------------------------------------------------------------- probes */

function readRuntime(paths) {
  try {
    return JSON.parse(readFileSync(paths.runtime, "utf8"));
  } catch {
    return null;
  }
}

/** The live instance, confirmed by an actual connection (runtime.json survives a crash). */
async function liveInstance(paths) {
  const rt = readRuntime(paths);
  if (!rt || !validPort(rt.port)) return null;
  return (await portAlive(rt.port)) ? rt : null;
}

/**
 * Wait until the supervisor that owned `was` has EXITED — not until its port
 * goes quiet.
 *
 * The port dies first and the supervisor dies last (constraint 4), and it is
 * the supervisor that holds a cwd of `app/` and therefore pins the directory
 * we are about to rename. Three ways to be sure it is done, in order of
 * directness: its runtime.json is gone (its own `finally` removes it), a
 * DIFFERENT supervisor already owns that file, or its pid no longer exists.
 */
async function awaitSupervisorGone(p, was, { tell, timeoutMs = STOP_TIMEOUT_MS } = {}) {
  const sup = validPid(was?.supervisor) ? was.supervisor : undefined;
  const srv = validPid(was?.pid) ? was.pid : undefined;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rt = readRuntime(p);
    if (!rt) return true;
    if (sup !== undefined && validPid(rt.supervisor) && rt.supervisor !== sup) return true;
    if (sup !== undefined && !pidAlive(sup)) return true;
    // A payload predating the `supervisor` field: fall back to the server pid,
    // which the supervisor outlives by microseconds.
    if (sup === undefined && srv !== undefined && !pidAlive(srv)) return true;
    await sleep(STOP_POLL_MS);
  }
  tell?.(`  supervisor ${sup ?? srv ?? "?"} did not exit within ${timeoutMs / 1000}s`);
  return false;
}

/** Fetch /api/health. Returns the parsed report, or null if it didn't answer. */
async function health(port, timeoutMs = 3000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ac.signal });
    const body = await res.json();
    if (!body || typeof body !== "object") return null;
    // `httpStatus`, not `status`: the report has its OWN `status` field
    // ("ok"/"degraded"), and merging the numeric code under that key silently
    // ate it. Body fields win; the transport code rides alongside.
    return { ...body, httpStatus: res.status };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait until the port is served by a HEALTHY process that is demonstrably not
 * the one we stopped.
 *
 * "Healthy" alone is not enough: if the stop silently failed, the old server is
 * still answering and would sail through a naive check, and the upgrade would
 * report success having changed nothing. `notPid` and `after` are what make
 * this a proof of replacement rather than a proof of liveness. `wantSha` is
 * checked when the payload could resolve one, and treated as advisory when it
 * couldn't — a missing sha is unusual, not evidence of failure.
 */
async function awaitHealthy(port, { notPid, after, wantSha, log, timeoutMs = HEALTH_TIMEOUT_MS }) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const rep = await health(port);
    if (rep) {
      last = rep;
      const isNew =
        (notPid === undefined || rep.pid !== notPid) &&
        (after === undefined || (typeof rep.startedAt === "number" && rep.startedAt >= after));
      const shaOk = !wantSha || !rep.sha || rep.sha === wantSha;
      if (rep.ok && isNew && shaOk) return { ok: true, report: rep };
      if (rep.ok && !isNew) log?.(`  health ok but still the old process (pid ${rep.pid}) — waiting`);
      else if (rep.ok && !shaOk) log?.(`  health ok but sha is ${String(rep.sha).slice(0, 12)} — waiting`);
      else log?.(`  health degraded: ${(rep.problems ?? []).join("; ")}`);
    }
    await sleep(HEALTH_INTERVAL_MS);
  }
  return { ok: false, report: last };
}

/* ------------------------------------------------------------- launch.py */

function python() {
  return process.env.DISPATCH_PYTHON || (IS_WIN ? "python" : "python3");
}

/**
 * Which `launch.py` to drive — resolved FRESH at every call, because the
 * payload moves under us mid-swap.
 *
 * Never this checkout's copy. The dev tree is by definition the thing being
 * upgraded away from: it may be mid-edit, and this tool has already told the
 * user in as many words that its uncommitted changes are excluded. Driving it
 * anyway would break the stop, the start AND both rollback restarts from one
 * broken file — a terminal STUCK with nothing running. Preference order is
 * "whatever is installed right now": the payload, then the backup we moved
 * aside, then staging. `<checkout>/tools/app/launch.py` is the last resort and
 * only reachable when none of those exist.
 */
function launchPy(p, ctx) {
  for (const dir of [p.app, ctx?.backup, p.staging]) {
    if (!dir) continue;
    const script = join(dir, "tools", "app", "launch.py");
    if (existsSync(script)) return script;
  }
  return join(here, "launch.py");
}

/**
 * Drive launch.py and wait for it. Its stop/start paths already encode the
 * things that are easy to get wrong here (the stdin shutdown protocol, waiting
 * for runtime.json rather than the port), so this never reimplements them.
 *
 * Returns the exit code. Callers MUST look at it: launch.py exits non-zero for
 * "server did not come up within 60s" and "no built server at ...", and two
 * callers used to discard that and then declare a resting state they had never
 * verified.
 */
function launcher(script, argv, { cwd, log }) {
  return new Promise((res) => {
    const child = spawn(python(), [script, ...argv], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (b) => log(String(b)));
    child.stderr.on("data", (b) => log(String(b)));
    child.on("error", (err) => {
      log(`launcher failed to spawn: ${err.message}\n`);
      res(-1);
    });
    child.on("close", (code) => res(code ?? -1));
  });
}

const startArgv = (p, port) => [
  "--no-window",
  "--target",
  p.root,
  ...(validPort(port) ? ["--port", String(port)] : []),
];

/**
 * Start the payload and prove it came up. Every terminal phase in this file
 * goes through here: "restarted it" is a claim about a running server, and the
 * only evidence for it is a health report.
 */
async function restart(p, ctx, { after, wantSha, log, tell, timeoutMs = 90_000 }) {
  const code = await launcher(launchPy(p, ctx), startArgv(p, ctx.port), { cwd: p.root, log });
  if (code !== 0) tell(`  launch.py exited ${code} — health-checking anyway`);
  const probe = validPort(ctx.port) ? ctx.port : readRuntime(p)?.port;
  if (!validPort(probe)) {
    tell(`  no port to health-check against`);
    return { ok: false, report: null, code, port: undefined };
  }
  const gate = await awaitHealthy(probe, { after, wantSha, log: (m) => tell(m), timeoutMs });
  return { ...gate, code, port: probe };
}

/* ----------------------------------------------------------------- moves */

/**
 * Rename with retries. On Windows this is the operation most likely to fail for
 * a reason that resolves itself: a handle inside the directory that the OS has
 * not finished releasing.
 */
async function renameWithRetry(from, to, { log, attempts = RENAME_ATTEMPTS }) {
  for (let i = 1; i <= attempts; i++) {
    try {
      renameSync(from, to);
      return true;
    } catch (err) {
      if (i === attempts) {
        log(`rename failed after ${attempts} attempts: ${from} -> ${to}: ${err.message}\n`);
        return false;
      }
      log(`  rename busy (${err.code ?? err.message}), retry ${i}/${attempts}...\n`);
      await sleep(RENAME_BACKOFF_MS);
    }
  }
  return false;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Newest `backups/app-*`, by name — the names embed an ISO timestamp, so lexical is chronological. */
function newestBackup(p) {
  try {
    const dirs = readdirSync(p.backups)
      .filter((n) => n.startsWith("app-"))
      .sort()
      .reverse();
    for (const n of dirs) {
      const full = join(p.backups, n);
      if (statSync(full).isDirectory()) return full;
    }
  } catch {
    /* no backups dir */
  }
  return null;
}

/* =========================================================== stage phase */

async function stage(p, sha, subject, { log, tell }) {
  tell(`staging ${sha.slice(0, 12)} "${subject}" in ${p.staging}`);
  mkdirSync(p.root, { recursive: true });
  await prepareClone(p.staging, repoRoot, sha, log);
  await buildInto(p.staging, sha, log);
  tell(`staged OK — ${p.staging} is built and verified at ${sha.slice(0, 12)}`);
}

/* ============================================================ swap phase */

/**
 * The detached half: everything from here on can leave the install in a state
 * a human has to look at, so every branch narrates and every branch has a
 * defined resting place.
 *
 * `ctx` is what the recovery arm needs to know: how far the swap got, where the
 * backup went, and which port to come back on.
 */
async function swap(p, args, { log, tell }) {
  const ctx = { at: Date.now(), moved: false, backup: null, port: undefined };
  try {
    return await runSwap(p, args, ctx, { log, tell });
  } catch (err) {
    return await recoverFromThrow(p, ctx, err, { log, tell });
  }
}

/**
 * Anything thrown after the stop used to land in main()'s catch, which wrote
 * STUCK and returned — leaving the app switched off with `app/` intact and
 * perfectly startable. If nothing has been renamed yet, that is not stuck, it
 * is merely stopped.
 */
async function recoverFromThrow(p, ctx, err, { log, tell }) {
  tell(`SWAP THREW: ${err.stack ?? err.message}`);
  writeState(p, { phase: "recovering", reason: `swap threw: ${err.message}` });

  if (existsSync(p.app)) {
    tell(`${p.app} is on disk — restarting it before declaring anything`);
    // No `after`/`notPid` here: we may have thrown BEFORE the stop, in which
    // case the still-running server is the right answer and demanding a newer
    // process would burn the whole timeout and then lie about it.
    const gate = await restart(p, ctx, { log, tell });
    if (gate.ok && !ctx.moved) {
      writeState(p, { phase: "aborted", reason: `swap threw: ${err.message}`, ok: false });
      tell(
        `ABORTED: the upgrade failed but nothing had moved — the app is back up at\n` +
          `  http://127.0.0.1:${gate.port} on the payload it was already running.`,
      );
      return 1;
    }
    if (gate.ok) {
      writeState(p, { phase: "STUCK", reason: `swap threw mid-move: ${err.message}` });
      tell(
        `STUCK: the app is serving at http://127.0.0.1:${gate.port}, but the swap died\n` +
          `  mid-move and current.json may not describe it. Check: node tools/app/upgrade.mjs --status`,
      );
      return 2;
    }
  }

  writeState(p, { phase: "STUCK", reason: `swap threw: ${err.message}` });
  tell(
    `STUCK: nothing is running.\n` +
      `  Payload:  ${p.app}${existsSync(p.app) ? "" : " (MISSING)"}\n` +
      `  Backup:   ${ctx.backup ?? newestBackup(p) ?? "none"}\n` +
      `  Try:      node tools/app/upgrade.mjs --recover`,
  );
  return 2;
}

async function runSwap(p, args, ctx, { log, tell }) {
  const sha = args.sha;

  /* ---- re-verify the payload we are about to install ------------------- */
  // The child takes `--sha` on faith and is minutes removed from the build that
  // produced it. Six existsSync calls move "staging is not what we think" out of
  // the window where the app is already down and into the zero-cost zone.
  if (!existsSync(p.staging)) {
    writeState(p, { phase: "aborted", reason: "staging-missing" });
    tell(`ABORTED: ${p.staging} is gone. Nothing was touched; re-run the upgrade.`);
    return 1;
  }
  try {
    verifyPayload(p.staging);
  } catch (err) {
    writeState(p, { phase: "aborted", reason: `staging-incomplete: ${err.message}` });
    tell(`ABORTED: ${err.message}\n  Nothing was touched; the running app is still serving.`);
    return 1;
  }

  /* ---- outlive the parent BEFORE anything destructive ------------------ */
  if (!(await awaitParentGone(args.parentPid, { tell }))) {
    writeState(p, { phase: "aborted", reason: "parent-still-alive" });
    tell(
      `ABORTED: the process that launched this swap has not exited.\n` +
        `  Until it does, this process is a taskkill /T descendant of it — and the\n` +
        `  stop we are about to issue is what fires that taskkill. Nothing was\n` +
        `  touched; the app is untouched and still serving. Re-run from a terminal\n` +
        `  whose parent exits (or check for a caller holding our stdout open).`,
    );
    return 1;
  }

  const rt = readRuntime(p);
  const before = rt && validPort(rt.port) && (await portAlive(rt.port)) ? rt : null;
  // The same trap as constraint 4, one step earlier: a supervisor already
  // MIDWAY through teardown has closed its port, so a liveness probe reports
  // "nothing running" — while it still holds a cwd inside app/ and would fail
  // the rename below. Wait it out even though there is nothing left to ask.
  //
  // A stale runtime.json whose pids the OS has since recycled reads as lingering
  // here and costs a refused upgrade after 60s. That is the side to err on: the
  // refusal moves nothing and says exactly what to look at, while the opposite
  // mistake renames app/ out from under a live process.
  const lingering =
    !before && rt && (pidAlive(rt.supervisor) || pidAlive(rt.pid)) ? rt : null;

  const port = validPort(args.port) ? args.port : rt?.port;
  ctx.port = validPort(port) ? port : undefined;
  const oldPid = validPid(args.oldPid) ? args.oldPid : rt?.pid;

  writeState(p, {
    phase: "stopping",
    sha,
    port: ctx.port ?? null,
    oldPid: oldPid ?? null,
    startedAt: new Date().toISOString(),
  });

  /* ---- stop ------------------------------------------------------------ */
  if (before) {
    tell(`stopping the running instance (pid ${before.pid}, port ${before.port})`);
    // Graceful only. A TerminateProcess here would skip services.dispose() and
    // orphan every subApp dev server onto its port — the exact mess the Ports
    // & processes panel exists to clean up, inflicted by the tool meant to be
    // safe.
    const code = await launcher(launchPy(p, ctx), ["--stop", "--target", p.root], {
      cwd: p.root,
      log,
    });
    if (code !== 0) tell(`  launch.py --stop exited ${code} — waiting on the supervisor anyway`);

    // NOT the port. See constraint 4: the listener closes first and the
    // supervisor — which holds a cwd of app/ and would make the rename below
    // fail EPERM — exits up to 25s later.
    if (!(await awaitSupervisorGone(p, before, { tell }))) {
      // Refusing here is the conservative branch and deliberately so: the app
      // is still up and serving, nothing has moved, and a wedged teardown
      // usually means a child is hung. Forcing it would trade a failed upgrade
      // for orphaned processes and a half-stopped server.
      writeState(p, { phase: "aborted", reason: "stop-timeout" });
      tell(
        `ABORTED: the instance did not stop within ${STOP_TIMEOUT_MS / 1000}s.\n` +
          `  Nothing was moved; the running app is untouched.\n` +
          `  Its teardown may be wedged on a hung subApp — check Ports & processes.`,
      );
      return 1;
    }
    tell("stopped cleanly — the supervisor is gone and app/ is nobody's cwd");
  } else if (lingering) {
    tell(
      `the port is already closed but supervisor ${lingering.supervisor ?? lingering.pid} is ` +
        `still tearing down — waiting for it to exit`,
    );
    if (!(await awaitSupervisorGone(p, lingering, { tell }))) {
      writeState(p, { phase: "aborted", reason: "stop-timeout" });
      tell(
        `ABORTED: a previous instance is still shutting down after ${STOP_TIMEOUT_MS / 1000}s.\n` +
          `  Nothing was moved. Its teardown may be wedged on a hung subApp —\n` +
          `  check Ports & processes.`,
      );
      return 1;
    }
    tell("the previous instance finished tearing down");
  } else {
    tell("no running instance — swapping directly");
  }

  /* ---- swap ------------------------------------------------------------ */
  const previousSha = readStamp(p).sha ?? null;
  mkdirSync(p.backups, { recursive: true });
  const backup = join(p.backups, `app-${(previousSha ?? "unknown").slice(0, 12)}-${stamp()}`);

  writeState(p, { phase: "swapping", backup });

  const hadApp = existsSync(p.app);
  if (hadApp) {
    tell(`moving the live payload aside -> ${backup}`);
    if (!(await renameWithRetry(p.app, backup, { log }))) {
      // Still the safe side of the line: `app/` is where it always was.
      writeState(p, { phase: "aborted", reason: "backup-rename-failed" });
      tell(
        `could not move ${p.app} aside — something still holds a handle in it.\n` +
          `  The payload is untouched. Restarting the app as it was.`,
      );
      const gate = await restart(p, ctx, { after: ctx.at, log, tell });
      if (gate.ok) {
        writeState(p, { phase: "aborted", reason: "backup-rename-failed", ok: false });
        tell(
          `ABORTED: nothing was moved and the app is serving again at\n` +
            `  http://127.0.0.1:${gate.port} (pid ${gate.report.pid}), on the old payload.`,
        );
        return 1;
      }
      writeState(p, { phase: "STUCK", reason: "abort-restart-unhealthy" });
      tell(
        `STUCK: nothing was moved — ${p.app} is intact — but it did not come back up.\n` +
          `  ${gate.report ? `last report: ${JSON.stringify(gate.report)}` : "it never answered"}\n` +
          `  Try: pnpm app:status, then pnpm app.`,
      );
      return 2;
    }
    ctx.moved = true;
    ctx.backup = backup;
  }

  tell(`moving the staged build in -> ${p.app}`);
  if (!(await renameWithRetry(p.staging, p.app, { log }))) {
    writeState(p, { phase: "restoring", reason: "staging-rename-failed" });
    tell(`could not move staging into place — putting the old payload back`);
    if (hadApp) {
      if (!(await renameWithRetry(backup, p.app, { log }))) {
        writeState(p, { phase: "STUCK", reason: "cannot-restore-backup" });
        tell(
          `STUCK: staging would not move in AND ${backup} would not move back.\n` +
            `  Nothing is running and ${p.app} is missing. By hand: ${backup} -> ${p.app}`,
        );
        return 2;
      }
      ctx.moved = false;
      ctx.backup = null;
    }
    // The old rolled-back branch stopped here — it restarted and wrote
    // "rolled-back" with no health gate at all, so a launcher that failed to
    // start anything still read as a completed rollback.
    const gate = await restart(p, ctx, { after: ctx.at, log, tell });
    if (gate.ok) {
      writeState(p, { phase: "rolled-back", reason: "staging-rename-failed", ok: false });
      tell(
        `ROLLED BACK — staging could not be moved in, and the previous payload is\n` +
          `  serving again at http://127.0.0.1:${gate.port} (pid ${gate.report.pid}).`,
      );
      return 1;
    }
    writeState(p, { phase: "STUCK", reason: "restore-restart-unhealthy" });
    tell(
      `STUCK: the old payload is back at ${p.app} but did not come up.\n` +
        `  ${gate.report ? `last report: ${JSON.stringify(gate.report)}` : "it never answered"}`,
    );
    return 2;
  }
  ctx.moved = true;
  ctx.backup = hadApp ? backup : null;

  /* ---- relink node_modules --------------------------------------------- */

  /**
   * RELINK AFTER THE MOVE. Without this the payload is broken the instant it
   * arrives, and every upgrade ends in a rollback.
   *
   * On Windows pnpm links each dependency as a JUNCTION, and a junction stores
   * an ABSOLUTE target. `staging/node_modules/.pnpm/...` is baked into all of
   * them, so renaming `staging` -> `app` leaves every link pointing at a
   * directory that no longer exists. The build verifies fine (the `dist` files
   * are real), then the new server dies on its first bare import:
   *
   *     Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'fastify'
   *         imported from ...\app\packages\server\dist\app.js
   *
   * That is exactly what happened on 2026-08-08: staged OK, moved in, never
   * answered, rolled back after the full 60s + 120s health wait. It is also why
   * `app:publish` has always worked where `app:upgrade` never did — publish
   * builds IN PLACE in `app/`, so its junctions are written pointing at `app/`.
   *
   * `pnpm install` is the repair: it rewrites the links for the directory they
   * are now in. It is cheap — the store is content-addressed and every package
   * is already present, so this is relinking, not downloading. No `--frozen-
   * lockfile` fight either; the lockfile came over with the payload.
   *
   * A failure here deliberately FALLS THROUGH rather than branching into its own
   * recovery: the start below will fail, the health gate will not open, and the
   * existing rollback — the one that is actually exercised — puts the old build
   * back and keeps the broken one for diagnosis. A second bespoke rollback path
   * here would be the least-tested code in the file, running only when things
   * have already gone wrong.
   */
  writeState(p, { phase: "relinking" });
  tell(`relinking node_modules in ${p.app} (junctions still point at staging)`);
  try {
    // `--config.confirmModulesPurge=false` is LOAD-BEARING, not tidiness.
    //
    // pnpm sees a modules dir built for a different path, decides it must be
    // removed and recreated, and asks first. The swap half is detached with
    // `stdio: "ignore"` — there is no TTY to ask — so it aborts:
    //
    //   ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
    //
    // i.e. without this flag the relink fails exactly where it is needed, and
    // only there: run by hand in a terminal it succeeds and the bug looks fixed.
    await run(
      "pnpm",
      ["install", "--frozen-lockfile", "--config.confirmModulesPurge=false"],
      p.app,
      log,
    );
    tell(`relinked OK`);
  } catch (err) {
    writeState(p, { phase: "relinking", reason: `relink failed: ${err.message}` });
    tell(`RELINK FAILED — ${err.message}`);
    tell(`  node_modules still points at ${p.staging}; the health gate below will roll this back`);
  }

  /* ---- start + gate ---------------------------------------------------- */
  writeState(p, { phase: "starting" });
  tell(`starting the new payload${validPort(ctx.port) ? ` on port ${ctx.port}` : ""}`);
  const startCode = await launcher(launchPy(p, ctx), startArgv(p, ctx.port), { cwd: p.root, log });
  if (startCode !== 0) tell(`  launch.py exited ${startCode} — health-checking anyway`);

  const probePort = validPort(ctx.port) ? ctx.port : readRuntime(p)?.port;
  if (!validPort(probePort)) tell("started, but no port to health-check against — treating as failed");

  const gate = validPort(probePort)
    ? await awaitHealthy(probePort, {
        notPid: oldPid,
        after: ctx.at,
        wantSha: sha,
        log: (m) => tell(m),
      })
    : { ok: false, report: null };

  if (gate.ok) {
    writeState(p, { phase: "verifying", health: gate.report });
    writeFileSync(
      p.stamp,
      JSON.stringify(
        {
          sha,
          // Both of these used to be lies: `subject` was never passed to the
          // detached half (so `launch.py --status` printed "None" forever) and
          // `ref` was the literal string "upgrade".
          subject: args.subject ?? null,
          ref: args.ref ?? null,
          publishedAt: new Date().toISOString(),
          previous: previousSha,
        },
        null,
        2,
      ),
    );

    // The old payload becomes the next staging clone rather than being deleted.
    // It is already a git clone of the same repo with a populated node_modules,
    // which is exactly what the next upgrade's `prepareClone` + `buildInto`
    // want — and the reason publish.mjs's incremental builds are fast. Deleting
    // it would make every future upgrade re-clone and cold-install for no gain.
    // --keep-backup opts out and leaves it under backups/ instead.
    if (hadApp && !args.keepBackup) {
      // Safe across pnpm's node_modules junctions: Node's recursive rm unlinks
      // a Windows junction rather than descending through it (verified on
      // v25 — the link's target and its contents survive).
      rmSync(p.staging, { recursive: true, force: true });
      if (await renameWithRetry(backup, p.staging, { log, attempts: 3 })) {
        ctx.backup = null;
        tell(`recycled the previous payload as the next staging clone`);
      } else {
        tell(`left the previous payload at ${backup} (could not recycle it)`);
      }
    }

    writeState(p, { phase: "done", ok: true, sha, finishedAt: new Date().toISOString() });
    tell(
      `UPGRADE OK — now running ${sha.slice(0, 12)} (pid ${gate.report.pid}) at ` +
        `http://127.0.0.1:${probePort}\n` +
        `  Reload any open tab: the SPA and its service worker changed.`,
    );
    return 0;
  }

  /* ---- rollback -------------------------------------------------------- */
  writeState(p, { phase: "rolling-back", health: gate.report });
  tell(
    `NEW BUILD FAILED ITS HEALTH CHECK — rolling back.\n` +
      `  ${gate.report ? `last report: ${JSON.stringify(gate.report)}` : "it never answered"}`,
  );

  // Stop whatever we just started, if anything did come up. Graceful first for
  // the same reason as above; a build that answers the port may still have
  // spawned children — and, again, we wait for the SUPERVISOR, because it is
  // the process holding a cwd inside the directory we are about to rename.
  const started = readRuntime(p);
  if (validPort(probePort) && (await portAlive(probePort, 800))) {
    await launcher(launchPy(p, ctx), ["--stop", "--target", p.root], { cwd: p.root, log });
    if (!(await awaitSupervisorGone(p, started ?? {}, { tell }))) {
      tell(`  the failed build's supervisor is still up — the rename below may fail`);
    }
  }

  // Keep the failed payload rather than deleting it — it is the only copy of
  // the thing that broke, and "why did the upgrade roll back" is unanswerable
  // without it.
  mkdirSync(p.failed, { recursive: true });
  const failedDir = join(p.failed, `app-${sha.slice(0, 12)}-${stamp()}`);
  if (existsSync(p.app) && !(await renameWithRetry(p.app, failedDir, { log }))) {
    writeState(p, { phase: "STUCK", reason: "cannot-move-failed-payload" });
    tell(
      `STUCK: the new payload is at ${p.app} and will not move, and the previous\n` +
        `  one is at ${backup}. Nothing is running. Move them by hand:\n` +
        `    rename ${p.app} out of the way, then ${backup} -> ${p.app}`,
    );
    return 2;
  }

  if (hadApp && !(await renameWithRetry(backup, p.app, { log }))) {
    writeState(p, { phase: "STUCK", reason: "cannot-restore-backup" });
    tell(`STUCK: could not restore ${backup} -> ${p.app}. Move it back by hand.`);
    return 2;
  }
  if (hadApp) {
    ctx.moved = false;
    ctx.backup = null;
  }

  tell("previous payload restored — starting it");
  const back = await restart(p, ctx, { after: ctx.at, log, tell });

  if (back.ok) {
    writeState(p, { phase: "rolled-back", ok: false, failedPayload: failedDir });
    tell(
      `ROLLED BACK — the previous build is running again at http://127.0.0.1:${back.port}.\n` +
        `  The build that failed is kept at ${failedDir} for diagnosis.\n` +
        `  Nothing in data/ or config/ was touched.`,
    );
    return 1;
  }

  writeState(p, { phase: "STUCK", reason: "restored-payload-unhealthy" });
  tell(
    `STUCK: rolled back to the previous payload and IT did not come up either.\n` +
      `  Payload: ${p.app}\n  Failed build: ${failedDir}\n` +
      `  data/ and config/ are untouched. Try: pnpm app:status, then pnpm app.`,
  );
  return 2;
}

/* ========================================================= recover phase */

/**
 * Finish or reverse an interrupted swap.
 *
 * A child killed during `swapping` leaves `app/` ABSENT with the only good
 * payload under `backups/` — and the launcher's generic "publish the payload
 * first" advice is actively harmful there, because publish.mjs would see no
 * payload, cold-clone a fresh one, and abandon the good build sitting next to
 * it. Everything needed to undo that is already recorded: the backup path, the
 * port and the sha.
 */
async function recover(p, args, { log, tell }) {
  const state = readState(p) ?? {};
  const ctx = {
    at: Date.now(),
    moved: true,
    backup: state.backup && existsSync(state.backup) ? state.backup : null,
    port: validPort(args.port)
      ? args.port
      : validPort(state.port)
        ? state.port
        : readRuntime(p)?.port,
  };
  tell(
    `recovering: last phase "${state.phase ?? "none"}"` +
      `${state.sha ? `, target ${String(state.sha).slice(0, 12)}` : ""}`,
  );

  const live = await liveInstance(p);
  if (live) {
    tell(
      `Dispatch is already serving at ${live.url} (pid ${live.pid}) from ${live.appDir}.\n` +
        `  Nothing to recover — recovery only ever puts a payload back in place.`,
    );
    return 0;
  }

  /* ---- put a payload at app/ ------------------------------------------- */
  if (!existsSync(p.app)) {
    const source = ctx.backup ?? newestBackup(p);
    if (!source) {
      writeState(p, { phase: "STUCK", reason: "recover-no-payload" });
      tell(
        `STUCK: ${p.app} is missing and there is no backup under ${p.backups}.\n` +
          `  If ${p.staging} holds a good build, this is recoverable by hand; otherwise\n` +
          `  re-install with: pnpm app:publish`,
      );
      return 2;
    }
    tell(`${p.app} is missing — restoring ${source}`);
    if (!(await renameWithRetry(source, p.app, { log }))) {
      writeState(p, { phase: "STUCK", reason: "recover-restore-failed" });
      tell(`STUCK: could not move ${source} -> ${p.app}. Move it by hand.`);
      return 2;
    }
    if (ctx.backup === source) ctx.backup = null;
  }

  /* ---- is what's there actually a payload? ----------------------------- */
  let complete = true;
  try {
    verifyPayload(p.app);
  } catch (err) {
    complete = false;
    tell(`${p.app} is incomplete: ${err.message}`);
  }
  if (!complete) {
    const source = ctx.backup ?? newestBackup(p);
    if (!source) {
      writeState(p, { phase: "STUCK", reason: "recover-incomplete-no-backup" });
      tell(`STUCK: ${p.app} is not a usable payload and there is no backup to swap in.`);
      return 2;
    }
    mkdirSync(p.failed, { recursive: true });
    const failedDir = join(p.failed, `app-incomplete-${stamp()}`);
    tell(`moving the incomplete payload to ${failedDir} and restoring ${source}`);
    if (
      !(await renameWithRetry(p.app, failedDir, { log })) ||
      !(await renameWithRetry(source, p.app, { log }))
    ) {
      writeState(p, { phase: "STUCK", reason: "recover-swap-failed" });
      tell(`STUCK: could not put ${source} back at ${p.app}. Move it by hand.`);
      return 2;
    }
    ctx.backup = null;
  }

  /* ---- start and prove it ---------------------------------------------- */
  tell(`starting ${p.app}${validPort(ctx.port) ? ` on port ${ctx.port}` : ""}`);
  const gate = await restart(p, ctx, { log, tell });
  if (gate.ok) {
    writeState(p, {
      phase: "recovered",
      ok: true,
      recoveredFrom: state.phase ?? null,
      finishedAt: new Date().toISOString(),
    });
    tell(
      `RECOVERED — Dispatch is serving at http://127.0.0.1:${gate.port} (pid ${gate.report.pid}).\n` +
        `  current.json still describes ${String(readStamp(p).sha ?? "an unknown sha").slice(0, 12)};\n` +
        `  re-run the upgrade when you want the new one.`,
    );
    return 0;
  }
  writeState(p, { phase: "STUCK", reason: "recover-unhealthy" });
  tell(
    `STUCK: ${p.app} is in place but did not come up.\n` +
      `  ${gate.report ? `last report: ${JSON.stringify(gate.report)}` : "it never answered"}\n` +
      `  Try: pnpm app:status, then pnpm app.`,
  );
  return 2;
}

/* ============================================================ entrypoints */

/**
 * Re-spawn this script as the detached swap half.
 *
 * `stdio: "ignore"` and `unref()` are load-bearing, not tidiness: an inherited
 * pipe keeps a handle open to a parent that is about to be killed, and a write
 * into it after that throws EPIPE inside the swap. The child talks to the log
 * file and nothing else. `--parent-pid` is the other half of that decoupling —
 * see constraint 2 in the header.
 */
function detachSwap(p, argv) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--swap", "--parent-pid", String(process.pid), ...argv],
    {
      cwd: repoRoot,
      env: process.env,
      detached: true,
      stdio: "ignore",
      ...(IS_WIN ? { windowsHide: true } : {}),
    },
  );
  child.unref();
  return child.pid;
}

/**
 * What to DO about each phase.
 *
 * The raw upgrade.json this used to print is exactly the wrong thing to hand
 * someone whose app will not start: the interesting phases are the ones where
 * the payload is not where the launcher looks for it, and "phase: swapping" is
 * not advice.
 */
function remedyFor(p, state) {
  const backup = state.backup ?? newestBackup(p) ?? join(p.backups, "app-*");
  // A refusal with no phase never touched the install — say that plainly and
  // quote the reason, rather than falling through to "unrecognised phase".
  if (!state.phase && state.lastError) {
    return (
      `The upgrade refused before doing anything — the install is untouched and the\n` +
      `  app is unaffected. It said:\n\n    ${state.lastError}\n\n` +
      `  Full detail: ${p.log}`
    );
  }
  switch (state.phase) {
    case "staging":
      return `A build is in progress in ${p.staging}. Nothing has moved; the app is untouched.\n  Watch it: ${p.log}`;
    case "staged":
      return `${p.staging} is built but was never swapped in. Re-run \`pnpm app:upgrade\` to swap it.`;
    case "stopping":
      return `The app was being stopped and nothing had moved yet. If it is down, just start it: \`pnpm app\`.`;
    case "swapping":
      return (
        `The payload was mid-move. If ${p.app} is MISSING, the good build is at\n` +
        `    ${backup}\n` +
        `  Do NOT run \`pnpm app:publish\` — it would clone a fresh payload and abandon that one.\n` +
        `  Run:  pnpm app:upgrade -- --recover`
      );
    case "relinking":
      return (
        `The payload is in place at ${p.app} but its node_modules were mid-repair.\n` +
        `  On Windows pnpm's junctions store absolute paths, so a payload moved from\n` +
        `  staging needs \`pnpm install\` re-run in place before it can start.\n` +
        `  Finish it by hand:  pnpm -C "${p.app}" install --frozen-lockfile\n` +
        `  Or roll back:       pnpm app:upgrade -- --recover`
      );
    case "starting":
    case "restoring":
    case "rolling-back":
      return (
        `The swap was interrupted while restarting the server. The payload is at ${p.app}\n` +
        `  (backup: ${backup}). Run:  pnpm app:upgrade -- --recover`
      );
    case "recovering":
      return `A recovery attempt was interrupted. Run:  pnpm app:upgrade -- --recover`;
    case "aborted":
      return `The upgrade stopped before doing anything destructive. The previous payload is installed and startable.`;
    case "rolled-back":
      return `The new build failed its health check and the previous one was restored.\n  The failed build is kept at ${state.failedPayload ?? p.failed} for diagnosis.`;
    case "recovered":
      return `Recovered from an interrupted upgrade. current.json may name an older sha than you asked for — re-run the upgrade when ready.`;
    case "done":
      return `Nothing to do.`;
    case "STUCK":
      return (
        `This install needs attention. Payload: ${p.app}${existsSync(p.app) ? "" : "  (MISSING)"}\n` +
        `  Backup: ${backup}\n` +
        `  Start by trying:  pnpm app:upgrade -- --recover\n` +
        `  Full narration:   ${p.log}`
      );
    default:
      return `Unrecognised phase. Read ${p.log}.`;
  }
}

async function printStatus(p) {
  const state = readState(p);
  if (!state) {
    console.log("no upgrade has been run (no upgrade.json).");
    return 0;
  }
  const live = await liveInstance(p);
  console.log(`phase   : ${state.phase ?? "none"}${state.ok === true ? "  (ok)" : ""}`);
  if (state.sha) console.log(`target  : ${String(state.sha).slice(0, 12)}`);
  if (state.reason) console.log(`reason  : ${state.reason}`);
  // The refusal that never moved anything — printed FIRST-class, because for an
  // upgrade that "crashes instantly" this is the entire answer.
  if (state.lastError) {
    console.log(`refused : ${state.lastError}`);
    if (state.lastErrorAt) console.log(`   at   : ${state.lastErrorAt}`);
  }
  if (state.backup) console.log(`backup  : ${state.backup}`);
  console.log(`updated : ${state.updatedAt ?? "?"}`);
  console.log(`payload : ${p.app}${existsSync(p.app) ? "" : "   *** MISSING ***"}`);
  console.log(live ? `running : pid ${live.pid} at ${live.url}` : `running : nothing`);
  console.log(`\nREMEDY\n  ${remedyFor(p, state)}`);
  if (state.phase === "STUCK" || (UNSAFE_PHASES.has(state.phase) && !live)) return 2;
  return 0;
}

/**
 * The upgrade paths, published the moment they are known, so the top-level
 * `catch` can write to the right `upgrade.log` for a throw from ANY depth.
 *
 * Module-level because the alternative is threading a logger through every
 * function that might refuse — and the last version of "the error handler
 * couldn't reach the log" is the bug this whole change exists to fix.
 */
let fatalPaths;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = desktopPaths(
    args.target ? { ...process.env, DISPATCH_HOME: args.target } : process.env,
  );
  const p = upgradePaths(paths);
  fatalPaths = p;

  /* ---- the detached half ---------------------------------------------- */
  if (args.swap) {
    // First act, before anything can throw: take ownership of the lock. It was
    // written with the PARENT's pid and the parent is exiting right about now.
    stampLock(p, process.pid);
    const log = makeLogger(p, { alsoConsole: false });
    const tell = say(log);
    try {
      const code = await swap(p, args, { log, tell });
      process.exitCode = code;
    } catch (err) {
      writeState(p, { phase: "STUCK", reason: `swap threw: ${err.message}` });
      tell(`SWAP THREW: ${err.stack ?? err.message}`);
      process.exitCode = 2;
    } finally {
      releaseLock(p);
    }
    return;
  }

  /* ---- the attached half ---------------------------------------------- */
  if (args.status) {
    process.exitCode = await printStatus(p);
    return;
  }

  if (args.recover) {
    if (existsSync(p.lock) && !lockIsStale(p)) {
      throw new Error(
        `an upgrade is running (see ${p.lock}) — let it finish or fail first.\n` +
          `  Watch it:  node tools/app/upgrade.mjs --status`,
      );
    }
    rmSync(p.lock, { force: true });
    if (!acquireLock(p)) throw new Error(`could not take the upgrade lock at ${p.lock}`);
    const log = makeLogger(p, { alsoConsole: true });
    try {
      process.exitCode = await recover(p, args, { log, tell: say(log) });
    } finally {
      releaseLock(p);
    }
    return;
  }

  // The logger comes up HERE, before the first decision — not at the staging
  // step it used to. Everything below can end the run, and an upgrade that ends
  // without saying why into a console that does not exist is indistinguishable
  // from one that crashed. `alsoConsole` keeps a terminal run identical.
  const log = makeLogger(p, { alsoConsole: true });
  const tell = say(log);

  assertNodeVersion();

  const sha = capture("git", ["rev-parse", args.ref], repoRoot);
  const subject = capture("git", ["log", "-1", "--format=%s", sha], repoRoot);
  const dirty = capture("git", ["status", "--porcelain"], repoRoot);

  log(`source : ${repoRoot}\n`);
  log(`root   : ${p.root}\n`);
  log(`ref    : ${args.ref} -> ${sha.slice(0, 12)}  "${subject}"\n`);

  const live = await liveInstance(p);
  log(
    live
      ? `running: pid ${live.pid} at ${live.url}\n\n`
      : `running: nothing (a cold swap, no downtime to speak of)\n\n`,
  );

  const currentSha = readStamp(p).sha ?? null;
  if (currentSha === sha && !args.dryRun && !args.stageOnly) {
    // The most common "it ran for two seconds and stopped" report there is. It
    // is a SUCCESS — the install is already at the requested sha — but pressing
    // a button and getting two seconds of nothing reads as a crash, so this
    // states the outcome somewhere the UI and `--status` can both find it.
    tell(`already at ${sha.slice(0, 12)} — nothing to do.`);
    writeState(p, {
      phase: "done",
      ok: true,
      sha,
      subject,
      ref: args.ref,
      reason: `already at ${sha.slice(0, 12)} — the source has nothing newer than the install`,
    });
    return;
  }

  // BOOTSTRAP GUARD. The health gate proves the NEW process is answering by
  // comparing `pid` and `startedAt` — fields a payload built before health.ts
  // existed does not report (it answers a flat `{ok:true}`). Against such an
  // install the gate can never be satisfied, so a perfectly good build would be
  // stopped, swapped in, timed out on, and rolled back.
  //
  // Catch it HERE, where nothing has moved and the fix is one command, rather
  // than after a full swap cycle. This can only ever fire once per install.
  if (live && !args.stageOnly) {
    const probe = await health(live.port);
    if (probe && (!Number.isFinite(probe.pid) || !Number.isFinite(probe.startedAt))) {
      throw new Error(
        `the installed payload predates the readiness probe.\n` +
          `  Its /api/health answers ${JSON.stringify({ ok: probe.ok })} — no pid, no startedAt —\n` +
          `  so the upgrade could never prove the new process replaced the old one,\n` +
          `  and would roll back a good build after a needless restart.\n\n` +
          `  Bootstrap it once, the old way:\n` +
          `    pnpm app:stop && pnpm app:publish\n\n` +
          `  Every upgrade after that one can run under the live app.`,
      );
    }
  }

  if (dirty) {
    const n = dirty.split("\n").filter(Boolean).length;
    log(
      `WARNING: ${n} uncommitted change(s) in this checkout.\n` +
        `  Upgrading to the COMMITTED sha above — those changes are NOT included,\n` +
        `  including any to tools/app/launch.py, which the swap drives from the\n` +
        `  INSTALLED payload rather than from here.\n`,
    );
  }

  if (args.dryRun) {
    log(
      `--dry-run: would stage ${sha.slice(0, 12)} into ${p.staging}, then swap it in` +
        `${live ? ` (stopping pid ${live.pid} first)` : ""}.\n` +
        `  current: ${currentSha?.slice(0, 12) ?? "none"}\n`,
    );
    return;
  }

  if (existsSync(p.lock)) {
    if (!lockIsStale(p)) {
      throw new Error(
        `another upgrade is already running (see ${p.lock}).\n` +
          `  Watch it:  node tools/app/upgrade.mjs --status`,
      );
    }
    // Only ever clear a lock whose owner is demonstrably gone. The old code
    // deleted it unconditionally one line after checking it, which made the
    // check decorative.
    log(`clearing a stale upgrade lock (its process is gone)\n`);
    rmSync(p.lock, { force: true });
  }
  if (!acquireLock(p)) throw new Error(`could not take the upgrade lock at ${p.lock}`);

  try {
    writeState(p, { phase: "staging", sha, subject, ref: args.ref, startedAt: new Date().toISOString() });
    await stage(p, sha, subject, { log, tell });
  } catch (err) {
    writeState(p, { phase: "aborted", reason: `stage failed: ${err.message}` });
    // Through `log`, not `console.error`: a build failure is the single thing
    // someone most needs to read afterwards, and stderr is the one place it is
    // guaranteed not to survive.
    log(`\n${"=".repeat(72)}\n`);
    log(`STAGING FAILED — ${err.message}\n`);
    if (err.tail?.length) {
      log(`\nLast ${err.tail.length} lines before the failure:\n\n`);
      for (const l of err.tail) log(`  | ${l}\n`);
    }
    log(`${"=".repeat(72)}\n`);
    log(`\nThe running instance was never touched — it is still serving the old build.\n`);
    releaseLock(p);
    process.exitCode = 1;
    return;
  }

  if (args.stageOnly) {
    writeState(p, { phase: "staged", sha });
    releaseLock(p);
    log(`\n--stage-only: ${p.staging} is built at ${sha.slice(0, 12)}. Not swapped.\n`);
    return;
  }

  // From here the parent must not be the one doing the work: stopping the
  // server kills every process the runner spawned, and this may well be one.
  const swapArgs = [
    "--target",
    p.root,
    "--sha",
    sha,
    "--ref",
    args.ref,
    ...(subject ? ["--subject", subject] : []),
    ...(validPort(live?.port) ? ["--port", String(live.port)] : []),
    ...(validPid(live?.pid) ? ["--old-pid", String(live.pid)] : []),
    ...(args.keepBackup ? ["--keep-backup"] : []),
  ];
  const pid = detachSwap(p, swapArgs);
  // Hand the lock to the child immediately; it re-stamps it itself, but not
  // until it is scheduled, and this process is about to exit.
  if (validPid(pid)) stampLock(p, pid);

  log(
    `\nhanded off to a detached swap (pid ${pid}).\n` +
      `  It waits for this process to exit, then stops the app, swaps the payload,\n` +
      `  restarts and health-checks — and rolls back by itself if that fails.\n\n` +
      `  watch:  node tools/app/upgrade.mjs --status\n` +
      `  log:    ${p.log}\n`,
  );
}

main().catch((err) => {
  // `fatalPaths` is set the instant the root is known. Falling back to the
  // DEFAULT root matters: a throw from `parseArgs` happens before `--target` has
  // been read, and "we could not parse your arguments" recorded in the usual
  // place beats it recorded nowhere.
  reportFatal(fatalPaths ?? upgradePaths(desktopPaths()), err);
  process.exitCode = 1;
});
