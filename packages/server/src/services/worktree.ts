/**
 * WorktreeService — generic `git worktree` management for any project repo.
 *
 * Mirrors the house `scripts/agent/worktree.mjs` flow (fetch origin/main → add a
 * new branch worktree off it), generalized to any repo via the Project config:
 *   - create(project, branch): fetch the base branch, then
 *       `git worktree add -b <branch> <path> <base>`
 *     where path = <project.worktreeRoot>/<branch-with-slashes-flattened> and
 *     base defaults to `origin/<defaultBranch|main>`. Honors project.worktreeCmd
 *     (e.g. Hivebreak's "pnpm worktree") when set.
 *   - list(project): parse `git worktree list --porcelain`.
 *   - remove(path, force?): `git worktree remove [--force] <path>`.
 *   - diffVsMain(worktreePath, base='main'): structured per-file diffs from the
 *     MERGE-BASE of the branch and its base ref (`git diff --merge-base <base>`),
 *     so a freshly-cut branch shows an empty diff instead of the delta a stale
 *     local base would inject. Combines `--numstat` (counts) + the patch
 *     (status), and appends untracked (newly-created) files as `added` entries.
 *
 * Every git call uses an execa ARGUMENT ARRAY — no shell string interpolation,
 * so branch names / paths can never be shell-injected. Domain changes publish
 * `worktree-update` / `chat-update` / `notice` events on the EventBus.
 */
