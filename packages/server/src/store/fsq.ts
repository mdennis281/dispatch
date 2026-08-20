/**
 * Filesystem primitives for the Store: atomic JSON writes, JSONL append/read,
 * and a per-path async mutex so concurrent writes to the same file serialize
 * (no interleaving / corruption). Atomic writes go through a temp file + rename
 * (libuv MoveFileEx replace-existing on Windows), so a reader never sees a
 * half-written file.
 */
import { mkdir, readFile, open, writeFile, rename, appendFile, rm } from "node:fs/promises";
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
export async function writeJsonAtomic(
  path: string,
  data: unknown,
  options?: { mode?: number },
): Promise<void> {
  await ensureDir(path);
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), {
      encoding: "utf8",
      ...(options?.mode !== undefined ? { mode: options.mode } : {}),
    });
    await renameWithRetry(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** True when an error is "the file isn't there", which every reader treats as empty. */
function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Read + JSON.parse `path`, or return `undefined` if it doesn't exist.
 *
 * The absence check is a CATCH, not an `existsSync` guard, and the difference is
 * measurable rather than stylistic. `existsSync` is a synchronous stat: it runs
 * on the main thread and holds the event loop for its whole duration, where
 * `readFile` hands the work to the libuv pool. Profiled against a real store of
 * 353 chats, `Store.listChats()` spent 59ms of its 110ms inside 353 of these
 * guards — five times what the 353 async `readFile`s that followed them cost —
 * and every one of those milliseconds froze all other HTTP and WebSocket
 * traffic. The WorktreeDetector calls `listChats` once per active project on a
 * 4s timer, so that showed up as the server going unresponsive for ~250ms every
 * 4 seconds, worst with several chats running. `readFile` already reports a
 * missing file as ENOENT, so the guard bought nothing but a second syscall.
 */
export async function readJson<T = unknown>(path: string): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
  if (raw.trim() === "") return undefined;
  return JSON.parse(raw) as T;
}

/** Append one object as a JSONL line (newline-terminated, single syscall). */
export async function appendJsonl(path: string, obj: unknown): Promise<void> {
  await ensureDir(path);
  await appendFile(path, `${JSON.stringify(obj)}\n`, "utf8");
}

/**
 * Append MANY objects in ONE write.
 *
 * The per-object form in a loop is a syscall per row, which is fine for a
 * transcript that grows a line at a time and ruinous for a write-behind flush of
 * a dev server's output — a batch of a thousand lines becomes a thousand
 * appends. One string, one append; a partial write still tears only the last
 * line, which {@link readJsonl} already tolerates.
 */
