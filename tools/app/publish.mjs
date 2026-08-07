#!/usr/bin/env node
/**
 * Install or update the stable payload that the launcher runs.
 *
 * ── Why the payload is a git clone, not a copied build ──────────────────────
 * The server resolves the SPA at `packages/server/dist/../../client/dist`, so
 * the payload has to preserve the workspace layout — which rules out
 * `pnpm deploy`'s flattening. And copying a pnpm `node_modules` on Windows means
 * copying a forest of junctions. Cloning the repo and building in place sidesteps
 * both: pnpm's content-addressed store makes the install nearly free (hardlinks),
 * and the payload is byte-for-byte a real checkout.
 *
 * Safety properties:
 *   - REFUSES to run while the app is up (see runtime.json, written by
 *     launch.py). Swapping the payload under a running agent loses a long task.
 *   - Publishes a COMMITTED sha. A dirty dev tree is reported, never silently
 *     included — "stable" that can't be reproduced from git isn't stable.
 *   - VERIFIES the built payload before stamping it. A build step that exits 0
 *     without emitting `dist` is not a successful publish, and the rollback
 *     path in particular cannot be trusted to fail loudly on its own: its
 *     `pnpm install` runs against a node_modules the failed attempt already
 *     populated, so it reports "Already up to date" and silently skips the very
 *     check that just failed.
 *   - On failure, rolls the payload back to the previous sha, rebuilds, and
 *     RE-PRINTS THE ORIGINAL ERROR LAST. The rollback emits a full successful
 *     build — a hundred lines of green — which otherwise scrolls the real error
 *     out of view and reads like a success that somehow exited 1. Whatever is
 *     on screen at the end is what gets debugged.
 *
 * Usage:
 *   node tools/app/publish.mjs [--ref <git-ref>] [--target <root>] [--dry-run]
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopPaths } from "./paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

/** Node the payload must be buildable by — mirrors the root package.json engines. */
const MIN_NODE_MAJOR = 20;

function parseArgs(argv) {
  const args = { ref: "HEAD", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // `pnpm run app:publish -- --dry-run` forwards the separator itself, so a
    // bare `--` has to be tolerated rather than rejected as an unknown flag.
    if (a === "--") continue;
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--ref") args.ref = argv[++i];
    else if (a === "--target") args.target = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

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

/** How many trailing output lines to quote back when a step fails. */
const TAIL_LINES = 40;

class StepError extends Error {
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
 */
function run(cmd, cmdArgs, cwd) {
  const label = `${cmd} ${cmdArgs.join(" ")}`;
  console.log(`  $ ${label}`);
  return new Promise((res, rej) => {
    const child = spawn(cmd, cmdArgs, { cwd, shell: needsShell(cmd) });
    const tail = [];
    let pending = "";

    const absorb = (buf, sink) => {
      const text = String(buf);
      sink.write(text);
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        tail.push(line);
        if (tail.length > TAIL_LINES) tail.shift();
      }
    };

    child.stdout.on("data", (b) => absorb(b, process.stdout));
    child.stderr.on("data", (b) => absorb(b, process.stderr));
    child.on("error", (err) => rej(new StepError(label, -1, [err.message])));
    child.on("close", (code) => {
      if (pending) tail.push(pending);
      if (code === 0) res();
      else rej(new StepError(label, code, tail));
    });
  });
}

function capture(cmd, cmdArgs, cwd) {
  return execFileSync(cmd, cmdArgs, {
    cwd,
    encoding: "utf8",
    shell: needsShell(cmd),
  }).trim();
}

/** Same, but a non-zero exit is an answer rather than an exception. */
function tryCapture(cmd, cmdArgs, cwd) {
  try {
    return capture(cmd, cmdArgs, cwd);
  } catch {
    return null;
  }
}

/** Can we open a TCP connection to this port? (i.e. is the app really up) */
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

/**
 * Refuse to publish under a live app. `runtime.json` can be stale (a hard crash
 * never cleans it up), so confirm with an actual connection before blocking.
 */
async function assertAppStopped(paths) {
  if (!existsSync(paths.runtime)) return;
  let rt;
  try {
    rt = JSON.parse(readFileSync(paths.runtime, "utf8"));
  } catch {
    return; // unreadable => treat as stale
  }
  if (rt.port && (await portAlive(rt.port))) {
    throw new Error(
      `Dispatch is running (pid ${rt.pid}, ${rt.url}).\n` +
        `  Stop it first:  pnpm app:stop\n` +
        `  That runs the server's own teardown — stopping agents and subApps\n` +
        `  cleanly. Killing the process does not.`,
    );
  }
  console.log("note: stale runtime.json (app not reachable) — continuing.\n");
}

function assertNodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    throw new Error(
      `Node ${process.versions.node} is too old to build the payload ` +
        `(need >= ${MIN_NODE_MAJOR}).`,
    );
  }
}

