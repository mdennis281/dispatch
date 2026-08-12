/**
 * MemoryHistoryService — when each durable fact was written, and by which commit.
 *
 * A memory file carries `updatedAt`, which is the LAST write and nothing more.
 * That single number can't answer the questions a consolidation actually turns
 * on: was this fact recorded once and never revisited, or rewritten four times
 * as the team argued it out? Was `taskkill-orphans-subapps` written before or
 * after the fix that made it obsolete? And — the one that stops a consolidation
 * from undoing itself — was a memory deleted deliberately last month, or has it
 * simply never existed?
 *
 * Git already knows, because {@link MemoryCommitter} lands every write as a real
 * commit in the repo's `.dispatch/memory/`. This reads that back.
 *
 * Best-effort and non-fatal by contract: a project whose memory lives in the
 * legacy `.data` store, or whose profile doesn't commit memory, has no history —
 * that's an `available: false` with a reason the agent can read, never an error.
 */
import { isAbsolute, relative } from "node:path";
import { execa } from "execa";
import type { Store } from "../store/index.js";
import type { ExecFn, ExecResult, MemoryDirResolver } from "./memory-committer.js";
import { slugifyMemoryName } from "./memory.js";

const realExec: ExecFn = async (file, args, opts) => {
  try {
    const r = await execa(file, args, {
      cwd: opts.cwd,
      reject: false,
      stripFinalNewline: true,
      windowsHide: true,
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
  } catch (err) {
    return { stdout: "", stderr: err instanceof Error ? err.message : String(err), exitCode: 1 };
  }
};

/** What one commit did to one memory file. */
export type MemoryChangeKind = "added" | "modified" | "deleted" | "renamed" | "other";

/** A memory file touched by a commit. */
export interface MemoryFileChange {
  /** The memory's name (filename minus `.md`), or `MEMORY.md`'s index marker. */
  name: string;
  kind: MemoryChangeKind;
  /** Previous name, for a rename. */
  from?: string;
}

export interface MemoryCommitEntry {
  sha: string;
  /** Author date, ISO 8601. */
  date: string;
  author: string;
  subject: string;
  /** Memory files this commit touched. Empty for a single-file query. */
  files: MemoryFileChange[];
}

export interface MemoryHistoryResult {
  available: boolean;
  /** Why history couldn't be read, when `available` is false. */
  reason?: string;
  commits: MemoryCommitEntry[];
}

export interface MemoryHistoryOptions {
  store: Store;
  projectConfig: MemoryDirResolver;
  exec?: ExecFn;
}

/* -------------------------------------------------------------------- parsing */

/** Record/field separators — chosen because git subjects can contain anything. */
const RS = "\x1e";
const FS = "\x1f";
const FORMAT = `${RS}%H${FS}%aI${FS}%an${FS}%s`;

/** `git log --name-status` status letter → what it means for a memory. */
function changeKind(status: string): MemoryChangeKind {
  const c = status[0];
  if (c === "A") return "added";
  if (c === "M") return "modified";
  if (c === "D") return "deleted";
  if (c === "R") return "renamed";
  return "other";
}

/** `.dispatch/memory/foo.md` → `foo`; the index keeps its filename. */
function memoryNameOf(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.endsWith(".md") ? file.slice(0, -3) : file;
}

/**
 * Parse `git log --format=<FORMAT> --name-status` output. Exported for tests —
 * the parsing is the part with edge cases (a subject containing a newline, a
 * rename's two-path status line), not the subprocess call.
 */
export function parseMemoryLog(stdout: string): MemoryCommitEntry[] {
  const out: MemoryCommitEntry[] = [];
  for (const record of stdout.split(RS)) {
    if (!record.trim()) continue;
    const newline = record.indexOf("\n");
    const header = newline === -1 ? record : record.slice(0, newline);
    const rest = newline === -1 ? "" : record.slice(newline + 1);
    const [sha, date, author, subject] = header.split(FS);
    if (!sha) continue;
    const files: MemoryFileChange[] = [];
    for (const line of rest.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      const status = parts[0]?.trim();
      if (!status || !parts[1]) continue;
      const kind = changeKind(status);
      // A rename status line is `R096\told/path\tnew/path`.
      if (kind === "renamed" && parts[2]) {
        files.push({
          name: memoryNameOf(parts[2]),
          kind,
          from: memoryNameOf(parts[1]),
        });
      } else {
        files.push({ name: memoryNameOf(parts[1]), kind });
      }
    }
    out.push({
      sha,
      date: date ?? "",
      author: author ?? "",
      subject: subject ?? "",
      files,
    });
  }
  return out;
}

/* -------------------------------------------------------------------- service */

export class MemoryHistoryService {
  private readonly store: Store;
  private readonly projectConfig: MemoryDirResolver;
  private readonly exec: ExecFn;

  constructor(opts: MemoryHistoryOptions) {
    this.store = opts.store;
    this.projectConfig = opts.projectConfig;
    this.exec = opts.exec ?? realExec;
  }

  /**
   * A project's memory commit history — for one memory (`name`), or across the
   * whole memory dir when `name` is omitted.
   *
   * The dir-wide form carries each commit's touched files WITH their status, so
   * a `deleted` entry is visible: that's the record of a fact someone
   * deliberately retired, and re-adding it is the single most annoying thing a
   * consolidation can do. The single-file form uses `--follow`, so a memory
   * renamed by an earlier consolidation still shows the life it had before.
   */
  async forProject(
    projectId: string,
    opts: { name?: string; limit?: number } = {},
  ): Promise<MemoryHistoryResult> {
    const unavailable = (reason: string): MemoryHistoryResult => ({
      available: false,
      reason,
      commits: [],
    });

    const project = await this.store.getProject(projectId).catch(() => null);
    if (!project) return unavailable("no such project");

    const memoryDir = this.projectConfig.getConfig(projectId)?.memoryDir;
    if (!memoryDir) {
      return unavailable(
        "this project's memory lives in the runtime store, not a git-tracked " +
          "`.dispatch/memory/` dir, so there is no commit history to read",
      );
    }
    const rel = relative(project.repoPath, memoryDir).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      return unavailable(`the memory dir is outside the repo (${memoryDir})`);
    }

    const slug = opts.name ? slugifyMemoryName(opts.name) : "";
    if (opts.name && !slug) return unavailable(`invalid memory name: ${opts.name}`);
    const limit = Math.max(1, Math.min(200, opts.limit ?? 20));
    const pathspec = slug ? `${rel}/${slug}.md` : rel;

    const args = [
      "log",
      `-n${limit}`,
      `--format=${FORMAT}`,
      "--name-status",
      // Renames only matter for the single-file query, and `--follow` refuses
      // more than one pathspec anyway.
      ...(slug ? ["--follow"] : []),
      "--",
      pathspec,
    ];
    const res: ExecResult = await this.exec("git", args, { cwd: project.repoPath });
    if (res.exitCode !== 0) {
      return unavailable(`git log failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
    const commits = parseMemoryLog(res.stdout);
    // An empty log is a real answer, not a failure: on a profile that doesn't
    // commit memory the dir is untracked, and saying so beats "0 commits".
    if (!commits.length) {
      return {
        available: true,
        reason:
          "no commits touch this path — memory here may not be committed " +
          "(the workflow profile decides), or the fact is newer than the last commit",
        commits: [],
      };
    }
    return { available: true, commits };
  }
}