import { execa } from "execa";
import { existsSync } from "node:fs";
import { mkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import {
  WorktreeInfoSchema,
  BranchInfoSchema,
  type Project,
  type WorktreeInfo,
  type BranchInfo,
} from "@cm/shared";
import type { EventBus } from "../bus.js";
import type { Store } from "../store/index.js";

/* --------------------------------------------------------------- exec seam */

/** Normalized result of running a subprocess. Never throws. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Injectable process runner (tests mock this; prod = execa). */
export type ExecFn = (
  file: string,
  args: string[],
  opts: { cwd: string },
) => Promise<ExecResult>;

/** Default runner: execa with an argument array, never rejecting. */
const realExec: ExecFn = async (file, args, opts) => {
  try {
    const r = await execa(file, args, {
      cwd: opts.cwd,
      reject: false,
      stripFinalNewline: false,
      windowsHide: true,
    });
    return {
      stdout: String(r.stdout ?? ""),
      stderr: String(r.stderr ?? ""),
      exitCode:
        typeof r.exitCode === "number" ? r.exitCode : r.failed ? 1 : 0,
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

/* ------------------------------------------------------------- diff shapes */

export type FileDiffStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed"
  | "unknown";

/** One file's change vs the base, ready to render in a diff viewer. */
export interface FileDiff {
  /** Current path (old path for a pure deletion). */
  path: string;
  /** Source path for renames/copies. */
  oldPath?: string;
  status: FileDiffStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Unified diff for just this file (empty when unavailable, e.g. binary). */
  patch: string;
}

/** Full structured diff of a worktree vs a base ref. */
export interface WorktreeDiff {
  base: string;
  files: FileDiff[];
  additions: number;
  deletions: number;
}

/** A single file's content (working tree or at a base ref) for the Monaco viewer. */
export interface WorktreeFile {
  /** Normalized relative path inside the worktree. */
  path: string;
  /** Base ref when read via `git show <ref>:<path>` (omitted for working tree). */
  ref?: string;
  /** utf8 text, or base64 when `binary`. Empty string when `!exists`. */
  content: string;
  encoding: "utf8" | "base64";
  binary: boolean;
  /** Byte length of the (untruncated) file. */
  size: number;
  /** False when the path doesn't exist (e.g. a file added since the base ref). */
  exists: boolean;
  /** True when content was capped at the size limit. */
  truncated: boolean;
}

/** A single `git diff --numstat` row. */
export interface NumstatEntry {
  additions: number;
  deletions: number;
  binary: boolean;
  path: string;
  oldPath?: string;
}

interface PatchSection {
  status: FileDiffStatus;
  oldPath?: string;
  binary: boolean;
  patch: string;
}

/* ------------------------------------------------------------ service opts */

export interface WorktreeServiceDeps {
  bus?: EventBus;
  store?: Store;
  /** Injectable runner for tests. Defaults to a real execa runner. */
  exec?: ExecFn;
}

export interface CreateWorktreeOptions {
  /** Chat that owns this worktree (tags events + links the chat record). */
  chatId?: string;
  /** Override the base ref. Default: `origin/<project.defaultBranch|main>`. */
  base?: string;
  /** Skip the `git fetch` of the base branch. */
  noFetch?: boolean;
}

export interface RemoveWorktreeOptions {
  force?: boolean;
  chatId?: string;
}

/* ----------------------------------------------------------------- service */

export class WorktreeService {
  private readonly bus?: EventBus;
  private readonly store?: Store;
  private readonly exec: ExecFn;

  /**
   * Optional hook fired after a worktree is removed THROUGH this service (a
   * manager-initiated removal). The container wires it to the WorktreeDetector so
   * its baseline `known` set drops the path — otherwise a worktree recreated at the
   * same path would never be re-attributed. Best-effort; unset in standalone/tests.
   */
  onWorktreeRemoved?: (path: string) => void;

  constructor(deps: WorktreeServiceDeps = {}) {
    this.bus = deps.bus;
    this.store = deps.store;
    this.exec = deps.exec ?? realExec;
  }

  /** Absolute path a worktree for `branch` would live at (slug flattens `/`→`-`). */
  worktreePath(project: Project, branch: string): string {
    const slug = branch.replace(/\//g, "-");
    // resolve() honors an absolute worktreeRoot and joins a relative one to repoPath.
    return join(resolve(project.repoPath, project.worktreeRoot), slug);
  }

  /**
   * Create a new worktree + branch off the latest base. Fetches the base branch
   * first (best-effort), then `git worktree add -b <branch> <path> <base>`.
   */
  async create(
    project: Project,
    branch: string,
    opts: CreateWorktreeOptions = {},
  ): Promise<WorktreeInfo> {
    const wtPath = this.worktreePath(project, branch);
    if (existsSync(wtPath)) {
      throw new Error(`worktree already exists: ${wtPath}`);
    }
    const defaultBranch = project.defaultBranch ?? "main";
    const base = opts.base ?? `origin/${defaultBranch}`;
    const repo = project.repoPath;

    if (project.worktreeCmd) {
      // Honor the project's custom command (e.g. "pnpm worktree"). Branch is a
      // discrete arg — never interpolated into a shell string.
      const tokens = project.worktreeCmd.trim().split(/\s+/).filter(Boolean);
      const [file, ...baseArgs] = tokens;
      if (!file) throw new Error(`invalid worktreeCmd: "${project.worktreeCmd}"`);
      const r = await this.exec(file, [...baseArgs, branch], { cwd: repo });
      if (r.exitCode !== 0) {
        throw new Error(
          `worktreeCmd "${project.worktreeCmd} ${branch}" failed (exit ${r.exitCode}): ${
            r.stderr.trim() || r.stdout.trim()
          }`,
        );
      }
      // The custom command decides the path; locate it by branch match.
      const found = (await this.list(project)).find((w) => w.branch === branch);
      const info = await this.buildInfo(
        project,
        found?.path ?? wtPath,
        branch,
        base,
        opts.chatId,
      );
      await this.publishCreated(info, opts.chatId);
      return info;
    }

    // Generic flow: ensure the worktree root exists, fetch, then add.
    await mkdir(resolve(project.repoPath, project.worktreeRoot), {
      recursive: true,
    });
    if (!opts.noFetch) {
      const f = await this.exec("git", ["fetch", "origin", defaultBranch], {
        cwd: repo,
      });
      if (f.exitCode !== 0) {
        // Non-fatal: a missing remote / offline dev can still branch off an
        // existing local base. Surface a warning, don't abort.
        this.bus?.publish({
          type: "notice",
          chatId: opts.chatId,
          level: "warn",
          text: `git fetch origin ${defaultBranch} failed; branching off existing ${base}`,
        });
      }
    }
    // `--end-of-options` pins `base` as a positional ref so a value like
    // `--lock` / `--force` can't be reinterpreted as a `git worktree add` flag.
    await this.git(
      ["worktree", "add", "-b", branch, wtPath, "--end-of-options", base],
      repo,
    );
    const info = await this.buildInfo(project, wtPath, branch, base, opts.chatId);
    await this.publishCreated(info, opts.chatId);
    return info;
  }

  /** List every worktree registered for the project's repo. */
  async list(project: Project): Promise<WorktreeInfo[]> {
    const out = await this.git(
      ["worktree", "list", "--porcelain"],
      project.repoPath,
    );
    return parseWorktreePorcelain(out).map((w) =>
      WorktreeInfoSchema.parse({ ...w, projectId: project.id }),
    );
  }

  /**
   * List local branches, most-recently-committed first, each tagged with whether
   * it's the primary checkout's current branch and the worktree path (if any) that
   * sits on it. Backs the launch branch/worktree picker. Best-effort: a git failure
   * yields `[]` rather than throwing (the picker still works off worktrees).
   */
  async listBranches(project: Project): Promise<BranchInfo[]> {
    const [refsOut, worktrees] = await Promise.all([
      this.git(
        [
          "for-each-ref",
          "--sort=-committerdate",
          // <short name>\t<committer unix ts>\t<'*' for HEAD>
          "--format=%(refname:short)%09%(committerdate:unix)%09%(HEAD)",
          "refs/heads",
        ],
        project.repoPath,
      ).catch(() => ""),
      this.list(project).catch(() => [] as WorktreeInfo[]),
    ]);
    const worktreeByBranch = new Map(worktrees.map((w) => [w.branch, w.path]));
    const out: BranchInfo[] = [];
    for (const line of refsOut.split("\n")) {
      if (!line.trim()) continue;
      const [name, unix, head] = line.split("\t");
      if (!name) continue;
      const secs = Number(unix);
      out.push(
        BranchInfoSchema.parse({
          name,
          lastCommitAt: Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined,
          isCurrent: head?.trim() === "*",
          worktreePath: worktreeByBranch.get(name),
        }),
      );
    }
    return out;
  }

  /**
   * Resolve the directory to launch a subApp for `branch`:
   *   1. an existing worktree already on that branch, else
   *   2. the primary checkout when IT is on that branch (run in place), else
   *   3. a freshly-added worktree checking out the (existing) branch.
   * Backs branch-based launch from the picker + the `run_subapp` MCP tool.
   */
  async resolveLaunchPath(project: Project, branch: string): Promise<string> {
    const worktrees = await this.list(project);
    const existing = worktrees.find((w) => w.branch === branch);
    if (existing) return existing.path;
    // The primary checkout is the porcelain's first record; match by path.
    const primary = worktrees.find((w) => samePath(w.path, project.repoPath));
    if (primary && primary.branch === branch) return project.repoPath;
    // Add an isolated worktree that checks out the EXISTING branch (no `-b`).
    const path = this.worktreePath(project, branch);
    await this.git(["worktree", "add", path, branch], project.repoPath);
    this.bus?.publish({
      type: "notice",
      level: "info",
      text: `Added worktree for ${branch} at ${path}`,
    });
    return path;
  }

  /** Remove a worktree. Runs from the primary checkout so the target can go away. */
  async remove(
    worktreePath: string,
    force: boolean | RemoveWorktreeOptions = false,
  ): Promise<void> {
    const opts: RemoveWorktreeOptions =
      typeof force === "boolean" ? { force } : force;
    const cwd = await this.primaryRepo(worktreePath);
    const args = [
      "worktree",
      "remove",
      ...(opts.force ? ["--force"] : []),
      worktreePath,
    ];
    await this.git(args, cwd);
    // Notify the detector: this removal happens outside its detection loop, so it
    // must evict the path from its baseline or a recreation at the same path stays
    // undetectable.
    this.onWorktreeRemoved?.(worktreePath);
    if (this.store && opts.chatId) {
      await this.detachFromChat(opts.chatId, worktreePath);
    }
    this.bus?.publish({
      type: "notice",
      chatId: opts.chatId,
      level: "info",
      text: `Removed worktree ${worktreePath}`,
    });
  }

  /**
   * Structured diff of a worktree vs `base` (default "main"). Combines
   * `git diff --numstat` (authoritative line counts) with a per-file split of
   * `git diff` (status + patch text), keyed by path.
   */
  async diffVsMain(
    worktreePath: string,
    base = "main",
  ): Promise<WorktreeDiff> {
    // Diff against the MERGE-BASE of the branch and its base ref so only the
    // branch's OWN changes surface — a freshly-cut branch is empty, never the
    // delta a stale local base would inject. Fall back to local `main` when the
    // requested base (e.g. `origin/main`) doesn't resolve (local-only clone).
    const effBase = await this.resolveDiffBase(worktreePath, base);

    // `--end-of-options` pins `effBase` as a positional ref. Without it a caller-
    // supplied base like `--output=<path>` is a git write primitive (arbitrary
    // file write), reachable via the unauthenticated GET /api/worktrees/diff.
    const numstatOut = await this.git(
      ["diff", "--merge-base", "--numstat", "--end-of-options", effBase],
      worktreePath,
    );
    const patchOut = await this.git(
      ["diff", "--merge-base", "--end-of-options", effBase],
      worktreePath,
    );
    const entries = parseNumstat(numstatOut);
    const sections = splitPatch(patchOut);

    const files: FileDiff[] = [];
    const used = new Set<string>();
    let additions = 0;
    let deletions = 0;

    for (const e of entries) {
      const sec =
        sections.get(e.path) ?? (e.oldPath ? sections.get(e.oldPath) : undefined);
      used.add(e.path);
      if (e.oldPath) used.add(e.oldPath);
      const binary = e.binary || sec?.binary || false;
      const add = binary ? 0 : e.additions;
      const del = binary ? 0 : e.deletions;
      additions += add;
      deletions += del;
      files.push({
        path: e.path,
        oldPath: e.oldPath ?? sec?.oldPath,
        status: sec?.status ?? (e.oldPath ? "renamed" : "modified"),
        additions: add,
        deletions: del,
        binary,
        patch: sec?.patch ?? "",
      });
    }
    // Include any patch sections numstat didn't surface (should be rare).
    for (const [key, sec] of sections) {
      if (used.has(key)) continue;
      used.add(key);
      files.push({
        path: key,
        oldPath: sec.oldPath,
        status: sec.status,
        additions: 0,
        deletions: 0,
        binary: sec.binary,
        patch: sec.patch,
      });
    }
    // `git diff` omits untracked (newly-created) files, so a file an agent just
    // created wouldn't appear. Surface each as an `added` entry.
    for (const f of await this.untrackedFiles(worktreePath, used)) {
      files.push(f);
      additions += f.additions;
      deletions += f.deletions;
    }
    return { base: effBase, files, additions, deletions };
  }

  /**
   * Resolve the ref to compute the merge-base against. Prefers the requested
   * `base` (e.g. `origin/main`); if it doesn't resolve to a commit (no remote in
   * a local-only clone), falls back to local `main` so the diff still works.
   */
  private async resolveDiffBase(worktreePath: string, base: string): Promise<string> {
    if (await this.refExists(worktreePath, base)) return base;
    if (base !== "main" && (await this.refExists(worktreePath, "main"))) return "main";
    return base;
  }

  /** True when `rev` resolves to a commit in the worktree's repo (read-only). */
  private async refExists(cwd: string, rev: string): Promise<boolean> {
    const r = await this.exec(
      "git",
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`],
      { cwd },
    );
    return r.exitCode === 0;
  }

  /**
   * Untracked (newly-created, not-yet-`git add`ed) files as `added` FileDiffs.
   * Reads each file to count added lines (text) / flag binary (0/0) WITHOUT
   * mutating the index. `skip` holds paths already covered by the tracked diff.
   */
  private async untrackedFiles(
    worktreePath: string,
    skip: Set<string>,
  ): Promise<FileDiff[]> {
    let out: string;
    try {
      // `-z` = NUL-separated, unquoted paths (safe for names with spaces).
      out = await this.git(
        ["ls-files", "--others", "--exclude-standard", "-z"],
        worktreePath,
      );
    } catch {
      return [];
    }
    const files: FileDiff[] = [];
    for (const raw of out.split("\0")) {
      if (!raw) continue;
      const rel = normSlashes(raw.replace(/\\/g, "/"));
      if (!rel || skip.has(rel)) continue;
      skip.add(rel);
      files.push(await this.untrackedFileDiff(worktreePath, rel));
    }
    return files;
  }

  /** One untracked file → an `added` FileDiff (line count for text, 0/0 binary). */
  private async untrackedFileDiff(
    worktreePath: string,
    rel: string,
  ): Promise<FileDiff> {
    const added: FileDiff = {
      path: rel,
      status: "added",
      additions: 0,
      deletions: 0,
      binary: false,
      patch: "",
    };
    let buf: Buffer;
    try {
      buf = await fsReadFile(resolve(worktreePath, rel));
    } catch {
      // Vanished between listing and read — surface it as a 0/0 add.
      return added;
    }
    const slice = buf.length > MAX_FILE_BYTES ? buf.subarray(0, MAX_FILE_BYTES) : buf;
    if (looksBinary(slice)) return { ...added, binary: true };
    return { ...added, additions: countLines(slice) };
  }

  /**
   * Read a single file for the Monaco viewer/diff. With no `ref`, reads the
   * working-tree file from disk; with a `ref`, reads it at that base via
   * `git show <ref>:<relPath>` (so the diff editor can show both sides).
   *
   * `relPath` is normalized + guarded to stay inside the worktree (no `..` /
   * absolute escapes), and `ref` is charset-validated, so neither can be turned
   * into a git write primitive or a path traversal via the unauthenticated GET.
   */
  async readFile(
    worktreePath: string,
    relPath: string,
    opts: { ref?: string } = {},
  ): Promise<WorktreeFile> {
    const rel = normalizeRelPath(relPath);
    if (rel === null) throw new Error(`invalid relPath: ${relPath}`);

    if (opts.ref) {
      const ref = opts.ref;
      if (!/^[\w.@/-]+$/.test(ref)) throw new Error(`invalid ref: ${ref}`);
      // `--end-of-options` pins the object spec so a crafted ref can't be read
      // as a flag. A non-zero exit = the path didn't exist at that ref.
      const r = await this.exec(
        "git",
        ["show", "--end-of-options", `${ref}:${rel}`],
        { cwd: worktreePath },
      );
      if (r.exitCode !== 0) {
        return {
          path: rel,
          ref,
          content: "",
          encoding: "utf8",
          binary: false,
          size: 0,
          exists: false,
          truncated: false,
        };
      }
      return packFileContent(rel, Buffer.from(r.stdout, "utf8"), ref);
    }

    const abs = resolve(worktreePath, rel);
    const relToRoot = relative(resolve(worktreePath), abs);
    if (!relToRoot || relToRoot.startsWith("..") || isAbsolute(relToRoot)) {
      throw new Error(`relPath escapes the worktree: ${relPath}`);
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

  /**
   * Write UTF-8 text to a working-tree file. `relPath` is normalized + guarded to
   * stay inside the worktree (same checks as {@link readFile} — no `..`/absolute
   * escapes), so the unauthenticated PUT can't be turned into an arbitrary-path
   * write. Creates parent dirs as needed; refuses content over the size cap.
   * Backs the editable Monaco config editor (`PUT /api/worktrees/file`).
   */
  async writeFile(
    worktreePath: string,
    relPath: string,
    content: string,
  ): Promise<{ path: string; size: number }> {
    const rel = normalizeRelPath(relPath);
    if (rel === null) throw new Error(`invalid relPath: ${relPath}`);

    const abs = resolve(worktreePath, rel);
    const relToRoot = relative(resolve(worktreePath), abs);
    if (!relToRoot || relToRoot.startsWith("..") || isAbsolute(relToRoot)) {
      throw new Error(`relPath escapes the worktree: ${relPath}`);
    }

    const buf = Buffer.from(content, "utf8");
    if (buf.length > MAX_FILE_BYTES) {
      throw new Error(
        `file too large (${buf.length} bytes; max ${MAX_FILE_BYTES})`,
      );
    }
    await mkdir(dirname(abs), { recursive: true });
    await fsWriteFile(abs, buf);
    return { path: rel, size: buf.length };
  }

  /* --------------------------------------------------------- internals */

  /** Run git with an arg array; throw a descriptive error on non-zero exit. */
  private async git(args: string[], cwd: string): Promise<string> {
    const r = await this.exec("git", args, { cwd });
    if (r.exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed (exit ${r.exitCode}): ${
          r.stderr.trim() || r.stdout.trim()
        }`,
      );
    }
    return r.stdout;
  }

  private async buildInfo(
    project: Project,
    wtPath: string,
    branch: string,
    base: string,
    chatId?: string,
  ): Promise<WorktreeInfo> {
    let head: string | undefined;
    try {
      head = (await this.git(["rev-parse", "HEAD"], wtPath)).trim();
    } catch {
      head = undefined;
    }
    return WorktreeInfoSchema.parse({
      path: wtPath,
      branch,
      head,
      base,
      isDirty: false,
      projectId: project.id,
      chatId,
      createdAt: Date.now(),
    } satisfies WorktreeInfo);
  }

  /** The main worktree for the repo containing `fromPath` (first porcelain entry). */
  private async primaryRepo(fromPath: string): Promise<string> {
    try {
      const out = await this.git(
        ["worktree", "list", "--porcelain"],
        fromPath,
      );
      const first = parseWorktreePorcelain(out)[0];
      if (first?.path) return first.path;
    } catch {
      /* fall through to the path itself */
    }
    return fromPath;
  }

  private async publishCreated(
    info: WorktreeInfo,
    chatId?: string,
  ): Promise<void> {
    this.bus?.publish({ type: "worktree-update", chatId, worktree: info });
    if (this.store && chatId) {
      await this.attachToChat(chatId, info.path);
    }
  }

  /**
   * Record a worktree path on its owning chat (idempotent). Returns true when it
   * was newly added. Publishes `chat-update`. PUBLIC so the WorktreeDetector can
   * attribute an agent-created worktree through the very same link path as
   * `create()` — best-effort: a missing store / save failure returns false.
   */
  async attachToChat(chatId: string, path: string): Promise<boolean> {
    if (!this.store) return false;
    try {
      const chat = await this.store.getChat(chatId);
      if (!chat || chat.worktrees.includes(path)) return false;
      const updated = await this.store.saveChat({
        ...chat,
        worktrees: [...chat.worktrees, path],
        updatedAt: Date.now(),
      });
      this.bus?.publish({ type: "chat-update", chat: updated });
      return true;
    } catch {
      /* linking is best-effort; the worktree itself already exists */
      return false;
    }
  }

  /**
   * Remove a worktree path from a chat (idempotent). Returns true when it was
   * present and removed. PUBLIC so the WorktreeDetector can detach a worktree the
   * agent has torn down.
   */
  async detachFromChat(chatId: string, path: string): Promise<boolean> {
    if (!this.store) return false;
    try {
      const chat = await this.store.getChat(chatId);
      if (!chat || !chat.worktrees.includes(path)) return false;
      const updated = await this.store.saveChat({
        ...chat,
        worktrees: chat.worktrees.filter((p) => p !== path),
        updatedAt: Date.now(),
      });
      this.bus?.publish({ type: "chat-update", chat: updated });
      return true;
    } catch {
      /* best-effort */
      return false;
    }
  }
}

/* =========================================================== pure parsers */

/** Cap file reads so a huge/binary file can't blow up memory or the wire. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Two filesystem paths point at the same location (case-insensitive on Windows). */
function samePath(a: string, b: string): boolean {
  const n = (p: string) => resolve(p).replace(/[\\/]+$/, "").toLowerCase();
  return n(a) === n(b);
}

/** Normalize a request relPath → forward-slashed, no leading `/`, no `..` segs. */
export function normalizeRelPath(p: string): string | null {
  const t = String(p).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!t) return null;
  const segs = t.split("/");
  if (segs.some((s) => s === "..")) return null;
  return segs.filter((s) => s !== "." && s !== "").join("/") || null;
}

/** Count lines in a text buffer (matches `git`: a trailing newline adds no line). */
function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  // A final line with no trailing newline still counts.
  if (buf[buf.length - 1] !== 0x0a) n++;
  return n;
}

/** Detect binary content by a NUL byte in the sampled prefix. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Pack a file buffer into a WorktreeFile (utf8 text or base64 for binary).
 * EXPORTED so GitService packs working-tree/index/rev reads identically — the
 * Monaco viewer consumes one shape no matter which service fetched it.
 */
export function packFileContent(rel: string, buf: Buffer, ref?: string): WorktreeFile {
  const truncated = buf.length > MAX_FILE_BYTES;
  const slice = truncated ? buf.subarray(0, MAX_FILE_BYTES) : buf;
  const binary = looksBinary(slice);
  return {
    path: rel,
    ref,
    content: binary ? slice.toString("base64") : slice.toString("utf8"),
    encoding: binary ? "base64" : "utf8",
    binary,
    size: buf.length,
    exists: true,
    truncated,
  };
}

/** Parse `git worktree list --porcelain` into per-worktree records. */
export function parseWorktreePorcelain(out: string): Array<{
  path: string;
  head?: string;
  branch: string;
  locked?: boolean;
}> {
  const records: Array<{
    path: string;
    head?: string;
    branch: string;
    locked?: boolean;
  }> = [];
  type Cur = {
    path: string;
    head?: string;
    branch?: string;
    detached: boolean;
    bare: boolean;
    locked: boolean;
  };
  let cur: Cur | null = null;
  const finalize = (c: Cur) => {
    records.push({
      path: c.path,
      head: c.head,
      branch:
        c.branch ??
        (c.detached ? "(detached)" : c.bare ? "(bare)" : "(unknown)"),
      locked: c.locked,
    });
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) finalize(cur);
      cur = {
        path: line.slice("worktree ".length).trim(),
        detached: false,
        bare: false,
        locked: false,
      };
    } else if (!cur) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      cur.branch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "");
    } else if (line.trim() === "detached") {
      cur.detached = true;
    } else if (line.startsWith("bare")) {
      cur.bare = true;
    } else if (line.startsWith("locked")) {
      cur.locked = true;
    }
  }
  if (cur) finalize(cur);
  return records;
}

