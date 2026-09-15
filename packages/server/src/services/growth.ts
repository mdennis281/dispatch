/**
 * GrowthService — the repo's line count over time, read straight out of git.
 *
 * One walk of `git log --first-parent --numstat` over the trunk, folded into
 * UTC-day buckets per growth key (see `@dispatch/shared`'s `classifyPath`).
 * Nothing is stored: the Growth tab asks, this walks, the answer streams back.
 * The reasoning for that — and for first-parent — is in `shared/growth.ts`.
 *
 * STREAMED, NOT BUFFERED. A numstat over a long history is tens of megabytes
 * and the diffs behind it are what take the time, so the walk reads git's
 * stdout as it arrives and reports progress by commits seen against a count
 * taken up front (`rev-list --count`, which is milliseconds — it walks the
 * graph, not the trees). Buffering would mean the client sits on a spinner
 * for the whole walk and then receives everything at once, which is exactly
 * the experience the progress bar exists to replace.
 *
 * CANCELLABLE. The route hands in the request's abort signal, and a client
 * that navigates away mid-walk takes the git process down with it rather than
 * leaving it to finish diffing a history nobody will read.
 */
import { execa } from "execa";
import treeKill from "tree-kill";
import {
  GROWTH_GENERATED_KEY,
  classifyPath,
  type GrowthDelta,
  type GrowthNotableCommit,
  type GrowthPoint,
  type GrowthProgress,
  type GrowthReport,
} from "@dispatch/shared";

/** Same never-prompt env the other git services run under. */
const GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GCM_INTERACTIVE: "never",
};

/** How many of the biggest commits the report carries. */
const NOTABLE_LIMIT = 10;

/** Progress is reported at most this often — a frame per commit is noise. */
const PROGRESS_EVERY_MS = 120;

/**
 * The commit header, chosen so no numstat line can be mistaken for one: a
 * numstat line starts with a digit or `-`, and a header starts with NUL, which
 * git never emits in a path (quoted paths escape it).
 *
 * `%ct` (committer time) rather than `%at`: on a squash- or rebase-merged
 * trunk the author time is when the branch was started, which can be weeks
 * before the lines actually landed on main — and "when did the trunk grow" is
 * the question.
 */
const HEADER = "%x00%H%x09%ct%x09%aN%x09%s";

const DAY_MS = 86_400_000;

/* --------------------------------------------------------------- parsing */

/**
 * Undo git's C-style path quoting (`"caf\303\251.ts"`), applied when a path
 * holds a byte outside printable ASCII or a quote/backslash. Everything else
 * comes through bare.
 */
export function unquotePath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch !== "\\") {
      bytes.push(ch.charCodeAt(0));
      continue;
    }
    const next = inner[i + 1] ?? "";
    if (/[0-7]/.test(next)) {
      const oct = inner.slice(i + 1, i + 4);
      bytes.push(parseInt(oct, 8));
      i += oct.length;
      continue;
    }
    const map: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '"': 34, "\\": 92 };
    bytes.push(map[next] ?? next.charCodeAt(0));
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Split a numstat rename path into its OLD and NEW names.
 *
 * Two forms: a shared-prefix brace (`src/{old => new}/a.ts`, and the braces
 * may be empty on one side — `src/{ => lib}/a.ts`) and the whole-path arrow
 * (`old.ts => new.ts`). Both names matter: the new one is where the lines
 * live from here on, and the old one is where the accumulator has to fetch
 * them FROM when the rename changes the growth key (see `feed`).
 */
export function splitRename(path: string): { from: string | null; to: string } {
  const brace = path.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) {
    const [, pre, from, to, post] = brace;
    // `src/{old => }/a.ts` must collapse the doubled slash to `src/a.ts`.
    const join = (mid: string) => `${pre}${mid}${post}`.replace(/\/{2,}/g, "/");
    return { from: join(from!), to: join(to!) };
  }
  const arrow = path.indexOf(" => ");
  if (arrow >= 0) return { from: path.slice(0, arrow), to: path.slice(arrow + 4) };
  return { from: null, to: path };
}

