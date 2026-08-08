/**
 * Filesystem primitives for the Store: atomic JSON writes, JSONL append/read,
 * and a per-path async mutex so concurrent writes to the same file serialize
 * (no interleaving / corruption). Atomic writes go through a temp file + rename
 * (libuv MoveFileEx replace-existing on Windows), so a reader never sees a
 * half-written file.
 */
import { mkdir, readFile, writeFile, rename, appendFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/** Chains async tasks per key so same-key operations never overlap. */
export class KeyedMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    // Run `task` after prev settles (success OR failure) so one failure can't
    // wedge the chain.
    const next = prev.then(
      () => task(),
      () => task(),
    );
    // Store a non-rejecting tail so the map never holds a rejected promise.
    this.chains.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

/**
 * Errors a replace-existing rename raises on Windows when the DESTINATION is
 * momentarily held open by someone else. Not a permissions problem despite the
 * name — retrying is the correct response.
 */
const RENAME_CONTENTION_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/** ~1.3s of total patience: 10, 20, 40, 80, 160, 200, 200, 200, 200, 200 ms. */
const RENAME_RETRY_ATTEMPTS = 10;
const RENAME_RETRY_MAX_DELAY_MS = 200;

/**
 * `rename(tmp, path)`, retried through transient Windows destination-locking.
 *
 * WHY. Every JSON file the Store owns is rewritten whole through a temp file
 * and a replace-existing rename. That rename deletes the destination, so it
 * needs delete access to it — and a foreign process that has the destination
 * open WITHOUT `FILE_SHARE_DELETE` takes that away for as long as it holds the
 * handle. Defender's on-access scanner, the search indexer and backup agents
 * all open files exactly that way, and they open a file *because* it was just
 * written, which is precisely the moment we rename onto it.
 *
 * The failure looks like a permissions bug and isn't:
 *
 *   EPERM: operation not permitted, rename
 *     '…/runners.json.<pid>.<hash>.tmp' -> '…/runners.json'
 *
 * That exact error took out `runner.test.ts` ("runs docker compose up before
 * spawn and down on stop") on a box running several agents at once, and it is
 * reproducible on demand by opening the destination from another process with
 * share mode Read/ReadWrite/None — all three fail, only share mode Delete
 * succeeds. It is NOT a test artifact: tests and production run this same
 * function, and production's `.data` / `%LOCALAPPDATA%\claude-manager` are if
 * anything scanned harder than TEMP.
 *
 * Nor is it cosmetic. The write sits UPSTREAM of the broadcast — see
 * ResumeScheduler.patch(), which awaits `saveChat()` and only then publishes
 * `chat-update` — so one EPERM here is a chat update, a runner record or a
 * checkpoint that silently never happens, with the rejection swallowed by a
 * fire-and-forget caller. That mechanism also explains (not proven, but it is
 * the only path that fits) the other flake seen the same day: routes.test.ts
 * "schedules a resume off the limit result" hanging to its 30s timeout on an
 * unbounded await for a `chat-update` that never arrived.
 *
 * The holder is a scanner, so the window is short and backing off clears it —
 * measured: 6 retries under a 350ms artificial hold. We give up after ~1.3s and
 * rethrow the ORIGINAL error rather than retry forever, because a lock that
 * outlives that is a real one (a file genuinely pinned open) and hiding it
 * behind an unbounded retry would just move the hang somewhere worse.
 */
export async function renameWithRetry(
  tmp: string,
  path: string,
  // Seam for the unit test: the real contention needs a second process holding a
  // Windows handle, which is neither cheap nor available on a Linux runner.
  renameFn: (from: string, to: string) => Promise<void> = rename,
): Promise<void> {
  let delay = 10;
  // The FIRST contention error, kept so exhaustion can rethrow it — see the
  // docblock. Review caught that this used to throw the latest `err` instead,
  // which is the one raised ~1.3s into backoff: by then every frame above us
  // has unwound, so its stack no longer shows which caller's write was lost.
  // The first one is raised on the original call path and still names it.
  let firstErr: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      await renameFn(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Not contention — a real error (ENOENT, ENOSPC…). Surface it as-is and
      // immediately; it is never the one we are being patient about.
      if (!code || !RENAME_CONTENTION_CODES.has(code)) throw err;
      firstErr ??= err;
      if (attempt >= RENAME_RETRY_ATTEMPTS - 1) throw firstErr;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, RENAME_RETRY_MAX_DELAY_MS);
    }
  }
}

/** Atomically write pretty JSON to `path` (temp file + rename). */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await ensureDir(path);
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await renameWithRetry(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Read + JSON.parse `path`, or return `undefined` if it doesn't exist. */
export async function readJson<T = unknown>(path: string): Promise<T | undefined> {
  if (!existsSync(path)) return undefined;
  const raw = await readFile(path, "utf8");
  if (raw.trim() === "") return undefined;
  return JSON.parse(raw) as T;
}

/** Append one object as a JSONL line (newline-terminated, single syscall). */
export async function appendJsonl(path: string, obj: unknown): Promise<void> {
  await ensureDir(path);
  await appendFile(path, `${JSON.stringify(obj)}\n`, "utf8");
}

/**
 * Read a JSONL file into raw parsed rows. Tolerates a blank/partial trailing
 * line. Throws on a malformed interior line (surfaces real corruption).
 */
export async function readJsonl(path: string): Promise<unknown[]> {
  const lines = await readJsonlLines(path);
  const out: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      // A malformed final line can be a torn append; tolerate only the last one.
      if (i === lines.length - 1) break;
      throw new Error(`Malformed JSONL at ${path}: ${(err as Error).message}`);
    }
  }
  return out;
}

/**
 * Read a JSONL file into its RAW non-empty lines, unparsed.
 *
 * The windowed transcript reads (see Store.readMessages) slice a page out of a
 * multi-megabyte transcript and only then JSON.parse + zod-validate it — parsing
 * every one of thousands of rows to return the last 200 was the dominant cost of
 * opening a long chat. Callers that want whole rows use {@link readJsonl}.
 */
export async function readJsonlLines(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

export { mkdir as mkdirp };
