/**
 * GitService — the working-copy control plane behind the Source Control UI.
 *
 * Where WorktreeService manages `git worktree` LIFECYCLE (add/remove/list) and
 * branch-vs-base diffs, this service drives the day-to-day loop inside ONE repo
 * directory: what changed, stage/unstage/discard, commit, branch, stash, and
 * fetch/pull/push. `repoPath` is any git working directory — the project
 * checkout or one of its worktrees — so the same UI serves both.
 *
 * House rules carried over from WorktreeService:
 *   - every call is an execa ARGUMENT ARRAY (no shell string), so branch names
 *     and paths can never be shell-injected;
 *   - caller-supplied refs are charset-validated AND pinned with
 *     `--end-of-options` so a crafted ref (`--output=…`) can't become a git
 *     write primitive through an unauthenticated route;
 *   - caller-supplied paths go through `normalizeRelPath` and always follow a
 *     `--` separator, so they can't escape the repo or be read as flags.
 *
 * Network/credential safety: git runs with `GIT_TERMINAL_PROMPT=0` and no
 * askpass, so a push that needs credentials FAILS FAST with a readable error
 * instead of hanging a request on an invisible prompt.
 */
import { execa } from "execa";
import { existsSync } from "node:fs";
import { readFile as fsReadFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import {
  GitStatusSchema,
  type GitBranch,
  type GitChangeStatus,
  type GitCommit,
  type GitCommitFile,
  type GitFileChange,
  type GitStash,
  type GitStatus,
  GIT_REV_INDEX,
  GIT_REV_WORKTREE,
} from "@dispatch/shared";
import {
  normalizeRelPath,
  packFileContent,
  parseNumstat,
  type WorktreeFile,
} from "./worktree.js";

/* --------------------------------------------------------------- exec seam */

export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Injectable process runner (tests mock this; prod = execa). */
export type GitExecFn = (
  file: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; timeout?: number },
) => Promise<GitExecResult>;

/** Default per-call timeout. Local git work is fast; a hang means trouble. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Network ops (fetch/pull/push) get a longer leash. */
const NETWORK_TIMEOUT_MS = 120_000;

/**
 * Env every git call inherits: never prompt for credentials (fail fast instead
 * of hanging on an invisible terminal/GUI prompt), and don't take optional
 * locks for read-only inspection.
 */
const GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GCM_INTERACTIVE: "never",
};

const realExec: GitExecFn = async (file, args, opts) => {
  try {
    const r = await execa(file, args, {
      cwd: opts.cwd,
      env: { ...GIT_ENV, ...(opts.env ?? {}) },
      timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
      reject: false,
      stripFinalNewline: false,
      windowsHide: true,
    });
    return {
      stdout: String(r.stdout ?? ""),
      stderr: String(r.stderr ?? ""),
      exitCode: typeof r.exitCode === "number" ? r.exitCode : r.failed ? 1 : 0,
    };
  } catch (err) {
    const e = err as {
      stdout?: unknown;
      stderr?: unknown;
      shortMessage?: unknown;
      message?: unknown;
      exitCode?: unknown;
    };
    return {
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? e.shortMessage ?? e.message ?? ""),
      exitCode: typeof e.exitCode === "number" ? e.exitCode : 1,
    };
  }
};

/* ----------------------------------------------------------------- guards */

/**
 * Charset for a caller-supplied rev. Deliberately narrow: sha/branch/tag names
 * plus the traversal suffixes (`^`, `~`) and the reflog form (`stash@{0}`).
 * A leading `-` can never match, so a rev can't be read as a flag.
 */
const REV_RE = /^[A-Za-z0-9_.@/{}^~-]+$/;

/** Validate a rev, throwing a client-safe error. Rejects a leading dash. */
export function assertRev(rev: string): string {
  if (!rev || rev.startsWith("-") || !REV_RE.test(rev)) {
    throw new Error(`invalid rev: ${rev}`);
  }
  return rev;
}

/** Normalize a batch of repo-relative paths, rejecting any that escape. */
export function normalizePaths(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const rel = normalizeRelPath(p);
    if (rel === null) throw new Error(`invalid path: ${p}`);
    out.push(rel);
  }
  if (out.length === 0) throw new Error("no paths given");
  return out;
}

/* ------------------------------------------------------------ record seps */