/** One numstat line, or `null` for the blank and header lines around it. */
export function parseNumstatLine(line: string): {
  additions: number;
  deletions: number;
  binary: boolean;
  /** The path after this commit. */
  path: string;
  /** The path before it, when this entry is a rename. */
  from: string | null;
} | null {
  const m = /^(\d+|-)	(\d+|-)	(.+)$/.exec(line);
  if (!m) return null;
  const binary = m[1] === "-";
  const { from, to } = splitRename(unquotePath(m[3]!));
  return {
    additions: binary ? 0 : Number(m[1]),
    deletions: binary ? 0 : Number(m[2]),
    binary,
    path: to,
    from,
  };
}

/* ------------------------------------------------------------ accumulator */

interface Commit {
  sha: string;
  ts: number;
  author: string;
  subject: string;
  /** Non-generated lines only — see {@link GrowthAccumulator.notable}. */
  additions: number;
  deletions: number;
  files: number;
}

/**
 * Folds the numstat stream into the report's shape, one line at a time.
 *
 * A class rather than a closure so a test can feed it lines and read the
 * result without a git process. `feed` is the whole protocol: headers open a
 * commit, numstat lines add to it, and `finish` closes the last one.
 */
export class GrowthAccumulator {
  private readonly days = new Map<number, GrowthPoint>();
  private readonly totals = new Map<string, GrowthDelta>();
  /**
   * Every live path's current line count.
   *
   * Exact, because the first-parent chain is a linear sequence of diffs and
   * numstat is exact per file — so a path's count after commit N is its count
   * after N−1 plus that commit's additions minus its deletions. It exists for
   * ONE reason: a rename. Git reports `git mv a.js a.ts` as `0 0 a.js => a.ts`,
   * which is correct as churn and wrong as attribution — the ten lines that
   * were counted under `.js` when the file was born stay there forever, and
   * `.ts` owns a file it was never credited with. A `.js → .ts` migration is
   * the commonest event of its kind and would leave a phantom `.js` row in
   * the composition table and undercount TypeScript by the size of the
   * migration. So when a rename CHANGES the key, the file's count moves with
   * it: a deletion from the old key and an addition to the new one, in the
   * commit that renamed it. A rename that keeps its key (`a.ts` → `lib/a.ts`)
   * stays at the zero churn git reported.
   */
  private readonly lines = new Map<string, number>();
  private readonly authors = new Set<string>();
  private readonly top: Commit[] = [];
  private current: Commit | null = null;
  private point: GrowthPoint | null = null;
  binaries = 0;
  commits = 0;
  firstTs = Number.POSITIVE_INFINITY;
  lastTs = 0;

  feed(line: string): void {
    if (line.charCodeAt(0) === 0) {
      this.close();
      const [sha = "", ct = "0", author = "", ...rest] = line.slice(1).split("\t");
      const ts = Number(ct) * 1000;
      this.current = {
        sha,
        ts,
        author,
        // The subject may itself contain tabs; it is everything after the
        // third one.
        subject: rest.join("\t"),
        additions: 0,
        deletions: 0,
        files: 0,
      };
      this.commits += 1;
      this.authors.add(author);
      if (ts < this.firstTs) this.firstTs = ts;
      if (ts > this.lastTs) this.lastTs = ts;
      const day = Math.floor(ts / DAY_MS) * DAY_MS;
      let point = this.days.get(day);
      if (!point) {
        point = { ts: day, commits: 0, additions: 0, deletions: 0, keys: {} };
        this.days.set(day, point);
      }
      point.commits += 1;
      this.point = point;
      return;
    }
    const entry = parseNumstatLine(line);
    if (!entry || !this.current || !this.point) return;
    if (entry.binary) {
      this.binaries += 1;
      return;
    }
    const key = classifyPath(entry.path);

    // Where the file's lines were before this commit — under its old name if
    // it was renamed, else under its own.
    let before = this.lines.get(entry.path) ?? 0;
    if (entry.from !== null) {
      before = this.lines.get(entry.from) ?? 0;
      this.lines.delete(entry.from);
      const fromKey = classifyPath(entry.from);
      if (fromKey !== key && before > 0) {
        // The reclassifying rename: the old key gives the lines up and the
        // new key takes them, as churn dated to this commit.
        this.bump(fromKey, 0, before);
        this.bump(key, before, 0);
      }
    }
    const after = before + entry.additions - entry.deletions;
    if (after > 0) this.lines.set(entry.path, after);
    else this.lines.delete(entry.path);

    this.bump(key, entry.additions, entry.deletions);
    if (key !== GROWTH_GENERATED_KEY) this.current.files += 1;
  }