/**
 * Point the payload's `origin` back at this checkout before fetching.
 *
 * The clone recorded whatever path the repo had at first install. Move or
 * rename the checkout and every later publish fetches from a directory that no
 * longer exists — with an error that says nothing about the cause.
 */
function ensureOrigin(appDir) {
  const current = tryCapture("git", ["remote", "get-url", "origin"], appDir);
  if (current === null) {
    run("git", ["remote", "add", "origin", repoRoot], appDir);
    return;
  }
  if (resolve(current) !== resolve(repoRoot)) {
    console.log(`origin moved: ${current}\n     -> ${repoRoot}`);
    execFileSync("git", ["remote", "set-url", "origin", repoRoot], { cwd: appDir });
  }
}

/**
 * A commit only reachable from a local branch that was never fetched — or from
 * no branch at all — cannot be checked out in the payload. Catch it here, where
 * we can say what to do, rather than at `git checkout` with a bare "reference is
 * not a tree".
 */
function assertCommitPresent(appDir, sha) {
  if (tryCapture("git", ["cat-file", "-e", `${sha}^{commit}`], appDir) !== null) return;
  throw new Error(
    `commit ${sha.slice(0, 12)} isn't reachable in the payload clone.\n` +
      `  It exists in your checkout but on no branch that was fetched — commit it\n` +
      `  to a branch (or push that branch) and re-run.`,
  );
}

/**
 * Prove the payload can actually serve before we call it published.
 *
 * Every one of these is something a "successful" build has failed to produce
 * before: a tsc that skipped emit because a stale tsbuildinfo said it was up to
 * date, a vite build whose output went somewhere else, an install that no-opped.
 */
