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
import { basename, join, resolve, relative, isAbsolute, dirname } from "node:path";
import {
  WorktreeInfoSchema,
  BranchInfoSchema,
  applyRegistryQuery,
  type Project,
  type WorktreeInfo,
  type WorktreeOrigin,
  type WorktreeRecord,
  type BranchInfo,
  type RegistryQuery,
} from "@dispatch/shared";
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
  /** How this creation was requested. Default `"ui"` (the panel's form). */
  origin?: WorktreeOrigin;
  /** Optional human label stored on the record. */
  label?: string;
}

export interface RemoveWorktreeOptions {
  force?: boolean;
  chatId?: string;
}

/* ----------------------------------------------------------------- service */

/**
 * How long a "which branches have landed?" answer is reused.
 *
 * Short enough that pressing Refresh after a merge tells the truth, long enough
 * that the modal's own refetch-on-every-control-change doesn't re-shell-out per
 * click. The answer is advisory — it decides a chip and a filter, never an
 * action — so a few seconds of staleness costs nothing.
 */
const MERGED_TTL_MS = 10_000;

export class WorktreeService {
  private readonly bus?: EventBus;
  private readonly store?: Store;
  private readonly exec: ExecFn;

  /** Per-project merged-branch answers, and the app-wide PR half. See {@link mergedBranches}. */
  private readonly mergedByProject = new Map<string, { at: number; branches: Set<string> }>();
  private mergedByPr?: { at: number; branches: Set<string> };

  /**
   * Optional hook fired after a worktree is removed THROUGH this service (a
   * manager-initiated removal). The container wires it to the WorktreeDetector so
   * its baseline `known` set drops the path — otherwise a worktree recreated at the
   * same path would never be re-attributed. Best-effort; unset in standalone/tests.
   */
  onWorktreeRemoved?: (path: string) => void;

  /**
   * MCP port leases, so removing a worktree hands its ports back. Settable after
   * construction because the broker that owns the lease service is built after
   * this one; unset in standalone/tests, where the reclaim-on-allocate path in
   * `McpPortLeaseService` covers it.
   */
  mcpPorts?: { releaseCheckout(path: string): Promise<void> };

