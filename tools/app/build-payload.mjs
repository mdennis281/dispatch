/**
 * Building a payload: the shared half of `publish.mjs` and `upgrade.mjs`.
 *
 * Both scripts need the identical sequence — point a git clone at a sha, scrub
 * it, install, build, and then PROVE the result can actually serve — and every
 * step in it exists because a "successful" build failed that way once. Two
 * copies of that would drift, and the copy that drifts is the one that only
 * runs during an unattended upgrade, at the moment it is least observable. So
 * it lives here once and both callers import it.
 *
 * Nothing in this module knows about the deployment layout, which instance is
 * running, or what happens after the build. It builds a directory and tells you
 * whether it worked.
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";

/** Node the payload must be buildable by — mirrors the root package.json engines. */
export const MIN_NODE_MAJOR = 20;

/** How many trailing output lines to quote back when a step fails. */
const TAIL_LINES = 40;

/**
 * `pnpm` is a `.cmd` shim on Windows, and since the CVE-2024-27980 fix Node
 * refuses to spawn a `.cmd` without a shell (EINVAL). So pnpm — and only
 * pnpm — gets `shell: true`; `git` is a real executable and runs without one.
 *
 * The DEP0190 warning that pairs with `shell: true` is about args being
 * concatenated rather than escaped. Every pnpm invocation here passes fixed
 * literals (`install --frozen-lockfile`, `build`) with nothing user-supplied, so
 * there's no injection surface — but keep it that way if you add arguments.
 */
const needsShell = (cmd) => process.platform === "win32" && cmd === "pnpm";

/**
 * The argv every `pnpm install` in this tooling must use.
 *
 * `--frozen-lockfile`: a payload is built from the committed lockfile or it is
 * not reproducible.
 *
 * `--config.confirmModulesPurge=false`: NOT optional, and not cosmetic. pnpm
 * purges a `node_modules` it considers foreign — one built for a different path
 * (a payload moved from `staging/`) or by a different pnpm layout (`buildInto`
 * deliberately preserves it across shas with `git clean -e node_modules`) — and
 * it asks before doing so. Every caller here is headless: the upgrade's swap
 * half is detached with `stdio: "ignore"`, and the launcher runs under
 * `pythonw`. With no TTY pnpm does not default to yes, it ABORTS:
 *
 *     ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
 *
 * which fails the build. This is a nasty one to catch by hand, because a
 * terminal HAS a TTY: run the same command yourself and it succeeds, so the
 * bug only ever appears in the automated path. It cost two upgrade attempts on
 * 2026-08-08 — once in the post-move relink, once in the staging build.
 */
export const INSTALL_ARGS = ["--frozen-lockfile", "--config.confirmModulesPurge=false"];

export class StepError extends Error {
  constructor(label, code, tail) {
    super(`${label} failed (exit ${code})`);
    this.label = label;
    this.code = code;
    this.tail = tail;
  }
}

/**
 * Run a command, streaming its output live AND remembering the tail of it.
 *
 * Streaming matters (a 40s vite build with no output looks hung); remembering
 * matters because the interesting line — `ERR_PNPM_IGNORED_BUILDS`, a tsc
 * diagnostic — is otherwise gone by the time anyone reads the summary. Node's
 * `execFileSync` with `stdio: "inherit"` gives you the first and not the second,
 * and its thrown `err.message` is only ever "Command failed".
 *
 * `log` lets a detached caller (the upgrade's swap phase, which has no console)
 * redirect the same stream into a file without losing the live-ness. It receives
 * output RAW, carriage returns and all — pnpm and vite redraw their progress in
 * place with bare `\r`, and a logger that splits on newlines first would turn a
 * spinner into one unbounded line. Line splitting happens separately, only to
 * feed the tail buffer.
 *
 * It is called as `log(text, "stdout" | "stderr")` so the default keeps the two
 * streams apart. That second argument is the whole reason it exists: a logger
 * that folds stderr into stdout makes `pnpm app:publish 2>errors.log` capture
 * nothing. Callers that want one stream (the upgrade's file logger) just ignore
 * the argument.
 */
