/**
 * TrunkSyncService — fast-forward a project's primary checkout after its work lands.
 *
 * Under the `review` profile the primary checkout is never where work happens —
 * it just sits on the trunk while agents work in worktrees. Which means nothing
 * ever advances it: it drifts further behind `origin/main` with every merge, and
 * the next worktree cut from a stale local base inherits that drift (or the
 * agent "helpfully" resolves conflicts that only exist because the base was old).
 *
 * So when a PR merges, pull the trunk down. Strictly fast-forward, strictly when
 * the checkout is actually sitting on the trunk, and never fatally — this is
 * housekeeping, not a step anything else waits on.
 */
import { execa } from "execa";
import { isAbsolute, relative } from "node:path";
import { resolveWorkflow, type Project, type WorkflowSyncMain } from "@dispatch/shared";
import type { EventBus } from "../bus.js";
import type { Store } from "../store/index.js";
import { KeyedMutex } from "../store/fsq.js";
import { readCurrentBranch } from "./workflow.js";
import type { ExecFn, ExecResult } from "./memory-committer.js";

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

/** Resolves a project's repo-relative memory dir (see MemoryCommitter). */
export interface MemoryPathResolver {
  getConfig(projectId: string): { memoryDir?: string | null } | null | undefined;
}

export interface TrunkSyncOptions {
  store: Store;
  bus: EventBus;
  /**
   * Lets the sync recognize its own `chore(memory)` commits. Without it, a trunk
   * carrying a local memory commit can never be reconciled once origin moves —
   * see {@link TrunkSyncService.rebaseMemoryOnly}.
   */
  projectConfig?: MemoryPathResolver;
  exec?: ExecFn;
}

export type TrunkSyncStatus =
  | "synced"
  /** Diverged, but the only local commits were memory — replayed onto origin. */
  | "rebased-memory"
  | "already-current"
  | "skipped-policy"
  | "skipped-off-trunk"
  | "skipped-no-remote"
  | "failed";

export interface TrunkSyncResult {
  status: TrunkSyncStatus;
  /** The branch that was (or wasn't) advanced. */
  branch?: string;
  detail?: string;
}

export class TrunkSyncService {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly projectConfig?: MemoryPathResolver;
  private readonly exec: ExecFn;
  private readonly mutex = new KeyedMutex();

  constructor(opts: TrunkSyncOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.projectConfig = opts.projectConfig;
    this.exec = opts.exec ?? realExec;
  }

  /** Sync the project owning a chat. No chat / no project → a no-op. */
  async syncForChat(chatId: string | undefined, trigger: WorkflowSyncMain): Promise<TrunkSyncResult> {
    if (!chatId) return { status: "skipped-policy", detail: "no chat" };
    const chat = await this.store.getChat(chatId).catch(() => null);
    if (!chat?.projectId) return { status: "skipped-policy", detail: "chat has no project" };
    return this.syncForProject(chat.projectId, trigger);
  }

  /** Sync one project by id. */
  async syncForProject(projectId: string, trigger: WorkflowSyncMain): Promise<TrunkSyncResult> {
    const project = await this.store.getProject(projectId).catch(() => null);
    if (!project) return { status: "skipped-policy", detail: "no such project" };
    return this.sync(project, trigger);
  }

  /**
   * Fast-forward `project`'s primary checkout, if its profile asked for a sync at
   * this trigger. Serialized per repo. Never throws.
   */
  async sync(project: Project, trigger: WorkflowSyncMain): Promise<TrunkSyncResult> {
    const workflow = resolveWorkflow(project);
    if (workflow.syncMainAfter !== trigger) return { status: "skipped-policy" };
    return this.mutex.run(`trunk-sync:${project.repoPath}`, () => this.run(project));
  }