function verifyPayload(appDir) {
  const required = [
    ["server entry", join(appDir, "packages", "server", "dist", "index.js")],
    ["SPA shell", join(appDir, "packages", "client", "dist", "index.html")],
    ["PWA manifest", join(appDir, "packages", "client", "dist", "manifest.webmanifest")],
    ["service worker", join(appDir, "packages", "client", "dist", "sw.js")],
    ["app icon", join(appDir, "packages", "client", "dist", "icons", "favicon.ico")],
    ["launcher", join(appDir, "tools", "app", "launch.py")],
  ];
  const missing = required.filter(([, p]) => !existsSync(p));
  if (missing.length) {
    throw new Error(
      `the build exited 0 but the payload is incomplete:\n` +
        missing.map(([what, p]) => `  missing ${what}: ${p}`).join("\n"),
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = desktopPaths(
    args.target ? { ...process.env, DISPATCH_HOME: args.target } : process.env,
  );

  assertNodeVersion();

  const sha = capture("git", ["rev-parse", args.ref], repoRoot);
  const subject = capture("git", ["log", "-1", "--format=%s", sha], repoRoot);
  const dirty = capture("git", ["status", "--porcelain"], repoRoot);

  console.log(`source : ${repoRoot}`);
  console.log(`payload: ${paths.app}`);
  console.log(`ref    : ${args.ref} -> ${sha.slice(0, 12)}  "${subject}"\n`);

  if (dirty) {
    const n = dirty.split("\n").filter(Boolean).length;
    console.log(
      `WARNING: ${n} uncommitted change(s) in the dev checkout.\n` +
        `  Publishing the COMMITTED sha above — those changes are NOT included.\n` +
        `  Commit them first if you meant to ship them.\n`,
    );
  }

  await assertAppStopped(paths);

  const previous = existsSync(paths.stamp)
    ? (JSON.parse(readFileSync(paths.stamp, "utf8")).sha ?? null)
    : null;

  if (args.dryRun) {
    console.log(
      `--dry-run: would publish ${sha.slice(0, 12)} ` +
        `(previous: ${previous?.slice(0, 12) ?? "none"})`,
    );
    return;
  }

  mkdirSync(paths.root, { recursive: true });

  const fresh = !existsSync(join(paths.app, ".git"));
  if (fresh) {
    console.log("cloning payload (first install)...");
    await run("git", ["clone", "--no-checkout", repoRoot, paths.app], paths.root);
  } else {
    ensureOrigin(paths.app);
    console.log("fetching...");
    await run("git", ["fetch", "--prune", "--tags", "origin"], paths.app);
  }
  assertCommitPresent(paths.app, sha);

  const build = async (target) => {
    await run("git", ["checkout", "--force", target], paths.app);
    // A leftover file from the previous sha (a renamed module, a dropped asset)
    // is invisible to git and can satisfy an import that should have broken.
    await run("git", ["clean", "-fdx", "-e", "node_modules"], paths.app);
    console.log("installing dependencies...");
    await run("pnpm", ["install", "--frozen-lockfile"], paths.app);
    console.log("building...");
    await run("pnpm", ["build"], paths.app);
    verifyPayload(paths.app);
  };

  try {
    await build(sha);
  } catch (err) {
    console.error(`\n${"-".repeat(72)}`);
    console.error(`PUBLISH FAILED: ${err.message}`);
    if (previous && !fresh) {
      console.error(`\nrolling back to ${previous.slice(0, 12)}...`);
      try {
        await build(previous);
        console.error("\nrollback OK — the previous build is still installed.");
      } catch (rollbackErr) {
        console.error(`\nROLLBACK ALSO FAILED: ${rollbackErr.message}`);
        console.error(`The payload at ${paths.app} may be unusable; re-run once fixed.`);
      }
    }
    // Last, deliberately: the rollback above just printed a full successful
    // build, and without this the real error is a hundred lines up.
    console.error(`\n${"=".repeat(72)}`);
    console.error(`PUBLISH FAILED — ${err.message}`);
    if (err.tail?.length) {
      console.error(`\nLast ${err.tail.length} lines before the failure:\n`);
      for (const line of err.tail) console.error(`  | ${line}`);
    }
    console.error(`${"=".repeat(72)}`);
    console.error(`\nNothing was published. The payload is at ${previous?.slice(0, 12) ?? "its previous state"}.`);
    process.exitCode = 1;
    return;
  }

  writeFileSync(
    paths.stamp,
    JSON.stringify(
      { sha, subject, ref: args.ref, publishedAt: new Date().toISOString(), previous },
      null,
      2,
    ),
  );

  console.log(`\npublished ${sha.slice(0, 12)}  "${subject}"`);
  console.log(`  payload: ${paths.app}`);
  console.log(`  data   : ${paths.dataDir}`);
  console.log(`  config : ${paths.configDir}`);
  console.log(`\nStart it from the Start menu shortcut, or \`pnpm app\`.`);
}

main().catch((err) => {
  console.error(`\npublish failed: ${err.message}`);
  process.exitCode = 1;
});