  /** Boots each MCP server's `prewarm` command in a newly created worktree.
   *  Settable after construction for the same reason as {@link mcpPorts}. */
  mcpPrewarm?: {
    prewarm(
      project: Project,
      worktreePath: string,
    ): Promise<{ server: string; ok: boolean; error?: string }[]>;
  };

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
        opts,
      );
      await this.publishCreated(info, opts.chatId, project);
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
    const info = await this.buildInfo(project, wtPath, branch, base, opts);
    await this.publishCreated(info, opts.chatId, project);
    return info;
  }

  /**
   * List every worktree registered for the project's repo, each merged with its
   * attribution record.
   *
   * Git answers EXISTENCE (it is the only thing that can — a tree can be removed
   * by another instance, or by hand), the registry answers OWNERSHIP. Every
   * sighting also stamps `lastSeenAt`, which is what lets `removedAt` mean
   * "git stopped reporting this" rather than "nobody looked recently".
   */
  async list(project: Project): Promise<WorktreeInfo[]> {
    const out = await this.git(
      ["worktree", "list", "--porcelain"],
      project.repoPath,
    );
    const live = parseWorktreePorcelain(out).map((w) => ({
      ...w,
      path: canonicalWorktreePath(w.path),
    }));
    // The primary checkout is a worktree to git but not a disposable one to us:
    // it is never attributed to a chat and must never be catalogued as removable.
    const disposable = live.filter((w) => !samePath(w.path, project.repoPath));
    const [records, merged] = await Promise.all([
      this.sync(project, disposable),
      this.mergedBranches(project),
    ]);
    return live.map((w) => {
      const rec = findRecord(records, w.path);
      const isPrimary = samePath(w.path, project.repoPath);
      return WorktreeInfoSchema.parse({
        ...w,
        projectId: rec?.projectId ?? project.id,
        chatId: isPrimary ? undefined : rec?.chatId,
        origin: isPrimary ? undefined : rec?.origin,
        label: rec?.label,
        base: rec?.base,
        createdAt: rec?.createdAt,
        lastSeenAt: rec?.lastSeenAt,
        isPrimary: isPrimary || undefined,
        // The trunk is not "merged into itself", and a detached HEAD (branch
        // `(detached)`) is not a branch — both are left UNKNOWN rather than
        // answered `false`, which would read as "has unlanded work".
        merged:
          isPrimary || !merged || w.branch.startsWith("(")
            ? undefined
            : merged.has(w.branch),
      });
    });
  }

  /**
   * The branches whose work is already on the trunk — or `null` when nothing
   * could tell us. ONE git call per project, never one per worktree: at ~70
   * trees a per-tree `rev-list` would put ~3s of process spawns in front of
   * every list, and this is a chip, not a gate.
   *
   * Two sources, unioned, because each misses what the other catches:
   *
   *   1. `for-each-ref --merged <trunk>` — git's own ancestry. Exact for a
   *      merge- or rebase-merged branch, and free.
   *   2. The merged PRs Dispatch already recorded on chats (`Chat.prs`). This
   *      is the load-bearing half HERE: this repo squash-merges, and a squash
   *      rewrites the commits, so a landed branch is not an ancestor of the
   *      trunk and source 1 calls it unmerged forever. Without this, "unmerged
   *      only" on a squash-merging repo selects nearly everything.
   *
   * The gap left over is a branch squash-merged outside Dispatch, with no PR
   * record: it reads as unmerged. That is the safe direction — the filter shows
   * a tree you may not need, rather than hiding one that still holds work.
   */
  private async mergedBranches(project: Project): Promise<Set<string> | null> {
    const now = Date.now();
    const cached = this.mergedByProject.get(project.id);
    if (cached && now - cached.at < MERGED_TTL_MS) return cached.branches;
    const [ancestors, landed] = await Promise.all([
      this.branchesMergedIntoTrunk(project),
      this.branchesWithMergedPr(),
    ]);
    // Neither source could answer → `undefined`, not "nothing is merged".
    if (!ancestors && !landed) return null;
    const branches = new Set([...(ancestors ?? []), ...(landed ?? [])]);
    this.mergedByProject.set(project.id, { at: now, branches });
    return branches;
  }

  /** Source 1: local branches that are ancestors of the trunk. `null` = couldn't ask. */
  private async branchesMergedIntoTrunk(project: Project): Promise<Set<string> | null> {
    const def = project.defaultBranch ?? "main";
    // `origin/<default>` is the truth about what has LANDED; local `<default>`
    // is the fallback for a clone with no remote (the same order `diffVsMain`
    // resolves its base in).
    let trunk: string | undefined;
    for (const ref of [`origin/${def}`, def]) {
      if (await this.refExists(project.repoPath, ref)) {
        trunk = ref;
        break;
      }
    }
    if (!trunk) return null;
    const r = await this.exec(
      "git",
      // `--merged=<ref>` rather than a separate argument, and `--end-of-options`
      // before the pattern: neither the ref nor `refs/heads` can then be read as
      // a flag, the same rule every other git call in this file follows.
      ["for-each-ref", "--format=%(refname:short)", `--merged=${trunk}`, "--end-of-options", "refs/heads"],
      { cwd: project.repoPath },
    );
    if (r.exitCode !== 0) return null;
    return new Set(
      r.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  /** Source 2: branches whose recorded PR reached `merged`. `null` = no store. */
  private async branchesWithMergedPr(): Promise<Set<string> | null> {
    if (!this.store) return null;
    const now = Date.now();
    if (this.mergedByPr && now - this.mergedByPr.at < MERGED_TTL_MS) {
      return this.mergedByPr.branches;
    }
    try {
      const branches = new Set<string>();
      for (const chat of await this.store.listChats()) {
        for (const pr of chat.prs ?? []) {
          if (pr.state === "merged" && pr.branch) branches.add(pr.branch);
        }
      }
      this.mergedByPr = { at: now, branches };
      return branches;
    } catch {
      /* an unreadable chat must not make every worktree look unmerged */
      return null;
    }
  }

  /**
   * Every worktree across every project, for the app-wide catalog scope.
   *
   * A project whose repo has gone missing yields nothing rather than failing the
   * whole sweep — one broken project must not blank the modal.
   */
  async listAll(projects: Project[], query?: RegistryQuery): Promise<WorktreeInfo[]> {
    const per = await Promise.all(
      projects.map((p) => this.list(p).catch(() => [] as WorktreeInfo[])),
    );
    const all = per.flat();
    if (!query) return all;
    return applyRegistryQuery(all, query, {
      text: (w) => [w.path, w.branch, w.label, w.origin],
      touchedAt: (w) => w.lastSeenAt ?? w.createdAt,
      createdAt: (w) => w.createdAt,
      name: (w) => w.branch,
      origin: (w) => w.origin,
      facets: {
        // UNKNOWN counts as unmerged. A tree whose state nobody could determine
        // is exactly the one worth looking at; hiding it would be the filter
        // quietly deciding the work has landed.
        unmerged: (w) => !w.isPrimary && w.merged !== true,
        // The primary checkout has no owning chat BY DESIGN, so it is never the
        // answer to "what did the registry fail to attribute?".
        unattributed: (w) => !w.isPrimary && !w.chatId,
      },
    });
  }

  /**
   * Reconcile the registry against what git just reported, and hand back the
   * rows to merge. Degrades to `[]` (no store, or a store error) so listing a
   * project's worktrees never fails because the CATALOG is unhappy.
   */
  private async sync(
    project: Project,
    live: Array<{ path: string; branch: string }>,
  ): Promise<WorktreeRecord[]> {
    if (!this.store) return [];
    try {
      return await this.store.syncWorktreeRecords(project.id, live, { key: pathKey });
    } catch {
      return [];
    }
  }

  /** All attribution records; `[]` when there's no store (standalone/tests). */
  private async records(): Promise<WorktreeRecord[]> {
    if (!this.store) return [];
    try {
      return await this.store.listWorktreeRecords();
    } catch {
      return [];
    }
  }

  /**
   * Write (or update) the attribution for a path. PUBLIC so the detector can
   * back-fill a harness-created tree through the same door `create()` uses —
   * one writer, one shape, one place to look when a row is wrong.
   */
  async recordWorktree(
    path: string,
    create: Omit<WorktreeRecord, "path" | "createdAt" | "lastSeenAt">,
    update: Partial<Omit<WorktreeRecord, "path">> = {},
  ): Promise<WorktreeRecord | null> {
    if (!this.store) return null;
    try {
      return await this.store.upsertWorktreeRecord(
        canonicalWorktreePath(path),
        create,
        update,
      );
    } catch {
      /* attribution is best-effort; the worktree itself is unaffected */
      return null;
    }
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
    // Attributed to no chat on purpose: this tree exists to host a subApp for a
    // branch, and claiming it for whichever chat happened to press Launch would
    // be a guess of exactly the kind the registry replaces.
    await this.recordWorktree(path, {
      projectId: project.id,
      branch,
      origin: "tool",
      label: `launch: ${branch}`,
    });
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
    await this.forgetRecord(worktreePath);
    // Hand back this checkout's MCP ports. The lease service also reclaims leases
    // whose directory has vanished, so a missed release self-heals — but only on
    // the next allocation, which is too late for the run that finds the band full.
    await this.mcpPorts?.releaseCheckout(worktreePath).catch(() => {});
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

  /**
   * The commit `git diff --merge-base <base>` would diff against: the fork
   * point of HEAD and the (resolved) base ref. Falls back to the resolved ref
   * itself when there is no common ancestor — an unrelated history still
   * renders a diff rather than an error.
   */
  private async mergeBaseOf(worktreePath: string, base: string): Promise<string> {
    const eff = await this.resolveDiffBase(worktreePath, base);
    const r = await this.exec(
      "git",
      ["merge-base", "--end-of-options", "HEAD", eff],
      { cwd: worktreePath },
    );
    const sha = r.stdout.trim();
    return r.exitCode === 0 && sha ? sha : eff;
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
    opts: { ref?: string; mergeBase?: boolean } = {},
  ): Promise<WorktreeFile> {
    const rel = normalizeRelPath(relPath);
    if (rel === null) throw new Error(`invalid relPath: ${relPath}`);

    if (opts.ref) {
      const ref = opts.ref;
      if (!/^[\w.@/-]+$/.test(ref)) throw new Error(`invalid ref: ${ref}`);
      // The viewer opens from the file list, which {@link diffVsMain} computes
      // with `git diff --merge-base`. Reading the base side at the TIP of the
      // ref made the two disagree: every commit that landed on `main` after the
      // branch was cut rendered in the viewer as a hunk the branch never made,
      // on files the list didn't even mention. `mergeBase` asks for the same
      // point in history the list used.
      const spec = opts.mergeBase
        ? await this.mergeBaseOf(worktreePath, ref)
        : ref;
      // `--end-of-options` pins the object spec so a crafted ref can't be read
      // as a flag. A non-zero exit = the path didn't exist at that ref.
      const r = await this.exec(
        "git",
        ["show", "--end-of-options", `${spec}:${rel}`],
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
    opts: CreateWorktreeOptions,
  ): Promise<WorktreeInfo> {
    let head: string | undefined;
    try {
      head = (await this.git(["rev-parse", "HEAD"], wtPath)).trim();
    } catch {
      head = undefined;
    }
    const path = canonicalWorktreePath(wtPath);
    // The record is written HERE, in the same call that ran `git worktree add` —
    // that is the entire fix. Attribution stops being something the detector has
    // to reconstruct from shell commands and transcripts after the fact.
    const rec = await this.recordWorktree(path, {
      projectId: project.id,
      branch,
      chatId: opts.chatId,
      origin: opts.origin ?? "ui",
      base,
      label: opts.label,
    });
    return WorktreeInfoSchema.parse({
      path,
      branch,
      head,
      base,
      isDirty: false,
      projectId: project.id,
      chatId: opts.chatId,
      origin: opts.origin ?? "ui",
      label: opts.label,
      createdAt: rec?.createdAt ?? Date.now(),
      lastSeenAt: rec?.lastSeenAt,
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
    project?: Project,
  ): Promise<void> {
    this.bus?.publish({ type: "worktree-update", chatId, worktree: info });
    if (this.store && chatId) {
      await this.attachToChat(chatId, info.path);
    }
    if (project) this.startPrewarm(info, chatId, project);
  }

  /**
   * Kick off MCP prewarm for a new worktree. Deliberately NOT awaited: a prewarm
   * typically boots a dev server, which by design does not exit — awaiting it
   * would hold worktree creation open until the timeout. The caller gets its
   * worktree immediately and each server reports through a notice when it
   * settles.
   */
  private startPrewarm(info: WorktreeInfo, chatId: string | undefined, project: Project): void {
    if (!this.mcpPrewarm) return;
    void this.mcpPrewarm
      .prewarm(project, info.path)
      .then((results) => {
        for (const r of results) {
          this.bus?.publish({
            type: "notice",
            chatId,
            level: r.ok ? "info" : "warn",
            text: r.ok
              ? `Prewarmed MCP "${r.server}" in ${basename(info.path)}`
              : `Prewarm for MCP "${r.server}" failed: ${r.error ?? "unknown error"}`,
          });
        }
      })
      // A prewarm must never take the worktree down with it.
      .catch(() => {});
  }

  /**
   * Record a worktree path on its owning chat (idempotent). Returns true when it
   * was newly added. Publishes `chat-update`. PUBLIC so the WorktreeDetector can
   * attribute an agent-created worktree through the very same link path as
   * `create()` — best-effort: a missing store / save failure returns false.
   */
  async attachToChat(chatId: string, path: string): Promise<boolean> {
    if (!this.store) return false;
    // The record is the catalog's answer to "whose is this?", so it is updated
    // even when the chat already listed the path — the two used to be able to
    // disagree, and only one of them is visible in the Workspace view.
    await this.setRecordChat(path, chatId);
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
    await this.setRecordChat(path, undefined);
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

  /**
   * Point an existing row at a chat (or clear it). Silent when the registry has
   * never heard of the path: attribution for a tree we don't track yet is the
   * detector's job, and inventing a row here would guess its origin.
   */
  private async setRecordChat(path: string, chatId?: string): Promise<void> {
    if (!this.store) return;
    try {
      const rec = findRecord(await this.records(), path);
      if (!rec || rec.chatId === chatId) return;
      await this.store.upsertWorktreeRecord(
        rec.path,
        { projectId: rec.projectId, branch: rec.branch, origin: rec.origin },
        { chatId, lastSeenAt: rec.lastSeenAt },
      );
    } catch {
      /* best-effort */
    }
  }

  /** Drop a row entirely (a removal we performed). Best-effort. */
  private async forgetRecord(path: string): Promise<void> {
    if (!this.store) return;
    try {
      const rec = findRecord(await this.records(), path);
      if (rec) await this.store.deleteWorktreeRecord(rec.path);
    } catch {
      /* best-effort */
    }
  }
}

/* =========================================================== pure parsers */

/** Cap file reads so a huge/binary file can't blow up memory or the wire. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * The form a worktree path is STORED and compared in: absolute, no trailing
 * separator, original case preserved.
 *
 * Case is preserved because the path is shown to a human and used verbatim as a
 * cwd; case-insensitivity belongs in the comparison ({@link pathKey}), not in
 * the value. git's porcelain, `worktreePath()` and a hand-typed API argument
 * can all disagree about trailing slashes and about `..` segments, and a
 * registry keyed by path cannot afford three spellings of one tree.
 */
export function canonicalWorktreePath(p: string): string {
  return resolve(p).replace(/[\\/]+$/, "");
}

/** Comparison key for a path — case-folded on Windows, where NTFS is. */
export function pathKey(p: string): string {
  const c = canonicalWorktreePath(p);
  return process.platform === "win32" ? c.toLowerCase() : c;
}

/** Two filesystem paths point at the same location (case-insensitive on Windows). */
export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** Find a record by path, tolerating case/trailing-separator differences. */
function findRecord(
  records: WorktreeRecord[],
  path: string,
): WorktreeRecord | undefined {
  const k = pathKey(path);
  return records.find((r) => pathKey(r.path) === k);
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
