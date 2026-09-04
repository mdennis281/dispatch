#!/usr/bin/env node
/**
 * migrate-config — move every project's Dispatch config OUT of its repo, and
 * clean up what it leaves behind.
 *
 * A project's config dir used to have exactly one home: the repo's committable
 * `.dispatch/`. Since the config-location change it can also live under the
 * install's own `config/projects/<id>/`, which is the default for anything new.
 * But the default is deliberately inert for a repo that already carries a
 * committed `.dispatch/` — silently reading a different directory would strand
 * everything in the old one. So an existing install stays exactly where it was
 * until something moves it. This is that something.
 *
 * Per project it:
 *   1. COPIES the repo config dir into `config/projects/<id>/` (overlay; the
 *      repo copy wins a name collision, because it is the one in use),
 *   2. VERIFIES every file byte-for-byte at the destination,
 *   3. PINS `configLocation: "external"` on the project record, and
 *   4. REMOVES the repo-side dir — `git rm` for tracked files (leaving a STAGED
 *      deletion), a plain unlink for untracked ones.
 *
 * The order is the safety property: nothing is deleted until its copy has been
 * read back and compared. A crash between any two steps leaves a working
 * install, because the resolver prefers a repo config dir that still exists and
 * falls through to the external one only when it doesn't.
 *
 * It never commits. `git rm` stages the deletion and stops; the commit message
 * for "stop tracking 400 memory files" belongs to the human, in whatever form
 * their repo's review process wants it.
 *
 * DRY RUN BY DEFAULT. `--apply` is required to touch anything.
 *
 *   node tools/app/migrate-config.mjs                 # plan only
 *   node tools/app/migrate-config.mjs --apply
 *   node tools/app/migrate-config.mjs --apply --project hivebreak
 *   node tools/app/migrate-config.mjs --apply --keep-repo   # copy, don't clean
 *
 * Run it with the app STOPPED. The server caches every project's resolved
 * config and watches the directory this moves; migrating under a live instance
 * races that cache, and a project saved by the running server afterwards can
 * write back the record this just pinned.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  lstatSync,
} from "node:fs";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, relative, dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { desktopPaths } from "./paths.mjs";
import { portAlive } from "./build-payload.mjs";

/**
 * Ids that may become a path segment — the same allowlist the server Store
 * enforces (`ENTITY_ID` in store/index.ts).
 *
 * This tool builds `config/projects/<rec.id>/` and then DELETES a directory,
 * so a record carrying `../../something` would not merely read the wrong
 * place. The server guards its own writes; a tool that reads those files back
 * and acts on them has to guard them again rather than assume they were only
 * ever written by a guarded version.
 */
const ENTITY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Config dir names in resolution order — mirrors `CONFIG_DIR_NAMES`. */
const CONFIG_DIR_NAMES = [".dispatch", ".claude-manager"];
const MANIFEST_FILE = "project.yaml";
/**
 * Runtime state that shares the EXTERNAL dir but is not config. Never copied
 * from a repo (it cannot be there) and never counted as a scrap — this is the
 * store's own recall telemetry, which lives beside the config by design.
 */
const RUNTIME_SIDECARS = new Set(["memory-stats.json"]);

/* ------------------------------------------------------------------- args */