/** Collapse repeated path separators (rename brace-expansion can produce `//`). */
function normSlashes(s: string): string {
  return s.replace(/\/{2,}/g, "/");
}

/** Undo git's C-style quoting of a path token (best-effort). */
function unquotePath(tok: string): string {
  const t = tok.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
}

/** Strip a leading `a/`|`b/`; map `/dev/null` to null. */
function stripAbPrefix(tok: string): string | null {
  const u = unquotePath(tok);
  if (u === "/dev/null") return null;
  if (u.startsWith("a/") || u.startsWith("b/")) return u.slice(2);
  return u;
}

/** Resolve a numstat pathspec (handles `old => new` and `dir/{a => b}/x`). */
export function resolveNumstatPath(specRaw: string): {
  path: string;
  oldPath?: string;
} {
  const spec = unquotePath(specRaw.trim());
  const brace = spec.match(/^(.*)\{(.*?) => (.*?)\}(.*)$/);
  if (brace) {
    const [, pre, from, to, post] = brace;
    return {
      path: normSlashes(pre + to + post),
      oldPath: normSlashes(pre + from + post),
    };
  }
  if (spec.includes(" => ")) {
    const [from, to] = spec.split(" => ");
    return { path: to.trim(), oldPath: from.trim() };
  }
  return { path: spec };
}

