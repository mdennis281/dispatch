/**
 * FileIndexService — "which files exist in this checkout", for the composer's
 * file-path picker.
 *
 * The browser never hands a web page a real filesystem path: `<input type=file>`
 * and OS drag-and-drop both yield a bare basename. So the picker can't come from
 * the OS dialog — the paths have to come from the side of the app that actually
 * has a filesystem. This service is that side.
 *
 * Listing is `git ls-files --cached --others --exclude-standard`: it's one
 * process for the whole tree, it already honors `.gitignore` (no walking into
 * `node_modules/`), and it covers both tracked and new-but-not-ignored files —
 * which is what a human means by "the files in my project". A non-repo directory
 * simply yields nothing rather than erroring; the picker shows an empty list.
 *
 * Results are cached per root for {@link CACHE_TTL_MS}: the picker queries on
 * every keystroke, and re-running git for each one would be both slow and
 * pointless — the tree doesn't change between two characters of typing.
 */
import { execa } from "execa";
import { join } from "node:path";
import type { ExecFn, ExecResult } from "./worktree.js";

/** Default runner: execa with an argument array, never rejecting. */
const realExec: ExecFn = async (file, args, opts) => {
  try {
    const r = await execa(file, args, {
      cwd: opts.cwd,
      reject: false,
      stripFinalNewline: false,
      windowsHide: true,
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "", exitCode: 1 };
  }
};

/** How long a root's listing is reused before git runs again. */
export const CACHE_TTL_MS = 10_000;

/** Hard cap on rows returned to a client, whatever it asks for. */
export const MAX_RESULTS = 200;

/** One candidate file: repo-relative for display, absolute for insertion. */
export interface IndexedFile {
  /** Path relative to the checkout root, always forward-slashed (git's form). */
  rel: string;
  /** Absolute path, separators native to the server's platform. */
  abs: string;
}

interface CacheEntry {
  at: number;
  files: string[];
}

/**
 * Score a path against a query. Higher is better; `null` means "no match".
 *
 * The ordering encodes what someone typing into a file picker means: they're
 * almost always thinking of a FILENAME, so a basename hit beats a directory
 * hit, and a prefix beats a hit buried mid-word. Subsequence matching ("cmsg" →
 * `c`hat/`m`e`s`sa`g`es) comes last, so it only ever fills the tail of a list
 * that better matches didn't already claim.
 */
export function scorePath(rel: string, query: string): number | null {
  if (!query) return 0;
  const path = rel.toLowerCase();
  const q = query.toLowerCase();
  const slash = path.lastIndexOf("/");
  const base = path.slice(slash + 1);

  const inBase = base.indexOf(q);
  if (inBase === 0) return 1000;
  if (inBase > 0) return 800;
  if (path.includes(q)) return 600;

  // Subsequence: every query char appears in order somewhere in the path.
  let i = 0;
  for (const ch of path) {
    if (ch === q[i]) i++;
    if (i === q.length) return 300;
  }
  return null;
}

/**
 * Rank + trim candidates for a query. Ties break on path length so the shallow,
 * obvious file wins over a deeply-nested namesake — with a final alphabetical
 * tiebreak so the same query always returns the same order (a list that
 * reshuffles between identical keystrokes is maddening to click).
 */
export function rankFiles(files: string[], query: string, limit: number): string[] {
  const scored: Array<{ rel: string; score: number }> = [];
  for (const rel of files) {
    const score = scorePath(rel, query);
    if (score !== null) scored.push({ rel, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score || a.rel.length - b.rel.length || (a.rel < b.rel ? -1 : 1),
  );
  return scored.slice(0, Math.max(0, limit)).map((s) => s.rel);
}

export interface FileIndexDeps {
  exec?: ExecFn;
}

export class FileIndexService {
  private readonly exec: ExecFn;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(deps: FileIndexDeps = {}) {
    this.exec = deps.exec ?? realExec;
  }

  /** Drop a root's cached listing (next query re-runs git). */
  invalidate(root: string): void {
    this.cache.delete(root);
  }

  /**
   * Every listable file under `root`, repo-relative and forward-slashed. Empty
   * when the directory isn't a git checkout (or git isn't available) — the
   * picker degrades to "no matches" rather than surfacing a git error at the
   * user, who asked for a file, not a diagnosis.
   */
  private async listAll(root: string): Promise<string[]> {
    const hit = this.cache.get(root);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.files;

    // `-z` (NUL-separated) is what makes this safe for paths containing spaces,
    // quotes or newlines — git otherwise escapes+quotes such names, and parsing
    // that back is a bug farm.
    const r: ExecResult = await this.exec(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root },
    );
    const files =
      r.exitCode === 0 ? r.stdout.split("\0").filter((p) => p.length > 0) : [];
    this.cache.set(root, { at: Date.now(), files });
    return files;
  }

  /**
   * Search `root` for files matching `query` (empty = the head of the list).
   * Returns both forms: the relative path is what a picker should SHOW, the
   * absolute path is what gets inserted into the message.
   */
  async search(
    root: string,
    query = "",
    limit = 50,
  ): Promise<IndexedFile[]> {
    const all = await this.listAll(root);
    const capped = Math.min(limit, MAX_RESULTS);
    const ranked = rankFiles(all, query.trim(), capped);
    return ranked.map((rel) => ({ rel, abs: join(root, rel) }));
  }
}