  /** Credit lines to a key in the open commit's day, totals and commit. */
  private bump(key: string, additions: number, deletions: number): void {
    const point = this.point!;
    point.additions += additions;
    point.deletions += deletions;
    const slot = (point.keys[key] ??= { additions: 0, deletions: 0 });
    slot.additions += additions;
    slot.deletions += deletions;
    const total = this.totals.get(key) ?? { additions: 0, deletions: 0 };
    total.additions += additions;
    total.deletions += deletions;
    this.totals.set(key, total);
    // A lockfile churn is the biggest diff in most repos and the least
    // interesting, so a commit ranks by the lines a human might have written.
    if (key !== GROWTH_GENERATED_KEY) {
      this.current!.additions += additions;
      this.current!.deletions += deletions;
    }
  }

  /** Close the commit in progress; safe to call with none open. */
  private close(): void {
    const c = this.current;
    if (!c) return;
    this.current = null;
    const moved = c.additions + c.deletions;
    if (moved === 0) return;
    // A tiny sorted list rather than a heap: NOTABLE_LIMIT is ten.
    const worst = this.top[this.top.length - 1];
    if (this.top.length < NOTABLE_LIMIT || moved > worst!.additions + worst!.deletions) {
      this.top.push(c);
      this.top.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
      if (this.top.length > NOTABLE_LIMIT) this.top.pop();
    }
  }

  finish(): {
    points: GrowthPoint[];
    totals: Record<string, GrowthDelta>;
    notable: GrowthNotableCommit[];
    authors: number;
  } {
    this.close();
    const points = [...this.days.values()].sort((a, b) => a.ts - b.ts);
    return {
      points,
      totals: Object.fromEntries(this.totals),
      notable: this.top.map((c) => ({
        sha: c.sha,
        ts: c.ts,
        subject: c.subject,
        author: c.author,
        additions: c.additions,
        deletions: c.deletions,
        files: c.files,
      })),
      authors: this.authors.size,
    };
  }
}

/* ---------------------------------------------------------------- service */

export interface GrowthWalkOptions {
  projectId: string;
  repoPath: string;
  onProgress: (progress: GrowthProgress) => void;
  signal?: AbortSignal;
}

export class GrowthService {
  /** A buffered git call for the small reads around the walk. */
  private async git(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
    const r = await execa("git", args, {
      cwd,
      env: GIT_ENV,
      reject: false,
      windowsHide: true,
      timeout: 60_000,
      ...(signal ? { cancelSignal: signal } : {}),
    });
    if (r.exitCode !== 0) {
      throw new Error((r.stderr || `git ${args[0]} failed`).trim());
    }
    return r.stdout;
  }

