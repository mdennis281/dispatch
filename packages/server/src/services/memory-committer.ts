/**
 * MemoryCommitter — lands `.dispatch/memory/` changes as real commits.
 *
 * THE PROBLEM IT SOLVES: memory is project-scoped, not branch-scoped, so
 * {@link MemoryService} always writes to the PRIMARY checkout's
 * `.dispatch/memory/` — never the worktree the agent is running in. That's
 * the right call (worktree-local memory would conflict on every merge, and a
 * memory written in one agent's worktree would be invisible to the others), but
 * it has a nasty consequence: every `remember` lands as an uncommitted change in
 * a directory nobody is looking at. It never reaches the agent's PR, never
 * reaches the remote, and never reaches another machine — it just accumulates as
 * permanent dirt in the checkout until someone notices and commits it by hand.
 *
 * So: watch the memory bus events, debounce a burst into one commit, and commit
 * exactly the memory dir (pathspec-limited, so a human's unrelated staged work is
 * never swept in). Push when the trunk has an upstream.
 *
 * Deliberately conservative — it will decline rather than surprise you:
 *   - only for projects whose workflow profile asks for it (`memory: commit`),
 *   - only when the memory dir actually lives inside the repo,
 *   - only when the primary checkout is sitting on its trunk (a checkout parked
 *     on a feature branch is someone's workspace; don't drop commits on it),
 *   - and never fatally: a failure emits a notice and leaves the files dirty.
 */
import { execa } from "execa";
import { isAbsolute, relative } from "node:path";
import { resolveWorkflow } from "@dispatch/shared";
import type { EventBus } from "../bus.js";
import type { Store } from "../store/index.js";
import { KeyedMutex } from "../store/fsq.js";
import { readCurrentBranch } from "./workflow.js";

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

/* ------------------------------------------------------------------ options */

/** The slice of ProjectConfigService this needs (keeps the dep injectable). */
export interface MemoryDirResolver {
  getConfig(projectId: string): { memoryDir?: string | null } | null | undefined;
}

/** The slice of TrunkSyncService this needs (avoids an import cycle). */
export interface TrunkFastForward {
  syncForProject(projectId: string, trigger: "merge"): Promise<unknown>;
}

export interface MemoryCommitterOptions {
  store: Store;
  bus: EventBus;
  projectConfig: MemoryDirResolver;
  /**
   * Fast-forwards the trunk before we commit onto it. Optional, but without it a
   * local trunk that has fallen behind makes the push a non-fast-forward and the
   * memory commit strands — see {@link commitOnce}.
   */
  trunkSync?: TrunkFastForward;
  /** How long to coalesce a burst of memory writes into one commit. Default 5s. */
  debounceMs?: number;
  exec?: ExecFn;
}

/** Why a flush did (or didn't) produce a commit — surfaced in tests + notices. */
export type MemoryCommitStatus =
  | "committed"
  | "nothing-to-commit"
  | "skipped-policy"
  | "skipped-no-repo-dir"
  | "skipped-off-trunk"
  | "failed";

export interface MemoryCommitResult {
  status: MemoryCommitStatus;
  /** Files committed, relative to the repo root. */
  files: string[];
  /** Set when the commit landed and a push was attempted. */
  pushed?: boolean;
  detail?: string;
}

/* ------------------------------------------------------------------ service */

export class MemoryCommitter {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly projectConfig: MemoryDirResolver;
  private readonly trunkSync?: TrunkFastForward;
  private readonly debounceMs: number;
  private readonly exec: ExecFn;
  private readonly mutex = new KeyedMutex();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private offs: Array<() => void> = [];

  constructor(opts: MemoryCommitterOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.projectConfig = opts.projectConfig;
    this.trunkSync = opts.trunkSync;
    this.debounceMs = opts.debounceMs ?? 5_000;
    this.exec = opts.exec ?? realExec;
  }

  /** Subscribe to memory mutations. Idempotent. */
  start(): void {
    if (this.offs.length) return;
    this.offs.push(this.bus.on("memory-update", (evt) => this.schedule(evt.projectId)));
    this.offs.push(this.bus.on("memory-deleted", (evt) => this.schedule(evt.projectId)));
    // Boot sweep: memories written before this service existed (or while the
    // manager was down) are sitting dirty in the checkout right now, and nothing
    // else will ever come along to commit them — a stale-dirty memory dir is
    // exactly what blocks `sync-main` and strands the trunk.
    const sweep = this.sweep().catch(() => undefined);
    this.inFlight.add(sweep);
    void sweep.finally(() => this.inFlight.delete(sweep));
  }

  /** Flush every project once (used at boot). Never throws. */
  async sweep(): Promise<MemoryCommitResult[]> {
    const projects = await this.store.listProjects().catch(() => []);
    const out: MemoryCommitResult[] = [];
    for (const p of projects) {
      out.push(await this.flush(p.id).catch(() => ({ status: "failed" as const, files: [] })));
    }
    return out;
  }

