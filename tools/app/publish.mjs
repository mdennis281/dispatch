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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopPaths } from "./paths.mjs";
import {
  assertAppStopped,
  assertNodeVersion,
  buildInto,
  capture,
  prepareClone,
} from "./build-payload.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

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

  // Guarded: a `current.json` truncated by a power loss mid-write would
  // otherwise throw here, and this only feeds the rollback target.
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(paths.stamp, "utf8")).sha ?? null;
  } catch {
    /* absent or unreadable — there is no previous sha to roll back to */
  }

  if (args.dryRun) {
    console.log(
      `--dry-run: would publish ${sha.slice(0, 12)} ` +
        `(previous: ${previous?.slice(0, 12) ?? "none"})`,
    );
    return;
  }

  mkdirSync(paths.root, { recursive: true });

  const fresh = !existsSync(join(paths.app, ".git"));
  await prepareClone(paths.app, repoRoot, sha);

  const build = (target) => buildInto(paths.app, target);

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
