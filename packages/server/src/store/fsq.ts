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

/** Atomically write pretty JSON to `path` (temp file + rename). */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await ensureDir(path);
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, path);
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