export function run(cmd, cmdArgs, cwd, log = defaultLog) {
  const label = `${cmd} ${cmdArgs.join(" ")}`;
  log(`  $ ${label}\n`);
  return new Promise((res, rej) => {
    // `windowsHide` because the upgrade's swap phase runs detached with no
    // console of its own, and Windows hands every console-subsystem child of a
    // console-less parent a NEW console window. Without this, a staging build
    // flashes one up per pnpm/tsc/vite invocation. Output is piped either way.
    const child = spawn(cmd, cmdArgs, { cwd, shell: needsShell(cmd), windowsHide: true });
    const tail = [];
    let pending = "";

    const absorb = (buf, stream) => {
      const text = String(buf);
      log(text, stream);
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        tail.push(line);
        if (tail.length > TAIL_LINES) tail.shift();
      }
    };

    child.stdout.on("data", (b) => absorb(b, "stdout"));
    child.stderr.on("data", (b) => absorb(b, "stderr"));
    child.on("error", (err) => rej(new StepError(label, -1, [err.message])));
    child.on("close", (code) => {
      if (pending) tail.push(pending);
      if (code === 0) res();
      else rej(new StepError(label, code, tail));
    });
  });
}

/** Raw passthrough, stream for stream — preserves in-place redraws AND `2>`. */
function defaultLog(chunk, stream) {
  (stream === "stderr" ? process.stderr : process.stdout).write(chunk);
}

/** Wrap a raw logger so a caller can hand it a single line without a newline. */
const line = (log) => (s) => log(`${s}\n`);

export function capture(cmd, cmdArgs, cwd) {
  return execFileSync(cmd, cmdArgs, {
    cwd,
    encoding: "utf8",
    shell: needsShell(cmd),
  }).trim();
}

/** Same, but a non-zero exit is an answer rather than an exception. */
export function tryCapture(cmd, cmdArgs, cwd) {
  try {
    return capture(cmd, cmdArgs, cwd);
  } catch {
    return null;
  }
}