/** Record separator used in `--format` strings (never appears in git data). */
const RS = "\x1e";
/** Unit (field) separator. */
const US = "\x1f";

/* ================================================================ service */

export interface GitServiceDeps {
  exec?: GitExecFn;
}

export class GitService {
  private readonly exec: GitExecFn;

  constructor(deps: GitServiceDeps = {}) {
    this.exec = deps.exec ?? realExec;
  }

  /* ------------------------------------------------------------- reading */

  /**
   * Resolve the top level of the repo containing `repoPath`. Doubles as the
   * "is this actually a git repo?" guard every route runs first.
   */
  async repoRoot(repoPath: string): Promise<string> {
    const out = await this.git(["rev-parse", "--show-toplevel"], repoPath);
    return out.trim();
  }

  /** Full working-copy status: HEAD, upstream gap, and every changed path. */
  async status(repoPath: string): Promise<GitStatus> {
    const out = await this.git(
      ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"],
      repoPath,
    );
    return GitStatusSchema.parse({ ...parsePorcelainV2(out), repoPath });
  }

  /**
   * Local + remote-tracking branches, newest-tip first. `worktreePath` is set
   * for a branch already checked out somewhere, since git refuses a second
   * checkout of the same branch and the switcher has to disable it.
   */
  async branches(repoPath: string): Promise<GitBranch[]> {
    const fmt = [
      "%(refname)",
      "%(refname:short)",
      "%(HEAD)",
      "%(upstream:short)",
      "%(upstream:track)",
      "%(committerdate:unix)",
      "%(contents:subject)",
      "%(objectname:short)",
      "%(worktreepath)",
    ].join("%1f");
    const out = await this.git(
      ["for-each-ref", `--format=${fmt}`, "refs/heads", "refs/remotes"],
      repoPath,
    );
    return parseBranchRefs(out);
  }

  /** Commit history for `ref` (default HEAD), newest first. */
  async log(
    repoPath: string,
    opts: { limit?: number; ref?: string } = {},
  ): Promise<GitCommit[]> {
    const limit = Math.min(Math.max(opts.limit ?? 60, 1), 500);
    const fmt =
      `${RS}%H${US}%h${US}%s${US}%b${US}%an${US}%ae${US}%ct${US}%D`;
    const args = [
      "log",
      `--max-count=${limit}`,
      "--decorate=short",
      `--format=${fmt}`,
    ];
    if (opts.ref) args.push("--end-of-options", assertRev(opts.ref));
    // An unborn branch (fresh `git init`) has no HEAD — that's an empty history,
    // not an error the UI should show.
    const r = await this.exec("git", args, { cwd: repoPath });
    if (r.exitCode !== 0) {
      if (/unknown revision|does not have any commits/i.test(r.stderr)) return [];
      throw gitError(args, r);
    }
    return parseLog(r.stdout);
  }

  /** Files touched by a commit, with line counts (the history detail list). */
  async commitFiles(repoPath: string, rev: string): Promise<GitCommitFile[]> {
    const ref = assertRev(rev);
    const [numstatOut, nameStatusOut] = await Promise.all([
      this.git(
        ["show", "--numstat", "--format=", "-M", "--end-of-options", ref],
        repoPath,
      ),
      this.git(
        ["show", "--name-status", "--format=", "-M", "--end-of-options", ref],
        repoPath,
      ),
    ]);
    const statuses = parseNameStatus(nameStatusOut);
    return parseNumstat(numstatOut).map((e) => ({
      path: e.path,
      oldPath: e.oldPath,
      status: statuses.get(e.path) ?? (e.oldPath ? "renamed" : "modified"),
      additions: e.binary ? 0 : e.additions,
      deletions: e.binary ? 0 : e.deletions,
      binary: e.binary,
    }));
  }

  /** The stash stack, newest first. */
  async stashes(repoPath: string): Promise<GitStash[]> {
    const out = await this.git(
      ["stash", "list", `--format=${RS}%gd${US}%ct${US}%gs`],
      repoPath,
    );
    return parseStashList(out);
  }

