#!/usr/bin/env node
/**
 * Migrate a single-root `.data` store into the desktop deployment's split
 * layout (`data/` + `config/`).
 *
 * Safety is the whole point of this script, so it is deliberately paranoid:
 *   - COPIES. The source `.data` is never modified, moved, or deleted; if
 *     anything here is wrong you still have the original.
 *   - VERIFIES every copied file by SHA-256, not just size — and exits non-zero
 *     on the first mismatch. ~500 MB hashes in a couple of seconds, which is
 *     nothing against the cost of silently losing a transcript.
 *   - REFUSES a non-empty destination unless `--force`, so re-running it can't
 *     quietly clobber a store that has since moved on.
 *   - Files it doesn't recognise are copied into `data/` and reported, rather
 *     than skipped.
 *
 * Usage:
 *   node tools/desktop/migrate-data.mjs [--source <dir>] [--target <root>]
 *                                       [--dry-run] [--force]
 */
import { readdir, mkdir, cp, stat, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { desktopPaths, CONFIG_ENTRIES, STATE_ENTRIES } from "./paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const args = { dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--force") args.force = true;
    else if (a === "--source") args.source = argv[++i];
    else if (a === "--target") args.target = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

/* ------------------------------------------------------------- fs helpers */

async function hashFile(path) {
  const buf = await readFile(path);
  return { size: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex") };
}

/**
 * Map a path to `relative path -> { size, sha256 }`. Accepts a FILE as well as a
 * directory — top-level entries like `checkpoints.json` are plain files, and a
 * single-file root fingerprints as the empty-string key.
 */
async function fingerprint(dir, base = dir, out = new Map()) {
  if (!existsSync(dir)) return out;
  if ((await stat(dir)).isFile()) {
    out.set(relative(base, dir).replace(/\\/g, "/"), await hashFile(dir));
    return out;
  }
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await fingerprint(abs, base, out);
    } else if (entry.isFile()) {
      out.set(relative(base, abs).replace(/\\/g, "/"), await hashFile(abs));
    }
  }
  return out;
}

async function isNonEmptyDir(dir) {
  if (!existsSync(dir)) return false;
  return (await readdir(dir)).length > 0;
}

function human(bytes) {
  const u = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/* ------------------------------------------------------------------- main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = resolve(args.source ?? join(repoRoot, ".data"));
  const paths = desktopPaths(args.target ? { ...process.env, CM_HOME: args.target } : process.env);

  console.log(`source : ${source}`);
  console.log(`target : ${paths.root}`);
  console.log(`  data   -> ${paths.dataDir}`);
  console.log(`  config -> ${paths.configDir}\n`);

  if (!existsSync(source)) throw new Error(`source does not exist: ${source}`);

  // Classify every top-level entry. Unknown names go to state — misfiled beats lost.
  const entries = await readdir(source, { withFileTypes: true });
  const plan = [];
  const unknown = [];
  for (const e of entries) {
    if (e.name.endsWith(".tmp")) continue; // in-flight atomic write; not real state
    const isConfig = CONFIG_ENTRIES.includes(e.name);
    const isState = STATE_ENTRIES.includes(e.name);
    if (!isConfig && !isState) unknown.push(e.name);
    plan.push({ name: e.name, dest: isConfig ? paths.configDir : paths.dataDir });
  }

  if (unknown.length) {
    console.log(`note: unrecognised entries copied to data/ (nothing dropped):`);
    for (const n of unknown) console.log(`  - ${n}`);
    console.log("");
  }

  // Size the job, and show the chat count so the user can sanity-check it.
  let totalBytes = 0;
  let totalFiles = 0;
  for (const p of plan) {
    const fp = await fingerprint(join(source, p.name));
    totalFiles += fp.size;
    for (const v of fp.values()) totalBytes += v.size;
  }
  const chatsDir = join(source, "chats");
  const chatCount = existsSync(chatsDir)
    ? (await readdir(chatsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).length
    : 0;
  console.log(`${totalFiles} files, ${human(totalBytes)}, ${chatCount} chats\n`);

  for (const dest of [paths.dataDir, paths.configDir]) {
    if ((await isNonEmptyDir(dest)) && !args.force) {
      throw new Error(
        `destination is not empty: ${dest}\n` +
          `  Re-run with --force ONLY if you mean to overwrite it. ` +
          `The source at ${source} is never touched either way.`,
      );
    }
  }

  if (args.dryRun) {
    console.log("--dry-run: nothing written.");
    for (const p of plan) console.log(`  would copy ${p.name} -> ${p.dest}`);
    return;
  }

  await mkdir(paths.dataDir, { recursive: true });
  await mkdir(paths.configDir, { recursive: true });

  for (const p of plan) {
    const from = join(source, p.name);
    const to = join(p.dest, p.name);
    process.stdout.write(`copying ${p.name} ... `);
    await cp(from, to, { recursive: true, force: true, errorOnExist: false });
    console.log("done");
  }

  // ---- verify: every source file must exist at the destination, byte-identical.
  console.log("\nverifying (sha256)...");
  let checked = 0;
  const problems = [];
  for (const p of plan) {
    const src = await fingerprint(join(source, p.name));
    const dst = await fingerprint(join(p.dest, p.name));
    for (const [rel, want] of src) {
      const got = dst.get(rel);
      if (!got) problems.push(`MISSING  ${p.name}/${rel}`);
      else if (got.sha256 !== want.sha256)
        problems.push(`MISMATCH ${p.name}/${rel} (${want.size} vs ${got.size} bytes)`);
      checked++;
    }
  }

  if (problems.length) {
    console.error(`\nFAILED — ${problems.length} problem(s):`);
    for (const p of problems.slice(0, 20)) console.error(`  ${p}`);
    if (problems.length > 20) console.error(`  ... and ${problems.length - 20} more`);
    console.error(`\nYour original store at ${source} is untouched.`);
    process.exitCode = 1;
    return;
  }

  console.log(`OK — ${checked} files verified byte-identical.`);
  console.log(`\nOriginal left in place at ${source} (delete it yourself once happy).`);
}

main().catch((err) => {
  console.error(`\nmigrate-data failed: ${err.message}`);
  process.exitCode = 1;
});
