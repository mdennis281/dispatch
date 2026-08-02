#!/usr/bin/env node
/**
 * Install or update the stable payload the desktop shell runs.
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
 *   - REFUSES to run while the desktop app is up (see runtime.json). Swapping the
 *     payload under a running agent is how you lose a long task.
 *   - Publishes a COMMITTED sha. A dirty dev tree is reported, never silently
 *     included — "stable" that can't be reproduced from git isn't stable.
 *   - On a failed install/build, rolls the payload back to the previous sha and
 *     rebuilds it, so a broken publish never leaves you without a working app.
 *
 * Usage:
 *   node tools/desktop/publish.mjs [--ref <git-ref>] [--target <root>] [--dry-run]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopPaths } from "./paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

function parseArgs(argv) {
  const args = { ref: "HEAD", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--ref") args.ref = argv[++i];
    else if (a === "--target") args.target = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

/**
 * `pnpm` is a `.cmd` shim on Windows, and since the CVE-2024-27980 fix Node
 * refuses to `execFile` a `.cmd` without a shell (EINVAL). So pnpm — and only
 * pnpm — gets `shell: true`; `git` is a real executable and runs without one.
 *
 * The DEP0190 warning that pairs with `shell: true` is about args being
 * concatenated rather than escaped. Every pnpm invocation here passes fixed
 * literals (`install --frozen-lockfile`, `build`) with nothing user-supplied, so
 * there's no injection surface — but keep it that way if you add arguments.
 */
const needsShell = (cmd) => process.platform === "win32" && cmd === "pnpm";

/** Run a command, streaming output; throws on non-zero exit. */
function run(cmd, cmdArgs, cwd) {
  console.log(`  $ ${cmd} ${cmdArgs.join(" ")}`);
  execFileSync(cmd, cmdArgs, { cwd, stdio: "inherit", shell: needsShell(cmd) });
}

function capture(cmd, cmdArgs, cwd) {
  return execFileSync(cmd, cmdArgs, { cwd, encoding: "utf8", shell: needsShell(cmd) }).trim();
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
      `the claude-manager desktop app is running (pid ${rt.pid}, ${rt.url}).\n` +
        `  Quit it from the tray ("Quit (stops all agents & subApps)") and re-run.\n` +
        `  Quitting there stops agents and subApps cleanly; killing it does not.`,
    );
  }
  console.log("note: stale runtime.json (app not reachable) — continuing.\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = desktopPaths(args.target ? { ...process.env, CM_HOME: args.target } : process.env);

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
    console.log(`--dry-run: would publish ${sha.slice(0, 12)} (previous: ${previous?.slice(0, 12) ?? "none"})`);
    return;
  }

  mkdirSync(paths.root, { recursive: true });

  const fresh = !existsSync(join(paths.app, ".git"));
  if (fresh) {
    console.log("cloning payload (first install)...");
    run("git", ["clone", "--no-checkout", repoRoot, paths.app], paths.root);
  } else {
    console.log("fetching...");
    run("git", ["fetch", "--prune", "origin"], paths.app);
  }

  const build = (target) => {
    run("git", ["checkout", "--force", target], paths.app);
    console.log("installing dependencies...");
    run("pnpm", ["install", "--frozen-lockfile"], paths.app);
    console.log("building...");
    run("pnpm", ["build"], paths.app);
  };

  try {
    build(sha);
  } catch (err) {
    console.error(`\nbuild FAILED: ${err.message}`);
    if (previous && !fresh) {
      console.error(`rolling back to ${previous.slice(0, 12)}...`);
      try {
        build(previous);
        console.error("rollback OK — the previous build is still installed.");
      } catch (rollbackErr) {
        console.error(`ROLLBACK ALSO FAILED: ${rollbackErr.message}`);
        console.error(`The payload at ${paths.app} may be unusable; re-run once fixed.`);
      }
    }
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
  console.log(`\nStart it from the Start menu shortcut, or \`pnpm desktop\`.`);
}

main().catch((err) => {
  console.error(`\npublish failed: ${err.message}`);
  process.exitCode = 1;
});