/** Parse `git diff --numstat <base>` output. */
export function parseNumstat(out: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const addS = parts[0];
    const delS = parts[1];
    const spec = parts.slice(2).join("\t");
    const binary = addS === "-" || delS === "-";
    const { path, oldPath } = resolveNumstatPath(spec);
    entries.push({
      additions: binary ? 0 : Number.parseInt(addS, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(delS, 10) || 0,
      binary,
      path,
      oldPath,
    });
  }
  return entries;
}

/** Split a full `git diff` into per-file sections keyed by current path. */
export function splitPatch(patch: string): Map<string, PatchSection> {
  const map = new Map<string, PatchSection>();
  if (!patch.trim()) return map;
  // Break on each `diff --git` header while keeping it attached to its section.
  const parts = patch.split(/\n(?=diff --git )/);
  for (let raw of parts) {
    const start = raw.indexOf("diff --git");
    if (start < 0) continue;
    if (start > 0) raw = raw.slice(start);
    const lines = raw.split("\n");
    let oldPath: string | undefined;
    let newPath: string | undefined;
    let status: FileDiffStatus = "modified";
    let binary = false;
    for (const line of lines) {
      if (line.startsWith("new file mode")) status = "added";
      else if (line.startsWith("deleted file mode")) status = "deleted";
      else if (line.startsWith("rename from ")) {
        status = "renamed";
        oldPath = unquotePath(line.slice("rename from ".length));
      } else if (line.startsWith("rename to ")) {
        status = "renamed";
        newPath = unquotePath(line.slice("rename to ".length));
      } else if (line.startsWith("copy from ")) {
        status = "copied";
        oldPath = unquotePath(line.slice("copy from ".length));
      } else if (line.startsWith("copy to ")) {
        status = "copied";
        newPath = unquotePath(line.slice("copy to ".length));
      } else if (line.startsWith("--- ")) {
        const p = stripAbPrefix(line.slice(4));
        if (p) oldPath = oldPath ?? p;
      } else if (line.startsWith("+++ ")) {
        const p = stripAbPrefix(line.slice(4));
        if (p) newPath = p;
      } else if (line.startsWith("Binary files ")) {
        binary = true;
      }
    }
    // Fall back to the `diff --git a/x b/y` header (binary/rename-only sections
    // may lack ---/+++ lines).
    if (!newPath || !oldPath) {
      const m = lines[0].match(/^diff --git a\/(.+) b\/(.+)$/);
      if (m) {
        oldPath = oldPath ?? unquotePath(m[1]);
        newPath = newPath ?? unquotePath(m[2]);
      }
    }
    const key = newPath ?? oldPath;
    if (!key) continue;
    map.set(key, {
      status,
      oldPath: oldPath && oldPath !== newPath ? oldPath : undefined,
      binary,
      patch: raw.endsWith("\n") ? raw : `${raw}\n`,
    });
  }
  return map;
}
