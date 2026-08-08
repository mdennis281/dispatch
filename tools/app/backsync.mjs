#!/usr/bin/env node
/**
 * Backsync chat transcripts from the INSTALLED (stable) instance into this
 * checkout's `.data`, so the dev instance can read the conversations that
 * actually happened on the one you trust with long runs.
 *
 * ── Why this can't just be a directory copy ─────────────────────────────────
 * The two instances keep separate state roots on purpose (see RUNNING.md and
 * `packages/server/src/store/index.ts`): `runners.json` and `checkpoints.json`
 * are whole-file read-modify-write maps guarded by an IN-PROCESS mutex, so two
 * processes sharing them silently drop each other's writes. That split is what
 * keeps a dev crash from costing the stable instance its rollback points, and
 * this tool must not quietly undo it. So:
 *
 *   - `chats/` is synced. Transcripts are append-only JSONL under a unique id,
 *     which is the one shape that merges safely.
 *   - `checkpoints.json` is MERGED, never copied — dev's own entries are
 *     preserved and prod's are added only for chats dev doesn't already have.
 *   - `runners.json` is NEVER touched. It is a list of live pids and bound
 *     ports belonging to another process; importing it would point this
 *     instance's reaper at processes it doesn't own.
 *   - `config/` is already shared between the instances. Nothing to sync.
 *
 * ── The conflict rule: fast-forward only ────────────────────────────────────
 * A chat id present on both sides is only overwritten when prod's transcript is
 * a strict EXTENSION of dev's — same bytes for the whole length dev has, then
 * more. That is what an append-only log looks like when one side simply ran
 * longer, and it is the only case where taking prod's copy provably loses
 * nothing. Anything else is a genuine divergence (the same chat continued
 * differently on both instances) and is reported and skipped, so a sync can
 * never eat a message you sent on this side. `--force` overrides, after saying
 * exactly what it would overwrite.
 *
 * Direction is prod -> dev, always. The stable instance is never written to.
 *
 * Usage:
 *   node tools/app/backsync.mjs [--from <dataDir>] [--to <dataDir>]
 *                               [--target <root>] [--dry-run] [--force]
 *                               [--limit <n>] [--quiet]
 */
import {
  readdir,
  mkdir,
  cp,
  open,
  readFile,
  writeFile,
  stat,
  rm,
  rmdir,
  rename,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopPaths } from "./paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

/* ------------------------------------------------------------------ args */

/**
 * A flag that takes a value must actually get one. `--to` with nothing after it
 * used to leave `args.to` undefined and fall through to the default dev dir —
 * i.e. silently sync somewhere other than where you pointed it.
 */