  private async run(project: Project): Promise<TrunkSyncResult> {
    const trunk = project.defaultBranch ?? "main";
    const branch = await readCurrentBranch(project.repoPath).catch(() => null);
    if (branch !== trunk) {
      return {
        status: "skipped-off-trunk",
        detail: `primary checkout is on ${branch ?? "a detached HEAD"}, not ${trunk}`,
      };
    }

    const git = (...args: string[]) => this.exec("git", args, { cwd: project.repoPath });

    const fetched = await git("fetch", "origin", trunk);
    if (fetched.exitCode !== 0) {
      // No remote (or offline) is a normal state for a local-only project, not a failure.
      const detail = fetched.stderr.trim() || fetched.stdout.trim();
      return /does not appear to be a git repository|could not read|No such remote/i.test(detail)
        ? { status: "skipped-no-remote", branch: trunk, detail }
        : this.fail(trunk, `git fetch failed: ${detail}`);
    }

    const behind = await git("rev-list", "--count", `HEAD..origin/${trunk}`);
    if (behind.exitCode === 0 && behind.stdout.trim() === "0") {
      return { status: "already-current", branch: trunk };
    }

    // --ff-only: a diverged trunk is generally not something a background job
    // should try to resolve — EXCEPT when the only thing making it diverge is
    // memory commits we made ourselves. See rebaseMemoryOnly.
    const merged = await git("merge", "--ff-only", `origin/${trunk}`);
    if (merged.exitCode !== 0) {
      const rebased = await this.rebaseMemoryOnly(project, trunk, git);
      if (rebased) return rebased;
      return this.fail(trunk, merged.stderr.trim() || merged.stdout.trim());
    }

    this.bus.publish({
      type: "notice",
      level: "info",
      text: `Fast-forwarded ${trunk} in ${project.name} after the merge.`,
    });
    return { status: "synced", branch: trunk };
  }

  /**
   * Reconcile a trunk that diverged *only* because of our own memory commits.
   *
   * This is a real state, not a hypothetical: memory is committed straight onto
   * the local trunk, and if a PR merges upstream before that commit is pushed
   * (the repo's auto-merge job needs nobody watching), local and origin have both
   * moved and no fast-forward exists. Refusing outright would strand that memory
   * commit permanently — which is the exact failure this whole lane exists to
   * prevent.
   *
   * Narrow by construction: every local-only commit must touch nothing outside
   * the project's memory dir. One file anywhere else and we decline, because then
   * it's real work and rebasing it is the human's call. Returns null when the
   * divergence isn't ours to fix.
   */
  private async rebaseMemoryOnly(
    project: Project,
    trunk: string,
    git: (...args: string[]) => Promise<ExecResult>,
  ): Promise<TrunkSyncResult | null> {
    const memoryDir = this.projectConfig?.getConfig(project.id)?.memoryDir;
    if (!memoryDir) return null;
    const rel = relative(project.repoPath, memoryDir).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;

    const local = await git("rev-list", `origin/${trunk}..HEAD`);
    const commits = local.stdout.split("\n").map((c) => c.trim()).filter(Boolean);
    if (local.exitCode !== 0 || !commits.length) return null;

    for (const sha of commits) {
      const files = await git("show", "--name-only", "--pretty=", sha);
      if (files.exitCode !== 0) return null;
      const touched = files.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
      if (!touched.length || touched.some((f) => !f.startsWith(`${rel}/`))) return null;
    }

    const rebased = await git("rebase", `origin/${trunk}`);
    if (rebased.exitCode !== 0) {
      // Leave no half-finished rebase behind for the human to discover.
      await git("rebase", "--abort");
      return null;
    }

    this.bus.publish({
      type: "notice",
      level: "info",
      text:
        `Replayed ${commits.length} memory commit(s) onto the updated ${trunk} in ` +
        `${project.name}.`,
    });
    return { status: "rebased-memory", branch: trunk };
  }

  private fail(branch: string, detail: string): TrunkSyncResult {
    this.bus.publish({
      type: "notice",
      level: "warn",
      text: `Could not fast-forward ${branch}: ${detail}`,
    });
    return { status: "failed", branch, detail };
  }
}