  async walk(opts: GrowthWalkOptions): Promise<GrowthReport> {
    const { repoPath, projectId, onProgress, signal } = opts;
    const started = Date.now();

    onProgress({ phase: "counting" });
    // An unborn HEAD (fresh `git init`) fails here with git's own words, which
    // the route passes through — better than a walk over nothing.
    const total = Number(
      await this.git(["rev-list", "--count", "--first-parent", "HEAD"], repoPath, signal),
    );
    const refName = (
      await this.git(["rev-parse", "--abbrev-ref", "HEAD"], repoPath, signal)
    ).trim();
    const ref =
      refName === "HEAD"
        ? (await this.git(["rev-parse", "--short", "HEAD"], repoPath, signal)).trim()
        : refName;

    onProgress({ phase: "walking", done: 0, total });

    const acc = new GrowthAccumulator();
    const child = execa(
      "git",
      [
        // `core.quotePath=false` keeps non-ASCII paths readable; quoting still
        // happens for control characters, which `unquotePath` handles.
        "-c",
        "core.quotePath=false",
        "log",
        "--first-parent",
        // Explicit rather than relying on `--first-parent` implying it (it
        // does, since 2.31): a merge commit on the chain must contribute the
        // diff it landed, or a merge-commit workflow shows a flat line with
        // no growth at all.
        "--diff-merges=first-parent",
        // OLDEST FIRST, because the accumulator follows each path's line
        // count forward through renames (see `GrowthAccumulator.lines`), and
        // newest-first would meet a rename before the file it renames exists.
        // Git still computes each commit's diff as it prints it, so the
        // progress stream is unaffected — only the cheap rev-walk is buffered.
        "--reverse",
        "--numstat",
        `--format=${HEADER}`,
        "HEAD",
      ],
      {
        cwd: repoPath,
        env: GIT_ENV,
        windowsHide: true,
        reject: false,
        // Read as it comes; buffering the whole numstat would hold tens of MB
        // for a long history and defeat the progress stream.
        buffer: false,
        // NO `cancelSignal` here, deliberately — see `onAbort` below.
      },
    );

    // Cancellation is a TREE kill, and nothing else may touch the process
    // first. On Windows the `git` on PATH is usually the `Git/cmd/git.exe`
    // shim, which runs the real binary as a CHILD. execa's `cancelSignal`
    // kills the shim alone — and because it is registered at spawn it fires
    // BEFORE any listener added here, so a tree-kill that follows it finds a
    // dead parent whose children `taskkill /T` can no longer enumerate. The
    // real git then keeps diffing until its stdout pipe breaks. Measured:
    // a 30k-commit walk survived an abort for the rest of its run. So the
    // abort listener owns the kill outright, and the iteration below ends
    // when the pipe does.
    const onAbort = () => {
      if (child.pid) treeKill(child.pid, "SIGKILL", () => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let lastReport = Date.now();
    try {
      for await (const line of child.iterable({ preserveNewlines: false })) {
        acc.feed(line);
        const now = Date.now();
        if (now - lastReport >= PROGRESS_EVERY_MS) {
          lastReport = now;
          onProgress({ phase: "walking", done: acc.commits, total });
        }
      }
    } catch (err) {
      if (signal?.aborted) throw new Error("cancelled");
      throw err;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    const result = await child;
    if (result.exitCode !== 0) {
      throw new Error((result.stderr || "git log failed").trim());
    }
    onProgress({ phase: "walking", done: acc.commits, total });

    // Files per key AT HEAD — exact and cheap, where "files ever touched" from
    // the walk would count every path that has since been deleted.
    const files = new Map<string, number>();
    const tree = await this.git(["ls-tree", "-r", "-z", "--name-only", "HEAD"], repoPath, signal);
    for (const path of tree.split("\0")) {
      if (!path) continue;
      const key = classifyPath(path);
      files.set(key, (files.get(key) ?? 0) + 1);
    }

    const folded = acc.finish();
    const totals: GrowthReport["totals"] = {};
    for (const [key, delta] of Object.entries(folded.totals)) {
      totals[key] = { ...delta, files: files.get(key) ?? 0 };
    }
    // A key present in the tree but never in a text diff (a directory of
    // binaries, say) still deserves a row with its file count.
    for (const [key, n] of files) {
      totals[key] ??= { additions: 0, deletions: 0, files: n };
    }

    return {
      projectId,
      ref,
      commits: acc.commits,
      authors: folded.authors,
      firstTs: Number.isFinite(acc.firstTs) ? acc.firstTs : started,
      lastTs: acc.lastTs || started,
      points: folded.points,
      totals,
      notable: folded.notable,
      binaries: acc.binaries,
      generatedAt: started,
      elapsedMs: Date.now() - started,
    };
  }
}