  /**
   * One file's content at a given snapshot, in the same shape the Monaco viewer
   * already consumes. `rev` is `WORKTREE` (file on disk), `INDEX` (the staged
   * blob) or any git rev. A path missing at that snapshot comes back
   * `exists: false` rather than throwing — that's how an add/delete renders as
   * one empty side of the diff.
   */
  async readFile(
    repoPath: string,
    relPath: string,
    rev: string = GIT_REV_WORKTREE,
  ): Promise<WorktreeFile> {
    const rel = normalizeRelPath(relPath);
    if (rel === null) throw new Error(`invalid relPath: ${relPath}`);

    // `<rev>:<path>` object specs. The index is the empty-rev form (`:path`).
    const spec =
      rev === GIT_REV_INDEX ? `:${rel}` : `${assertRev(rev)}:${rel}`;

    // Uncommitted bytes only exist on disk — `git show` can't see them — so the
    // working-tree side is read straight from the filesystem (path-guarded).
    if (rev === GIT_REV_WORKTREE) return readWorkingFile(repoPath, rel);

    const r = await this.exec(
      "git",
      ["show", "--end-of-options", spec],
      { cwd: repoPath },
    );
    if (r.exitCode !== 0) {
      return {
        path: rel,
        ref: rev,
        content: "",
        encoding: "utf8",
        binary: false,
        size: 0,
        exists: false,
        truncated: false,
      };
    }
    return packFileContent(rel, Buffer.from(r.stdout, "utf8"), rev);
  }

  /* ------------------------------------------------------------ staging */

  /** Stage paths (adds, modifications and deletions alike). */
  async stage(repoPath: string, paths: string[]): Promise<void> {
    await this.git(["add", "--all", "--", ...normalizePaths(paths)], repoPath);
  }

  /** Stage every change in the working tree, untracked included. */
  async stageAll(repoPath: string): Promise<void> {
    await this.git(["add", "--all", "."], repoPath);
  }

  /**
   * Unstage paths (index → HEAD). On an unborn branch there is no HEAD to reset
   * against, so the equivalent is dropping them from the index outright.
   */
  async unstage(repoPath: string, paths: string[]): Promise<void> {
    const rels = normalizePaths(paths);
    if (await this.hasHead(repoPath)) {
      await this.git(["reset", "-q", "HEAD", "--", ...rels], repoPath);
    } else {
      await this.git(["rm", "--cached", "-q", "-r", "--", ...rels], repoPath);
    }
  }

  /** Unstage everything. */
  async unstageAll(repoPath: string): Promise<void> {
    if (await this.hasHead(repoPath)) {
      await this.git(["reset", "-q", "HEAD"], repoPath);
    } else {
      await this.git(["rm", "--cached", "-q", "-r", "--", "."], repoPath);
    }
  }

  /**
   * DESTRUCTIVE — throw away working-tree changes for `paths`: untracked files
   * are deleted, tracked ones are restored from the index. Staged content is
   * left alone (unstage first to drop that too). The UI confirms before calling.
   */
  async discard(repoPath: string, paths: string[]): Promise<void> {
    const rels = normalizePaths(paths);
    const status = await this.status(repoPath);
    const untracked = new Set(status.untracked.map((f) => f.path));
    const toDelete = rels.filter((p) => untracked.has(p));
    const toRestore = rels.filter((p) => !untracked.has(p));
    if (toDelete.length) {
      await this.git(["clean", "-f", "-d", "-q", "--", ...toDelete], repoPath);
    }
    if (toRestore.length) {
      await this.git(["checkout", "--", ...toRestore], repoPath);
    }
  }

  /* ------------------------------------------------------------ committing */

  /**
   * Commit the index. `amend` rewrites the tip instead of adding a commit.
   * Returns the resulting commit so the UI can confirm what landed.
   */
  async commit(
    repoPath: string,
    message: string,
    opts: { amend?: boolean } = {},
  ): Promise<GitCommit> {
    const msg = message.trim();
    if (!msg) throw new Error("commit message is empty");
    const args = ["commit", "-m", msg];
    if (opts.amend) args.push("--amend");
    await this.git(args, repoPath);
    const [head] = await this.log(repoPath, { limit: 1 });
    if (!head) throw new Error("commit succeeded but HEAD could not be read");
    return head;
  }

  /* -------------------------------------------------------------- branches */