  /** Unsubscribe and cancel every pending debounce (in-flight work still drains). */
  stop(): void {
    for (const off of this.offs) off();
    this.offs = [];
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Await any in-flight commit so no `git` outlives the process teardown. */
  async drain(): Promise<void> {
    while (this.inFlight.size) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /** Debounce a project's commit; a fresh write restarts the window. */
  private schedule(projectId: string): void {
    const existing = this.timers.get(projectId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(projectId);
      const p = this.flush(projectId).catch(() => undefined);
      this.inFlight.add(p);
      void p.finally(() => this.inFlight.delete(p));
    }, this.debounceMs);
    // Never hold the event loop open for a memory commit.
    timer.unref?.();
    this.timers.set(projectId, timer);
  }

  /**
   * Commit a project's memory dir now (bypassing the debounce). Serialized
   * per-project so two bursts can't race the index. Never throws.
   */
  async flush(projectId: string): Promise<MemoryCommitResult> {
    return this.mutex.run(`memory-commit:${projectId}`, () => this.commitOnce(projectId));
  }

  private async commitOnce(projectId: string): Promise<MemoryCommitResult> {
    const none = (status: MemoryCommitStatus, detail?: string): MemoryCommitResult => ({
      status,
      files: [],
      ...(detail ? { detail } : {}),
    });

    const project = await this.store.getProject(projectId).catch(() => null);
    if (!project) return none("skipped-policy", "no such project");

    const workflow = resolveWorkflow(project);
    if (workflow.memory !== "commit") return none("skipped-policy");

    // Only a repo-backed memory dir is committable; the legacy `.data` store isn't.
    const memoryDir = this.projectConfig.getConfig(projectId)?.memoryDir;
    if (!memoryDir) return none("skipped-no-repo-dir", "project has no .dispatch/ config");
    const rel = relative(project.repoPath, memoryDir).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      return none("skipped-no-repo-dir", `memory dir is outside the repo (${memoryDir})`);
    }

    // A checkout parked on a feature branch belongs to whoever parked it.
    const trunk = project.defaultBranch ?? "main";
    const branch = await readCurrentBranch(project.repoPath).catch(() => null);
    if (branch !== trunk) {
      return none(
        "skipped-off-trunk",
        `primary checkout is on ${branch ?? "a detached HEAD"}, not ${trunk}`,
      );
    }

    // Fast-forward first. A PR that the repo's auto-merge job landed while no
    // chat was watching is never OBSERVED by the manager, so the local trunk can
    // sit behind origin — and then our push is a non-fast-forward and the memory
    // commit strands locally forever. Cheap, and it's the one place that runs
    // often enough to keep the checkout honest. Best-effort by construction.
    await this.trunkSync?.syncForProject(projectId, "merge").catch(() => undefined);

    const git = (...args: string[]) => this.exec("git", args, { cwd: project.repoPath });

    const added = await git("add", "--", rel);
    if (added.exitCode !== 0) {
      return this.fail(projectId, `git add failed: ${added.stderr || added.stdout}`);
    }

    // Scope the staged-diff check to the memory dir so unrelated staged work
    // neither triggers a commit nor gets counted into one.
    const staged = await git("diff", "--cached", "--name-only", "--", rel);
    if (staged.exitCode !== 0) {
      return this.fail(projectId, `git diff --cached failed: ${staged.stderr || staged.stdout}`);
    }
    const files = staged.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
    if (!files.length) return none("nothing-to-commit");

    // Pathspec-limited commit: takes ONLY the memory dir, whatever else is staged.
    const message = commitMessage(files, rel);
    const committed = await git("commit", "-m", message, "--", rel);
    if (committed.exitCode !== 0) {
      return this.fail(projectId, `git commit failed: ${committed.stderr || committed.stdout}`);
    }

    // Push only when the trunk already tracks an upstream — publishing a branch
    // that was deliberately local is not this service's call to make.
    let pushed: boolean | undefined;
    const upstream = await git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
    if (upstream.exitCode === 0 && upstream.stdout.trim()) {
      const push = await git("push");
      pushed = push.exitCode === 0;
      if (!pushed) {
        this.notice(
          projectId,
          `Committed ${files.length} memory file(s) but the push failed: ${
            push.stderr.trim() || push.stdout.trim()
          }`,
          "warn",
        );
      }
    }

    this.notice(projectId, `${message} (${files.length} file(s))`, "info");
    return { status: "committed", files, ...(pushed === undefined ? {} : { pushed }) };
  }

  private fail(projectId: string, detail: string): MemoryCommitResult {
    this.notice(projectId, `Could not commit project memory: ${detail}`, "warn");
    return { status: "failed", files: [], detail };
  }

  private notice(projectId: string, text: string, level: "info" | "warn"): void {
    this.bus.publish({ type: "notice", level, text: `[${projectId}] ${text}` });
  }
}

/** A commit subject that says what actually changed. */
function commitMessage(files: string[], memoryRel: string): string {
  const names = files
    .map((f) => f.slice(f.startsWith(memoryRel) ? memoryRel.length + 1 : 0))
    .map((f) => f.replace(/\.md$/, ""))
    // MEMORY.md is the generated index — it changes on every write, so naming it
    // in the subject would make every commit read "update MEMORY".
    .filter((n) => n !== "MEMORY");
  if (names.length === 1) return `chore(memory): update ${names[0]}`;
  if (names.length > 1) return `chore(memory): update ${names.length} memories`;
  return "chore(memory): regenerate index";
}