function parseArgs(argv) {
  const args = { apply: false, keepRepo: false, project: null };
  /**
   * A flag that swallowed a missing value used to leave `undefined`, and on
   * THIS tool the fallbacks are dangerous in both directions: an undefined
   * `--project` means "every project", and an undefined `--config-dir` means
   * "the real install". `--apply --project` (a typo away from a one-project
   * run) would have migrated all eight.
   */
  const value = (flag, i) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) {
      throw new Error(`${flag} needs a value`);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // `pnpm run app:migrate-config -- --apply` forwards the separator itself.
    if (a === "--") continue;
    else if (a === "--apply") args.apply = true;
    else if (a === "--keep-repo") args.keepRepo = true;
    else if (a === "--project") args.project = value(a, ++i);
    else if (a === "--config-dir") args.configDir = value(a, ++i);
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

/* -------------------------------------------------------------------- git */

function git(cwd, args) {
  // `git` is a real executable, so it must NOT get a shell (see `needsShell` in
  // build-payload.mjs for the counterpart rule that `pnpm` must).
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

const isGitRepo = (dir) => git(dir, ["rev-parse", "--git-dir"]).ok;

/** Files under `rel` that git is tracking, repo-relative and forward-slashed. */
function trackedUnder(repo, rel) {
  const r = git(repo, ["ls-files", "-z", "--", rel]);
  if (!r.ok) return [];
  return r.out.split("\0").filter(Boolean);
}

/* --------------------------------------------------------------------- fs */

/**
 * Every entry under `dir`, split into plain FILES and anything else.
 *
 * The "anything else" bucket exists because of a silent data-loss path: a
 * `Dirent` for a symlink is neither `isDirectory()` nor `isFile()`, so an
 * earlier version simply skipped them — they were never copied, never
 * verified, and then deleted by the `rm -r` that cleans up. Collecting them
 * lets the caller REFUSE, which is the only honest answer: a symlink in a
 * config dir could be relative, absolute, cross-device or a Windows junction,
 * and guessing which to follow is how a migration eats the target.
 */
function walk(dir, base = dir) {
  if (!existsSync(dir)) return { files: [], odd: [] };
  const files = [];
  const odd = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = relative(base, abs).split("\\").join("/");
    if (entry.isSymbolicLink()) odd.push(`${rel} (symlink)`);
    else if (entry.isDirectory()) {
      const sub = walk(abs, base);
      files.push(...sub.files);
      odd.push(...sub.odd);
    } else if (entry.isFile()) files.push(rel);
    else odd.push(`${rel} (not a regular file)`);
  }
  return { files, odd };
}

/** The repo's committed config dir (one holding a manifest), or null. */
function findRepoConfigDir(repoPath) {
  // Absolute only. A relative `repoPath` would resolve against THIS process's
  // working directory, which is a checkout of Dispatch — see `isUsableRepoPath`.
  if (!repoPath || !isAbsolute(repoPath) || !existsSync(repoPath)) return null;
  for (const name of CONFIG_DIR_NAMES) {
    const dir = join(repoPath, name);
    if (existsSync(join(dir, MANIFEST_FILE))) return dir;
  }
  return null;
}

/* ------------------------------------------------------------------- plan */

function loadProjects(configDir, only) {
  const dir = join(configDir, "projects");
  if (!existsSync(dir)) throw new Error(`no projects dir at ${dir}`);
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    let rec;
    try {
      rec = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      out.push({ file, broken: String(err) });
      continue;
    }
    // A file whose name is not an id, or a record whose `id` is not one, is
    // not a project this tool will act on. `listProjects` in the Store
    // tolerates strays the same way — by skipping them, not by failing the
    // whole run, because one bad file should not block seven good ones.
    const stem = name.slice(0, -".json".length);
    if (!ENTITY_ID.test(stem) || rec.id !== stem) {
      out.push({ file, stray: rec.id === stem ? "id is not a valid path segment" : `id "${rec.id}" does not match filename "${stem}"` });
      continue;
    }
    if (only && rec.id !== only && rec.name !== only) continue;
    out.push({ file, rec });
  }
  return out;
}