  /**
   * Switch to an existing branch (or create it off HEAD with `create`).
   *
   * `git checkout` is one of the few builtins that does NOT understand
   * `--end-of-options` — it reads the literal string as a pathspec — so the
   * disambiguator here is the TRAILING `--`, which forces git to resolve the
   * name as a ref and never as a file of the same name. A leading dash is
   * already impossible: `assertRev` rejects it.
   */
  async checkout(
    repoPath: string,
    branch: string,
    opts: { create?: boolean; from?: string } = {},
  ): Promise<void> {
    const name = assertRev(branch);
    const args = opts.create
      ? ["checkout", "-b", name, assertRev(opts.from ?? "HEAD"), "--"]
      : ["checkout", name, "--"];
    await this.git(args, repoPath);
  }

  /** Delete a local branch. `force` drops it even when unmerged. */
  async deleteBranch(
    repoPath: string,
    branch: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    await this.git(
      ["branch", opts.force ? "-D" : "-d", "--end-of-options", assertRev(branch)],
      repoPath,
    );
  }

  /* --------------------------------------------------------------- stashes */

  /** Stash working-tree changes. `includeUntracked` sweeps new files in too. */
  async stashPush(
    repoPath: string,
    opts: { message?: string; includeUntracked?: boolean } = {},
  ): Promise<string> {
    const args = ["stash", "push"];
    if (opts.includeUntracked) args.push("--include-untracked");
    const msg = opts.message?.trim();
    if (msg) args.push("-m", msg);
    const out = await this.git(args, repoPath);
    return out.trim();
  }

  /** Apply a stash, optionally dropping it afterwards (`pop`). */
  async stashApply(
    repoPath: string,
    index: number,
    opts: { pop?: boolean } = {},
  ): Promise<string> {
    const out = await this.git(
      ["stash", opts.pop ? "pop" : "apply", stashRef(index)],
      repoPath,
    );
    return out.trim();
  }

  /** Drop a stash entry. */
  async stashDrop(repoPath: string, index: number): Promise<string> {
    const out = await this.git(["stash", "drop", stashRef(index)], repoPath);
    return out.trim();
  }

  /* --------------------------------------------------------------- remotes */

  /** Fetch, pull or push. `setUpstream` publishes a branch that has none. */
  async sync(
    repoPath: string,
    op: "fetch" | "pull" | "push",
    opts: { setUpstream?: boolean; branch?: string; remote?: string } = {},
  ): Promise<string> {
    const remote = opts.remote ? assertRev(opts.remote) : "origin";
    const args: string[] = [op];
    if (op === "fetch") args.push("--prune", remote);
    if (op === "pull") args.push("--ff-only", remote);
    if (op === "push") {
      if (opts.setUpstream && opts.branch) {
        args.push("--set-upstream", remote, assertRev(opts.branch));
      } else {
        args.push(remote);
      }
    }
    const r = await this.exec("git", args, {
      cwd: repoPath,
      timeout: NETWORK_TIMEOUT_MS,
    });
    if (r.exitCode !== 0) throw gitError(args, r);
    // git reports progress on stderr even on success — that IS the summary.
    return (r.stdout.trim() || r.stderr.trim()).slice(0, 2_000);
  }

  /* ------------------------------------------------------------- internals */

  /** Raw staged diff text — the seed for an AI commit message. */
  async stagedDiff(repoPath: string, maxChars = 24_000): Promise<string> {
    const out = await this.git(
      ["diff", "--cached", "--no-color", "--stat=200", "--patch"],
      repoPath,
    );
    return out.length > maxChars ? `${out.slice(0, maxChars)}\n…(truncated)` : out;
  }

  /** True when HEAD resolves — false on a fresh repo with no commits yet. */
  private async hasHead(repoPath: string): Promise<boolean> {
    const r = await this.exec(
      "git",
      ["rev-parse", "--verify", "--quiet", "HEAD"],
      { cwd: repoPath },
    );
    return r.exitCode === 0;
  }

  /** Run git with an arg array; throw a descriptive error on non-zero exit. */
  private async git(
    args: string[],
    cwd: string,
    timeout?: number,
  ): Promise<string> {
    const r = await this.exec("git", args, { cwd, timeout });
    if (r.exitCode !== 0) throw gitError(args, r);
    return r.stdout;
  }
}

/* =========================================================== pure helpers */

function gitError(args: string[], r: GitExecResult): Error {
  const detail = r.stderr.trim() || r.stdout.trim() || "no output";
  return new Error(`git ${args.join(" ")} failed (exit ${r.exitCode}): ${detail}`);
}