function need(value, flag) {
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

function parseArgs(argv) {
  const args = { dryRun: false, force: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // `pnpm run app:backsync -- --dry-run` forwards the separator itself.
    if (a === "--") continue;
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--force") args.force = true;
    else if (a === "--quiet") args.quiet = true;
    else if (a === "--from") args.from = need(argv[++i], a);
    else if (a === "--to") args.to = need(argv[++i], a);
    else if (a === "--target") args.target = need(argv[++i], a);
    else if (a === "--limit") args.limit = Number.parseInt(need(argv[++i], a), 10);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (args.limit !== undefined && !(Number.isFinite(args.limit) && args.limit > 0)) {
    throw new Error("--limit needs a positive number");
  }
  return args;
}

/* ------------------------------------------------------------------ util */

function human(bytes) {
  const u = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

/** Directory names under `chats/` — each is one chat id. */
async function listChatIds(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * First `n` bytes of a file. A short read means the file shrank under us, and
 * the caller treats a short buffer as "not equal" — which classifies the chat as
 * diverged and therefore SKIPS it. Erring toward skip is the only safe direction
 * when the source is a live instance still appending.
 */
async function readPrefix(path, n) {
  const buf = Buffer.alloc(n);
  const fh = await open(path, "r");
  try {
    let off = 0;
    while (off < n) {
      const { bytesRead } = await fh.read(buf, off, n - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    return off === n ? buf : buf.subarray(0, off);
  } finally {
    await fh.close();
  }
}

/**
 * Classify one chat that exists on BOTH sides.
 *
 * `same`     — byte-identical transcript; nothing to do.
 * `forward`  — prod strictly extends dev; safe to take prod's copy.
 * `behind`   — dev strictly extends prod (dev kept going); keep dev's.
 * `diverged` — the shared prefix differs; a human has to decide.
 *
 * Compared on raw bytes rather than parsed rows: a transcript row is written
 * once and never rewritten, so byte equality of the prefix is exactly the
 * "these are the same conversation up to here" question, and it costs one
 * buffer compare instead of parsing two 600 KB JSONL files.
 *
 * Only the SHARED prefix is read, never the whole file. The answer depends on
 * min(size) bytes plus the two sizes, and reading both files whole meant pulling
 * ~180 MB through the heap to classify a store that is 93 MB on one side.
 */
async function classify(srcFile, dstFile) {
  const [srcSize, dstSize] = await Promise.all([sizeOf(srcFile), sizeOf(dstFile)]);
  const shared = Math.min(srcSize, dstSize);
  if (shared > 0) {
    // An unreadable side (EBUSY — prod had the file open) becomes an empty
    // buffer, so the compare fails and the chat is reported diverged and
    // skipped. "Couldn't check" must never be allowed to look like "safe".
    const [src, dst] = await Promise.all([
      readPrefix(srcFile, shared).catch(() => Buffer.alloc(0)),
      readPrefix(dstFile, shared).catch(() => Buffer.alloc(0)),
    ]);
    if (!src.equals(dst)) return "diverged";
  }
  if (srcSize === dstSize) return "same";
  return srcSize > dstSize ? "forward" : "behind";
}

/* ------------------------------------------------------------------- main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = desktopPaths(
    args.target ? { ...process.env, DISPATCH_HOME: args.target } : process.env,
  );

  const from = resolve(args.from ?? paths.dataDir);
  const to = resolve(args.to ?? join(repoRoot, ".data"));

  console.log(`from (stable): ${from}`);
  console.log(`to   (dev)   : ${to}\n`);

  // Case-insensitive on Windows: `--to c:\...` and `C:\...` are one directory,
  // and syncing a store onto itself would stash each chat aside and then try to
  // copy it from the hole it just left.
  const same =
    process.platform === "win32" ? from.toLowerCase() === to.toLowerCase() : from === to;
  if (same) {
    throw new Error(`--from and --to are the same directory; nothing to sync`);
  }
  if (!existsSync(from)) {
    throw new Error(
      `no stable data dir at ${from}\n` +
        `  Is the app installed?  pnpm app:publish\n` +
        `  Or point at one:       --from <dir>`,
    );
  }

  const srcChats = join(from, "chats");
  const dstChats = join(to, "chats");

  const srcIds = await listChatIds(srcChats);
  const dstIds = new Set(await listChatIds(dstChats));
  if (srcIds.length === 0) {
    console.log("stable instance has no chats — nothing to sync.");
    return;
  }

  // Plan first, act second: the whole summary is printed before anything is
  // written, so --dry-run and the real run report identically.
  const plan = { new: [], forward: [], same: [], behind: [], diverged: [] };
  for (const id of srcIds) {
    if (!dstIds.has(id)) {
      plan.new.push(id);
      continue;
    }
    const verdict = await classify(
      join(srcChats, id, "messages.jsonl"),
      join(dstChats, id, "messages.jsonl"),
    );
    plan[verdict].push(id);
  }

  // Newest first, so a --limit run brings back the conversations you actually
  // just had rather than an arbitrary slice of the archive.
  const withMtime = async (ids, base) =>
    (
      await Promise.all(
        ids.map(async (id) => ({
          id,
          at: await stat(join(base, id, "messages.jsonl"))
            .then((s) => s.mtimeMs)
            .catch(() => 0),
        })),
      )
    )
      .sort((a, b) => b.at - a.at)
      .map((x) => x.id);

  let copy = [
    ...(await withMtime(plan.new, srcChats)).map((id) => ({ id, why: "new" })),
    ...(await withMtime(plan.forward, srcChats)).map((id) => ({ id, why: "forward" })),
  ];
  if (args.force) {
    copy = copy.concat(
      (await withMtime(plan.diverged, srcChats)).map((id) => ({ id, why: "forced" })),
    );
  }
  if (args.limit !== undefined) copy = copy.slice(0, args.limit);

  let bytes = 0;
  for (const c of copy) bytes += await sizeOf(join(srcChats, c.id, "messages.jsonl"));

  console.log(
    `${srcIds.length} chats on stable, ${dstIds.size} here:\n` +
      `  ${plan.new.length} new` +
      `, ${plan.forward.length} extended on stable` +
      `, ${plan.same.length} identical` +
      `, ${plan.behind.length} ahead here (kept)` +
      `, ${plan.diverged.length} diverged\n`,
  );

  if (plan.diverged.length) {
    console.log(
      `note: ${plan.diverged.length} chat(s) diverged — the same id continued ` +
        `differently on both sides.\n` +
        `  ${args.force ? "OVERWRITING them (--force)." : "Skipping them. Re-run with --force to take stable's copy."}`,
    );
    for (const id of plan.diverged.slice(0, 10)) console.log(`  - ${id}`);
    if (plan.diverged.length > 10) console.log(`  ... and ${plan.diverged.length - 10} more`);
    console.log("");
  }

  if (copy.length === 0) {
    console.log("nothing to copy — already up to date.");
    return;
  }

  console.log(`copying ${copy.length} chat(s), ${human(bytes)}...`);

  if (args.dryRun) {
    for (const c of copy) console.log(`  would copy ${c.id} (${c.why})`);
    console.log("\n--dry-run: nothing written.");
    return;
  }

  await mkdir(dstChats, { recursive: true });
  // Stash root is a SIBLING of chats/, not `<id>.old` next to the chat itself:
  // anything that is a directory under chats/ is a chat id to both this tool and
  // the Store, so a leftover would show up in the sidebar as a phantom chat.
  const stashRoot = join(to, ".backsync-stash");
  await mkdir(stashRoot, { recursive: true });

  const copiedIds = new Set();
  const failures = [];
  for (const c of copy) {
    const src = join(srcChats, c.id);
    const dst = join(dstChats, c.id);
    const stash = join(stashRoot, c.id);
    let stashed = false;
    try {
      // Replace rather than merge INTO an existing chat dir: a stale asset from
      // a diverged copy left behind next to a fresh transcript is a subtler
      // wrong state than either side alone.
      //
      // But rm-then-cp has a window where dev's copy is already deleted and
      // prod's is half written — a crash or a locked file there loses the
      // transcript outright. So the old dir is renamed ASIDE and only deleted
      // once the copy landed; if the copy throws, it goes back.
      if (existsSync(dst)) {
        await rm(stash, { recursive: true, force: true }); // leftover from a killed run
        await rename(dst, stash);
        stashed = true;
      }
      await cp(src, dst, { recursive: true, errorOnExist: false });
      if (stashed) await rm(stash, { recursive: true, force: true });
      copiedIds.add(c.id);
      if (!args.quiet) console.log(`  ${c.why.padEnd(8)} ${c.id}`);
    } catch (err) {
      if (stashed) {
        await rm(dst, { recursive: true, force: true }).catch(() => {});
        await rename(stash, dst).catch(() => {});
      }
      failures.push(`${c.id}: ${err.message}`);
    }
  }
  // Non-recursive on purpose: it only succeeds when the stash is empty, so a dir
  // that still holds the sole copy of a chat (a restore that itself failed) is
  // left on disk to be recovered by hand rather than deleted.
  await rmdir(stashRoot).catch(() => {});

  /* ---- checkpoints: merge, never replace.
   *
   * Dev's map wins on every key it already has — its checkpoints reference
   * commits in THIS checkout, and prod's reference the payload clone's. Only
   * chats dev has no entry for at all can safely take prod's.
   */
  const srcCp = await readJson(join(from, "checkpoints.json"), {});
  const dstCpPath = join(to, "checkpoints.json");

  // NO fallback-to-{} on a parse error here, unlike the source side. An
  // unreadable dev file that silently became `{}` would be merged with prod's
  // handful of entries and written back — replacing every rollback point on this
  // side with a near-empty map. Absent is fine; unreadable is fatal.
  let dstCp;
  try {
    dstCp = existsSync(dstCpPath) ? JSON.parse((await readFile(dstCpPath, "utf8")) || "{}") : {};
  } catch (err) {
    throw new Error(
      `dev checkpoints.json is unreadable (${err.message}).\n` +
        `  Chats were copied; checkpoints were NOT merged.\n` +
        `  Fix or delete ${dstCpPath} and re-run.`,
    );
  }

  let addedCp = 0;
  for (const [chatId, entry] of Object.entries(srcCp)) {
    // Keyed on chats that actually LANDED, not on the ones we planned to copy:
    // a checkpoint pointing at a transcript that failed to copy is a rollback
    // point into a chat this instance can't show.
    if (!copiedIds.has(chatId)) continue;
    if (dstCp[chatId] !== undefined) continue;
    dstCp[chatId] = entry;
    addedCp++;
  }
  if (addedCp > 0) {
    // Atomic: a torn checkpoints.json costs every rollback point on this side.
    // rename, NOT cp — a copy rewrites the destination in place and can tear
    // exactly the same way a direct write would. rename is the swap (libuv uses
    // MoveFileEx with REPLACE_EXISTING on Windows), which is what the server's
    // own `writeJsonAtomic` does for this very file.
    const tmp = `${dstCpPath}.${process.pid}.backsync.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(dstCp, null, 2), "utf8");
      await rename(tmp, dstCpPath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  console.log(
    `\nsynced ${copiedIds.size} chat(s)` +
      (addedCp ? `, ${addedCp} checkpoint set(s)` : "") +
      `. runners.json untouched (per-instance by design).`,
  );

  if (failures.length) {
    console.error(`\n${failures.length} chat(s) failed to copy:`);
    for (const f of failures.slice(0, 10)) console.error(`  ${f}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Reload the dev UI to see them (chats are read from disk per request).`);
}

main().catch((err) => {
  console.error(`\nbacksync failed: ${err.message}`);
  process.exitCode = 1;
});