function planFor(configDir, entry) {
  const { rec } = entry;
  const repoPath = (rec.repoPath ?? "").split("\\").join("/");
  const external = join(configDir, "projects", rec.id);
  const plan = {
    id: rec.id,
    name: rec.name,
    // Forward-slashed and used for EVERY subsequent path operation. git
    // accepts forward slashes on Windows, and a single normalized form
    // avoids the class of bug where one call site re-derives a separator
    // the other did not (a stored record can hold either).
    repoPath,
    file: entry.file,
    external,
    skip: null,
    files: [],
    tracked: [],
    untracked: [],
    collisions: [],
    dirty: [],
  };

  if (rec.configLocation === "external") {
    plan.skip = "already pinned external";
    return plan;
  }
  const repoDir = findRepoConfigDir(repoPath);
  if (!repoDir) {
    plan.skip = rec.repoPath
      ? "no config dir in the repo (already resolves external)"
      : "no repoPath";
    return plan;
  }
  // The DESTINATION has to be a real directory, for the same reason the source
  // must contain no links — and this is the half I missed first time round.
  // `config/projects/<id>` existing as a symlink or junction means `copyTree`
  // writes THROUGH it, outside the config root; existing as a regular file
  // means `mkdirSync` throws and takes the whole run down with it.
  if (existsSync(external)) {
    const st = lstatSync(external);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      plan.skip = `${external} is not a real directory (${
        st.isSymbolicLink() ? "symlink" : "not a directory"
      }) — refusing to write through it`;
      return plan;
    }
  }
  plan.repoDir = repoDir;
  plan.dirName = repoDir.split("\\").join("/").split("/").pop();
  const walked = walk(repoDir);
  plan.odd = walked.odd;
  if (plan.odd.length) {
    // Refuse the whole project rather than migrate part of it. Cleanup deletes
    // the directory wholesale, so anything this cannot copy would be lost.
    plan.skip = `contains ${plan.odd.length} entry/entries this will not copy: ${plan.odd.join(", ")}`;
    return plan;
  }
  plan.files = walked.files.filter((f) => !RUNTIME_SIDECARS.has(f));
  plan.collisions = plan.files.filter((f) => existsSync(join(external, f)));

  if (isGitRepo(repoPath)) {
    plan.isGit = true;
    const tracked = new Set(
      trackedUnder(repoPath, plan.dirName).map((p) => p.slice(plan.dirName.length + 1)),
    );
    plan.tracked = plan.files.filter((f) => tracked.has(f));
    plan.untracked = plan.files.filter((f) => !tracked.has(f));
    const st = git(repoPath, ["status", "--porcelain", "--", plan.dirName]);
    plan.dirty = st.ok ? st.out.split("\n").filter(Boolean) : [];
  } else {
    plan.untracked = plan.files;
  }
  return plan;
}

/* ------------------------------------------------------------------ apply */

async function copyTree(plan) {
  for (const rel of plan.files) {
    const src = join(plan.repoDir, rel);
    const dest = join(plan.external, rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, await readFile(src));
  }
}

/**
 * Read every copied file back and compare bytes. This is what makes the delete
 * that follows safe to run unattended: "the copy loop didn't throw" is a weaker
 * claim than "the destination now holds these exact bytes", and the difference
 * is somebody's 400 memories.
 */
async function verifyTree(plan) {
  const bad = [];
  for (const rel of plan.files) {
    const src = await readFile(join(plan.repoDir, rel));
    let dest;
    try {
      dest = await readFile(join(plan.external, rel));
    } catch {
      bad.push(rel);
      continue;
    }
    if (!src.equals(dest)) bad.push(rel);
  }
  return bad;
}

function pinExternal(plan) {
  const rec = JSON.parse(readFileSync(plan.file, "utf8"));
  rec.configLocation = "external";
  // Match the store's own formatting so the file doesn't churn on next write.
  writeFileSync(plan.file, `${JSON.stringify(rec, null, 2)}\n`, "utf8");
}

/**
 * Remove the repo-side dir. Tracked files go through `git rm` so the deletion is
 * STAGED and the human commits it; untracked ones are just unlinked, because
 * git has nothing to say about them.
 */