/** `stash@{n}` for a non-negative integer index (never caller text). */
export function stashRef(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`invalid stash index: ${index}`);
  }
  return `stash@{${index}}`;
}

/** Read a working-tree file through the same guards + packing as the viewer. */
async function readWorkingFile(
  repoPath: string,
  rel: string,
): Promise<WorktreeFile> {
  const abs = resolve(repoPath, rel);
  const relToRoot = relative(resolve(repoPath), abs);
  if (!relToRoot || relToRoot.startsWith("..") || isAbsolute(relToRoot)) {
    throw new Error(`relPath escapes the repo: ${rel}`);
  }
  if (!existsSync(abs)) {
    return {
      path: rel,
      content: "",
      encoding: "utf8",
      binary: false,
      size: 0,
      exists: false,
      truncated: false,
    };
  }
  return packFileContent(rel, await fsReadFile(abs));
}

/** Map a porcelain status letter to the domain status. */
export function statusFromCode(code: string): GitChangeStatus {
  switch (code) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    case "U":
      return "conflicted";
    case "?":
      return "untracked";
    default:
      return "unknown";
  }
}

/**
 * Parse `git status --porcelain=v2 --branch -z`.
 *
 * Records are NUL-terminated. A `2` (rename/copy) record is followed by a
 * SEPARATE NUL-terminated field holding the original path — which is exactly
 * why `-z` is worth the parser: without it, paths with spaces or quotes come
 * back C-quoted and ambiguous.
 *
 * A path modified in BOTH the index and the working tree (`MM`) produces two
 * entries: they stage and diff independently, so the UI must list them apart.
 */
export function parsePorcelainV2(out: string): Omit<GitStatus, "repoPath"> {
  const staged: GitFileChange[] = [];
  const unstaged: GitFileChange[] = [];
  const untracked: GitFileChange[] = [];
  const conflicted: GitFileChange[] = [];
  let branch: string | undefined;
  let head: string | undefined;
  let detached = false;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;

  const records = out.split("\0");
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;

    if (rec.startsWith("# ")) {
      const [, key, ...rest] = rec.split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") head = value === "(initial)" ? undefined : value;
      else if (key === "branch.head") {
        if (value === "(detached)") detached = true;
        else branch = value;
      } else if (key === "branch.upstream") upstream = value;
      else if (key === "branch.ab") {
        const m = /^\+(-?\d+)\s+-(-?\d+)$/.exec(value);
        if (m) {
          ahead = Number(m[1]);
          behind = Number(m[2]);
        }
      }
      continue;
    }

    if (rec.startsWith("? ")) {
      const path = rec.slice(2);
      untracked.push({ path, status: "untracked", staged: false, code: "??" });
      continue;
    }
    if (rec.startsWith("! ")) continue; // ignored — never shown

    if (rec.startsWith("1 ") || rec.startsWith("2 ")) {
      const isRename = rec.startsWith("2 ");
      const fields = rec.split(" ");
      // 1: <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>            → path at 8
      // 2: <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>   → path at 9
      const pathIndex = isRename ? 9 : 8;
      const code = fields[1] ?? "..";
      const path = fields.slice(pathIndex).join(" ");
      // The original path of a rename/copy is the NEXT NUL-terminated field.
      const oldPath = isRename ? records[++i] || undefined : undefined;
      if (!path) continue;
      const x = code[0] ?? ".";
      const y = code[1] ?? ".";
      if (x !== "." && x !== "?") {
        staged.push({
          path,
          oldPath,
          status: statusFromCode(x),
          staged: true,
          code,
        });
      }
      if (y !== "." && y !== "?") {
        unstaged.push({
          path,
          // A rename lives in the INDEX; its worktree side is a plain edit of
          // the new path, so carrying oldPath there would misreport it.
          status: statusFromCode(y),
          staged: false,
          code,
        });
      }
      continue;
    }

    if (rec.startsWith("u ")) {
      const fields = rec.split(" ");
      const code = fields[1] ?? "UU";
      const path = fields.slice(10).join(" ");
      if (path) {
        conflicted.push({ path, status: "conflicted", staged: false, code });
      }
      continue;
    }
  }

  const byPath = (a: GitFileChange, b: GitFileChange) =>
    a.path.localeCompare(b.path);
  return {
    branch,
    head,
    detached,
    upstream,
    ahead,
    behind,
    staged: staged.sort(byPath),
    unstaged: unstaged.sort(byPath),
    untracked: untracked.sort(byPath),
    conflicted: conflicted.sort(byPath),
  };
}