/** Can we open a TCP connection to this port? (i.e. is something really up) */
export function portAlive(port, timeoutMs = 1500) {
  return new Promise((res) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    const done = (v) => {
      sock.destroy();
      res(v);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

export function assertNodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    throw new Error(
      `Node ${process.versions.node} is too old to build the payload ` +
        `(need >= ${MIN_NODE_MAJOR}).`,
    );
  }
}

/**
 * Point a payload clone's `origin` back at the source checkout before fetching.
 *
 * The clone recorded whatever path the repo had at first install. Move or
 * rename the checkout and every later build fetches from a directory that no
 * longer exists — with an error that says nothing about the cause.
 */
export async function ensureOrigin(dir, repoRoot, log = defaultLog) {
  const current = tryCapture("git", ["remote", "get-url", "origin"], dir);
  if (current === null) {
    await run("git", ["remote", "add", "origin", repoRoot], dir, log);
    return;
  }
  if (resolveEq(current, repoRoot)) return;
  line(log)(`origin moved: ${current}\n     -> ${repoRoot}`);
  execFileSync("git", ["remote", "set-url", "origin", repoRoot], { cwd: dir });
}

/**
 * Same directory? Compared as PATHS, not as strings.
 *
 * Git records the origin of a local clone in its own normal form —
 * `C:/Users/...`, forward slashes — while `repoRoot` is a Node path with
 * backslashes. A raw string compare therefore never matched, so every single
 * build logged `origin moved:` and re-ran `git remote set-url` for a remote
 * that was already correct. `resolve()` normalises separators and relative
 * segments; the lowercasing is a Windows filesystem property, not a general one.
 *
 * A non-path origin (an https:// or git@ remote) resolves to something that
 * cannot equal a local directory, which is the right answer for the question
 * being asked.
 */
function resolveEq(a, b) {
  const norm = (s) => {
    const r = resolve(String(s).trim()).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

/**
 * A commit only reachable from a local branch that was never fetched — or from
 * no branch at all — cannot be checked out in the payload. Catch it here, where
 * we can say what to do, rather than at `git checkout` with a bare "reference is
 * not a tree".
 */
export function assertCommitPresent(dir, sha) {
  if (tryCapture("git", ["cat-file", "-e", `${sha}^{commit}`], dir) !== null) return;
  throw new Error(
    `commit ${sha.slice(0, 12)} isn't reachable in the payload clone.\n` +
      `  It exists in your checkout but on no branch that was fetched — commit it\n` +
      `  to a branch (or push that branch) and re-run.`,
  );
}

/**
 * Delete workspace packages that no longer exist at this sha.
 *
 * `git clean -e node_modules` keeps installs fast — and keeps the rollback path
 * from depending on a fresh install succeeding — but it also means a package
 * directory that was DELETED between shas survives, hollowed out, because the
 * `node_modules` inside it is excluded from the clean. `packages/desktop` sat
 * there with 270MB of Electron after the shell was removed. pnpm ignores it
 * (it isn't in the lockfile), so nothing breaks; it is just a lie on disk that
 * grows with every package ever removed.
 */
export function pruneStalePackages(dir, sha, log = defaultLog) {
  const packages = join(dir, "packages");
  if (!existsSync(packages)) return;
  const tracked = new Set(
    (capture("git", ["ls-tree", "--name-only", `${sha}:packages`], dir) || "")
      .split("\n")
      .map((s) => s.trim().replace(/\/$/, ""))
      .filter(Boolean),
  );
  for (const name of readdirSync(packages)) {
    if (tracked.has(name)) continue;
    line(log)(`  pruning stale package: packages/${name}`);
    rmSync(join(packages, name), { recursive: true, force: true });
  }
}

/**
 * Prove a payload can actually serve before anything calls it published.
 *
 * Every one of these is something a "successful" build has failed to produce
 * before: a tsc that skipped emit because a stale tsbuildinfo said it was up to
 * date, a vite build whose output went somewhere else, an install that no-opped.
 */
export function verifyPayload(dir) {
  const required = [
    ["server entry", join(dir, "packages", "server", "dist", "index.js")],
    ["SPA shell", join(dir, "packages", "client", "dist", "index.html")],
    ["PWA manifest", join(dir, "packages", "client", "dist", "manifest.webmanifest")],
    ["service worker", join(dir, "packages", "client", "dist", "sw.js")],
    ["app icon", join(dir, "packages", "client", "dist", "icons", "favicon.ico")],
    ["launcher", join(dir, "tools", "app", "launch.py")],
  ];
  const missing = required.filter(([, p]) => !existsSync(p));
  if (missing.length) {
    throw new Error(
      `the build exited 0 but the payload is incomplete:\n` +
        missing.map(([what, p]) => `  missing ${what}: ${p}`).join("\n"),
    );
  }
}

/**
 * Check out `sha` into an existing payload clone and build it in place.
 *
 * In-place is correct for `publish.mjs` (which refuses to run under a live app,
 * so the payload it is destroying is nobody's) and correct for `upgrade.mjs`
 * only because it aims this at a STAGING clone the running app has never heard
 * of. Never point it at a live payload.
 */
export async function buildInto(dir, sha, log = defaultLog) {
  await run("git", ["checkout", "--force", sha], dir, log);
  // A leftover file from the previous sha (a renamed module, a dropped asset)
  // is invisible to git and can satisfy an import that should have broken.
  await run("git", ["clean", "-fdx", "-e", "node_modules"], dir, log);
  pruneStalePackages(dir, sha, log);
  line(log)("installing dependencies...");
  await run("pnpm", ["install", ...INSTALL_ARGS], dir, log);
  line(log)("building...");
  await run("pnpm", ["build"], dir, log);
  verifyPayload(dir);
}

/**
 * Make sure `dir` is a payload clone of `repoRoot` at `sha`, cloning it on
 * first use and fetching otherwise. Returns nothing; throws if the sha can't
 * be reached.
 */
export async function prepareClone(dir, repoRoot, sha, log = defaultLog) {
  if (!existsSync(join(dir, ".git"))) {
    line(log)(`cloning payload into ${dir}...`);
    await run("git", ["clone", "--no-checkout", repoRoot, dir], undefined, log);
  } else {
    await ensureOrigin(dir, repoRoot, log);
    line(log)("fetching...");
    await run("git", ["fetch", "--prune", "--tags", "origin"], dir, log);
  }
  assertCommitPresent(dir, sha);
}