export async function appendJsonlBatch(path: string, rows: unknown[]): Promise<void> {
  if (rows.length === 0) return;
  await ensureDir(path);
  await appendFile(path, rows.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
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
 *
 * This still reads and splits the WHOLE file, so it is the right tool only when
 * the answer genuinely depends on the whole history — resolving a paging cursor,
 * say. For "the newest N rows" use {@link readJsonlTail}, which is the same
 * answer for a fraction of the work.
 *
 * Absence is caught rather than pre-checked with `existsSync`; see
 * {@link readJson} for what that guard was costing.
 */
export async function readJsonlLines(path: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  return splitLines(raw);
}

/** Non-empty, trimmed lines of a JSONL blob. */
function splitLines(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/**
 * First backwards read. Sized so one read covers the newest page of a NORMAL
 * transcript: real ones run ~2KB a row, so 1MB holds ~500 rows against the 200
 * a page asks for.
 */
const TAIL_CHUNK_BYTES = 1024 * 1024;
/**
 * Reads allowed to bisect before giving up and taking the whole remainder.
 *
 * Two misses mean the rows are enormous, and then the tail IS most of the file:
 * the worst real transcript in a live store is 13.5MB across just 1,095 rows,
 * whose newest 200 are 94% of it. Chunks are disjoint spans, so bisecting never
 * reads more BYTES than the file — but it does pay a syscall and a decode per
 * chunk plus a final join, which is how a doubling loop turned a 29ms
 * whole-file read into 64ms. Three reads is the ceiling.
 */
const TAIL_BISECT_READS = 2;

/**
 * Count 0x0A bytes, without decoding or allocating a split.
 *
 * Byte-exact even though the buffer is UTF-8: every byte of a multi-byte
 * sequence is >= 0x80, so 0x0A can only ever be a real newline.
 */
function countNewlineBytes(buf: Buffer): number {
  let n = 0;
  for (let i = buf.indexOf(0x0a); i !== -1; i = buf.indexOf(0x0a, i + 1)) n++;
  return n;
}

/**
 * The LAST `n` non-empty lines of a JSONL file, read backwards from EOF.
 *
 * WHY. Opening a chat asks for the newest page of its transcript, and
 * {@link readJsonlLines} answered that by slurping the whole file: on the
 * largest real transcript in a live store (17.8MB / 8,235 rows) returning the
 * newest 200 cost 22ms to read and 16ms to split, against 0.9ms to parse the
 * 200 rows actually wanted. 38 of those 40ms bought nothing, and the split alone
 * allocated 8,235 strings that were immediately garbage — on the main thread, so
 * every other request stalled behind it.
 *
 * WHAT IS TRUSTWORTHY. A chunk boundary lands mid-row essentially always, so the
 * FIRST line of what we hold is a fragment until an earlier chunk completes it.
 * Since we always read through to EOF, `k` newlines mean `k` whole lines after
 * that fragment — hence the loop stops at MORE than `n` lines, never exactly
 * `n`, and `slice(-n)` then can't reach back into the fragment. At byte 0 every
 * line is whole by definition and the check is skipped.
 *
 * WHY BUFFERS ARE CONCATENATED, NOT STRINGS. Decoding each chunk as it arrives
 * and joining the strings corrupts any character that straddles a chunk
 * boundary: both halves decode to U+FFFD independently and concatenation cannot
 * put them back. That is not theoretical — a differential run of this function
 * against `readJsonlLines` over all 353 transcripts in a live store failed on
 * exactly that, 2 cases out of 4,236, with the right line COUNT and a mangled
 * character inside one row. Bytes are kept raw and decoded once, over the whole
 * contiguous region, so the only lossy seam left is at the region's own start -
 * which is inside the untrusted first line, and discarded.
 *
 * WHY THE "\n" COUNT RATHER THAN SPLITTING EACH PASS. The obvious version
 * re-splits the accumulated tail every round trip, which is quadratic in the
 * bytes read — and transcripts with a few enormous rows (a tool result carrying
 * a whole file) read many chunks. Measured, that version took 1254ms on a 12.9MB
 * transcript where the whole-file read it replaced took 29ms. Counting newlines
 * is a linear scan of the NEW chunk only; the split happens once, when the count
 * says it will succeed.
 */
export async function readJsonlTail(path: string, n: number): Promise<string[]> {
  if (n <= 0) return [];
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(path, "r");
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  try {
    const { size } = await fh.stat();
    if (size === 0) return [];
    const chunks: Buffer[] = [];
    let newlines = 0;
    let end = size;
    for (let read = 0; end > 0; read++) {
      // Double while bisecting; once out of attempts, take everything left.
      const want =
        read < TAIL_BISECT_READS ? TAIL_CHUNK_BYTES * 2 ** read : Number.POSITIVE_INFINITY;
      const start = Math.max(0, end - want);
      const buf = Buffer.allocUnsafe(end - start);
      await fh.read(buf, 0, buf.length, start);
      chunks.unshift(buf);
      newlines += countNewlineBytes(buf);
      end = start;
      if (end === 0) break;
      // Gate on the cheap byte count, then confirm: blank lines are filtered out
      // by `splitLines`, so a newline count can promise more rows than survive.
      if (newlines > n) {
        const lines = splitLines(Buffer.concat(chunks).toString("utf8"));
        if (lines.length > n) return lines.slice(-n);
      }
    }
    return splitLines(Buffer.concat(chunks).toString("utf8")).slice(-n);
  } finally {
    await fh.close().catch(() => {});
  }
}

export { mkdir as mkdirp };