async function cleanupRepo(plan) {
  const notes = [];
  if (plan.tracked.length) {
    // `-f` because a tracked file may be modified — we already copied it, so the
    // content is safe, and refusing here would strand the migration half-done.
    const r = git(plan.repoPath, [
      "rm",
      "-r",
      "-f",
      "--quiet",
      "--",
      plan.dirName,
    ]);
    if (!r.ok) return { ok: false, error: r.err || "git rm failed" };
    notes.push(`git rm staged ${plan.tracked.length} tracked file(s)`);
  }
  // Whatever git didn't remove (untracked files, and the dir itself).
  if (existsSync(plan.repoDir)) {
    await rm(plan.repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    notes.push(`removed ${plan.untracked.length} untracked file(s) + the directory`);
  }
  return { ok: true, notes };
}

/* ------------------------------------------------------------------- main */

async function assertAppStopped(paths) {
  if (!existsSync(paths.runtime)) return;
  let rt;
  try {
    rt = JSON.parse(readFileSync(paths.runtime, "utf8"));
  } catch {
    return; // unreadable => stale
  }
  if (rt.port && (await portAlive(rt.port))) {
    throw new Error(
      `Dispatch is running (pid ${rt.pid}, ${rt.url}).\n` +
        `  Stop it first:  pnpm app:stop\n` +
        `  The server caches each project's resolved config and watches the\n` +
        `  directory this moves — and a project it saves afterwards would write\n` +
        `  back over the record this pins.`,
    );
  }
}

function describe(plan) {
  if (plan.skip) {
    console.log(`  - ${plan.name} — SKIP: ${plan.skip}`);
    return;
  }
  const mem = plan.files.filter((f) => f.startsWith("memory/")).length;
  console.log(`  - ${plan.name}  [${plan.id}]`);
  console.log(`      from   ${plan.repoDir}`);
  console.log(`      to     ${plan.external}`);
  console.log(
    `      files  ${plan.files.length} (${mem} memories)` +
      `  tracked=${plan.tracked.length} untracked=${plan.untracked.length}`,
  );
  if (plan.collisions.length) {
    console.log(
      `      note   ${plan.collisions.length} file(s) already exist externally and` +
        ` will be OVERWRITTEN by the repo copy (the one in use)`,
    );
  }
  if (plan.dirty.length) {
    console.log(`      note   ${plan.dirty.length} uncommitted change(s) here — copied first, then removed`);
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const paths = desktopPaths(env);
  const configDir = args.configDir ?? env.DISPATCH_CONFIG_DIR ?? paths.configDir;

  console.log(`config dir: ${configDir}`);
  console.log(args.apply ? "mode: APPLY\n" : "mode: DRY RUN (pass --apply to execute)\n");

  const entries = loadProjects(configDir, args.project);
  for (const b of entries.filter((e) => e.broken)) {
    console.log(`  ! unreadable project record, skipped: ${b.file} (${b.broken})`);
  }
  for (const st of entries.filter((e) => e.stray)) {
    console.log(`  ! not a project record, skipped: ${st.file} (${st.stray})`);
  }

  const plans = entries.filter((e) => e.rec).map((e) => planFor(configDir, e));
  const todo = plans.filter((p) => !p.skip);

  console.log("Projects:");
  for (const p of plans) describe(p);
  console.log();

  if (!todo.length) {
    console.log("Nothing to migrate.");
    return { migrated: [], skipped: plans.filter((p) => p.skip).length };
  }

  const totalFiles = todo.reduce((n, p) => n + p.files.length, 0);
  const totalTracked = todo.reduce((n, p) => n + p.tracked.length, 0);
  console.log(
    `${todo.length} project(s), ${totalFiles} file(s), ${totalTracked} tracked ` +
      `(a staged deletion you commit yourself).`,
  );

  if (!args.apply) {
    console.log("\nDry run — nothing was changed. Re-run with --apply.");
    return { migrated: [], planned: todo.length };
  }

  await assertAppStopped(paths);

  const migrated = [];
  for (const plan of todo) {
    console.log(`\n${plan.name}:`);
    mkdirSync(plan.external, { recursive: true });
    await copyTree(plan);
    const bad = await verifyTree(plan);
    if (bad.length) {
      console.log(`  ! copy did NOT verify (${bad.length} file(s)) — leaving the repo dir alone`);
      for (const f of bad.slice(0, 5)) console.log(`      ${f}`);
      continue;
    }
    console.log(`  copied + verified ${plan.files.length} file(s)`);
    pinExternal(plan);
    console.log(`  pinned configLocation: "external"`);

    if (args.keepRepo) {
      console.log("  --keep-repo: repo dir left in place");
    } else {
      const cleaned = await cleanupRepo(plan);
      if (!cleaned.ok) {
        console.log(`  ! cleanup failed: ${cleaned.error}`);
        console.log(`    the config is migrated and live; remove ${plan.repoDir} by hand.`);
      } else {
        for (const n of cleaned.notes) console.log(`  ${n}`);
      }
    }
    migrated.push(plan);
  }

  const staged = migrated.filter((p) => !args.keepRepo && p.tracked.length);
  if (staged.length) {
    console.log("\nStaged deletions to commit (nothing was committed for you):");
    for (const p of staged) {
      console.log(`  ${p.repoPath}`);
      console.log(`    git commit -m "chore: move Dispatch config out of the repo"`);
    }
  }
  console.log(`\nDone. ${migrated.length} project(s) migrated.`);
  return { migrated: migrated.map((p) => p.id) };
}

// Only run when invoked directly, so the tests can import `main` instead.
// `pathToFileURL` rather than string-building the URL: on Windows
// `import.meta.url` is `file:///C:/...` (three slashes, drive letter) and a
// hand-rolled `file://` + path never matches, so the CLI silently did
// nothing when run directly.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  });
}