/**
 * Parse the `%1f`-delimited `for-each-ref` rows into branches.
 *
 * The FULL refname leads each row precisely so local/remote can be told apart:
 * a remote-tracking ref prints short as `origin/main`, which is shape-identical
 * to a local branch literally named `origin/main`. Only `refs/remotes/…` vs
 * `refs/heads/…` settles it.
 */
export function parseBranchRefs(out: string): GitBranch[] {
  const branches: GitBranch[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [
      refname,
      name,
      headMark,
      upstream,
      track,
      date,
      subject,
      sha,
      worktreePath,
    ] = line.split(US);
    if (!refname || !name) continue;
    // `refs/remotes/origin/HEAD` is a symref alias, not a branch you can visit.
    if (refname.endsWith("/HEAD")) continue;
    const { ahead, behind } = parseTrack(track ?? "");
    const at = Number(date);
    branches.push({
      name,
      isCurrent: headMark === "*",
      isRemote: refname.startsWith("refs/remotes/"),
      upstream: upstream || undefined,
      ahead,
      behind,
      lastCommitAt: Number.isFinite(at) && at > 0 ? at * 1000 : undefined,
      subject: subject || undefined,
      head: sha || undefined,
      worktreePath: worktreePath || undefined,
    });
  }
  return branches.sort(
    (a, b) =>
      Number(b.isCurrent) - Number(a.isCurrent) ||
      Number(a.isRemote) - Number(b.isRemote) ||
      (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0) ||
      a.name.localeCompare(b.name),
  );
}

/** `[ahead 2, behind 1]` / `[gone]` / `` → counts. */
export function parseTrack(track: string): { ahead?: number; behind?: number } {
  if (!track) return {};
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  if (!ahead && !behind) return {};
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
  };
}

/** Parse the RS/US-delimited `git log --format=…` stream. */
export function parseLog(out: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const chunk of out.split(RS)) {
    if (!chunk.trim()) continue;
    const [hash, shortHash, subject, body, author, email, ct, decorations] =
      chunk.split(US);
    if (!hash) continue;
    const at = Number(ct);
    commits.push({
      hash: hash.trim(),
      shortHash: (shortHash ?? "").trim(),
      subject: subject ?? "",
      body: (body ?? "").trim() || undefined,
      author: author ?? "",
      authorEmail: email || undefined,
      at: Number.isFinite(at) ? at * 1000 : 0,
      refs: (decorations ?? "")
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean),
    });
  }
  return commits;
}

/** Parse `git stash list --format=<RS>%gd<US>%ct<US>%gs`. */
export function parseStashList(out: string): GitStash[] {
  const stashes: GitStash[] = [];
  for (const chunk of out.split(RS)) {
    if (!chunk.trim()) continue;
    const [ref, ct, subject] = chunk.split(US);
    const trimmedRef = (ref ?? "").trim();
    const m = /^stash@\{(\d+)\}$/.exec(trimmedRef);
    if (!m) continue;
    const raw = (subject ?? "").trim();
    // `%gs` reads "WIP on main: 1a2b3c subject" or "On main: my message".
    const onBranch = /^(?:WIP on|On) ([^:]+): ?(.*)$/.exec(raw);
    const at = Number(ct);
    stashes.push({
      index: Number(m[1]),
      ref: trimmedRef,
      message: onBranch ? onBranch[2]! || raw : raw,
      branch: onBranch ? onBranch[1] : undefined,
      at: Number.isFinite(at) && at > 0 ? at * 1000 : undefined,
    });
  }
  return stashes;
}

/** Parse `git show --name-status` rows into path → status. */
export function parseNameStatus(out: string): Map<string, GitChangeStatus> {
  const map = new Map<string, GitChangeStatus>();
  for (const line of out.split("\n")) {
    const row = line.replace(/\r$/, "");
    if (!row.trim()) continue;
    const parts = row.split("\t");
    const code = parts[0]?.[0];
    if (!code) continue;
    // R/C rows are `R100<TAB>old<TAB>new` — the CURRENT path is last.
    const path = parts[parts.length - 1];
    if (!path) continue;
    map.set(path, statusFromCode(code));
  }
  return map;
}
