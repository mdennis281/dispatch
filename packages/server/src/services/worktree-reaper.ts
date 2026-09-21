/**
 * WorktreeReaper — removes worktrees whose work has landed, so nobody has to
 * remember to.
 *
 * THE PROBLEM. Agents create worktrees; agents do not remove them. Removal was
 * the one step of the loop that only a human ever did, so it only happened when
 * someone noticed. On this repo that reached 91 trees — 87 of them on a branch
 * whose PR had already merged, 90 of them carrying their own `node_modules`.
 * None of them was a mistake. They just never had an ending.
 *
 * THE COST MODEL IS THE DESIGN. Every git subprocess here costs ~6 seconds of
 * pure spawn overhead (a bare `git rev-parse HEAD` was timed at 5.7s, with
 * effectively zero CPU — the wall time is the process launch, not the work), and
 * a `git status` inside a worktree costs ~35s against ~10s in the primary
 * checkout. A reaper written the obvious way — a handful of git calls per tree —
 * would spend forty-five minutes of that overhead to answer one question about
 * one repo. So this file is organized around spending as few subprocesses as it
 * possibly can:
 *
 *   - Refs are SHARED across worktrees, so ahead/behind for every branch comes
 *     from ONE `for-each-ref` in the primary repo. Not one call per tree.
 *   - `merged` is already batched upstream (`WorktreeService.mergedBranches`:
 *     one `for-each-ref --merged` plus the recorded PRs), and already TTL-cached.
 *   - Chat / terminal / runner liveness is in memory. Free.
 *
 * That leaves exactly ONE irreducible per-tree call: the cleanliness probe. It
 * is the gate that stands between this service and deleting somebody's
 * uncommitted afternoon, so it is not negotiable — but it IS the only thing the
 * budget has to be spent on, and everything above is arranged so the probe runs
 * on as few trees as possible.
 *
 * SAFETY DIRECTION. A blocker is never inferred optimistically. `merged` is a
 * tri-state and an `undefined` — no trunk ref resolved, no PR record — reads as
 * `unmerged`, not as permission. A probe that times out reads as `unreadable`,
 * not as clean. Keeping a tree one sweep too long costs disk; removing one too
 * early costs work that existed nowhere else.
 *
 * TWO TRIGGERS, ONE GATE. The hourly sweep and the on-idle chat sweep both call
 * the same `plan()` → `reap()` pair the Source Control cleanup panel calls, so
 * what a human approves in the panel is exactly what the sweep would have done
 * unattended. There is one implementation of "is this safe", and it is `judge()`.
 *
 * WHY NOT REAP ON MERGE. The obvious hook is `approve_pr`: the branch lands, the
 * tree is dead. But the chat that called `approve_pr` is BY DEFINITION mid-turn,
 * and its cwd is that very directory — removing it there yanks the floor out
 * from under a live session. So the on-merge path is the chat-idle sweep
 * instead: the agent finishes, and its landed worktree evaporates behind it.
 */
import { existsSync } from "node:fs";
import { basename, sep } from "node:path";
import {
  type Project,
  type ReapBlocker,
  type ReapCandidate,
  type ReapOutcome,
  type ReapPlan,
  type ReapResult,
  type RunnerInstance,
  type TerminalInfo,
  type WorktreeInfo,
} from "@dispatch/shared";
import type { EventBus } from "../bus.js";
import type { Store } from "../store/index.js";
import {
  canonicalWorktreePath,
  pathKey,
  realExec,
  samePath,
  WorktreeLeftoverError,
  type ExecFn,
} from "./worktree.js";
import type { WorktreeService } from "./worktree.js";

/* --------------------------------------------------------------- tunables */

/**
 * How long after its registry row was created a tree must wait before the
 * unattended sweep will consider it. Not a safety gate so much as a courtesy
 * one: the liveness checks already cover a chat that is actually working, and
 * this covers the seam where a tree was created seconds ago by something that
 * hasn't reported itself yet.
 */
const DEFAULT_GRACE_MS = 15 * 60_000;

/**
 * How many trees the UNATTENDED sweep will probe per pass.
 *
 * Deliberately small. At ~35s per probe this is the sweep's whole wall-clock
 * budget, and the sweep has no user waiting on it — a backlog drains over
 * successive passes rather than pinning a core for an hour. The panel passes its
 * own, much larger cap, because there a human is watching a progress bar and
 * WANTS the complete answer.
 */
const DEFAULT_SWEEP_PROBE_CAP = 12;

/**
 * Concurrent cleanliness probes. The probe is ~100% I/O wait (see the cost model
 * above: near-zero CPU, all wall clock), so concurrency buys close to linear
 * speedup, and the ceiling is git's own disk contention rather than the host's
 * cores.
 */
const DEFAULT_PROBE_CONCURRENCY = 6;

/** Per-probe ceiling. A tree slower than this is reported `unreadable`, never clean. */
const DEFAULT_PROBE_TIMEOUT_MS = 120_000;

/* ------------------------------------------------------------------- deps */

export interface WorktreeReaperDeps {
  store: Store;
  bus?: EventBus;
  worktrees: WorktreeService;
  /** Live shells, for the `terminal-live` gate. Omitted in tests. */
  terminals?: { list(): TerminalInfo[] };
  /** Live subApp processes, for the `runner-live` gate. Omitted in tests. */
  runners?: { list(): Promise<RunnerInstance[]> };
  exec?: ExecFn;
  now?: () => number;
  graceMs?: number;
  sweepProbeCap?: number;
  probeConcurrency?: number;
  probeTimeoutMs?: number;
  /**
   * The live `AppSettings.worktreeCleanup` policy, consulted when an AUTOMATIC
   * pass fires — not once at boot.
   *
   * That distinction is the whole reason this is a function. Reading the setting
   * when the container wires things up would mean switching cleanup on in
   * Settings did nothing until the next restart, which is exactly the kind of
   * toggle people conclude is broken.
   *
   * It gates only `sweep()` and `sweepChat()`. `plan()` and `reap()` stay open,
   * because turning the automation off is a statement about what should happen
   * unattended — the Source Control panel is the human doing it deliberately.
   */
  policy?: () => Promise<{ enabled: boolean; deleteBranch: boolean }>;
}

export interface PlanOptions {
  /** Restrict to one project. Default: every project. */
  projectId?: string;
  /** Restrict to these worktree paths (the chat-idle sweep passes a chat's own). */
  paths?: string[];
  /** Max trees to probe. Default: the sweep cap. Pass `Infinity` for all. */
  probeCap?: number;
  /**
   * Skip the cleanliness probe entirely and return the cheap verdict, with every
   * survivor marked `probed: false`. What the panel opens with, so a list of 91
   * trees appears instantly instead of after several minutes of probing.
   */
  cheapOnly?: boolean;
  /**
   * Don't apply the grace window at all.
   *
   * This has to be a PLAN option rather than something the caller filters out of
   * the result, and that distinction was a bug: only candidates that clear every
   * cheap gate get probed, so a `too-new` blocker suppressed the cleanliness
   * probe, leaving the candidate `probed: false` — and a caller that then tried
   * to ignore `too-new` found nothing it was allowed to act on. With the default
   * 15-minute window that silently disabled the chat-idle sweep for exactly the
   * common case: an agent that finishes within 15 minutes of cutting its tree.
   */
  ignoreGrace?: boolean;
}

export interface ReapOptions {
  /** Also delete the local branch. Only honored where `branchDeletable`. */
  deleteBranch?: boolean;
  /** Chat to attribute the removal notices to. */
  chatId?: string;
}

/**
 * What a branch we couldn't find tracking for is assumed to be: unpushed, unless
 * a merged PR says otherwise. See the use site in {@link WorktreeReaper.judgeCheap}.
 */
const UNKNOWN_TRACK: TrackInfo = { noUpstream: true, gone: false, ahead: 0 };

/** One branch's relationship to its upstream, from the batched `for-each-ref`. */
interface TrackInfo {
  /** No upstream configured at all. */
  noUpstream: boolean;
  /** Upstream configured but the remote ref is gone (merged + auto-deleted). */
  gone: boolean;
  /** Commits the upstream doesn't have. */
  ahead: number;
}

/* ---------------------------------------------------------------- service */

export class WorktreeReaper {
  private readonly store: Store;
  private readonly bus?: EventBus;
  private readonly worktrees: WorktreeService;
  private readonly terminals?: { list(): TerminalInfo[] };
  private readonly runners?: { list(): Promise<RunnerInstance[]> };
  private readonly exec: ExecFn;
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly sweepProbeCap: number;
  private readonly probeConcurrency: number;
  private readonly probeTimeoutMs: number;
  private readonly policy?: () => Promise<{ enabled: boolean; deleteBranch: boolean }>;

  /**
   * `pathKey` → when that tree was last probed, as a position in {@link probeSeq}.
   *
   * This is what makes a capped pass get further than the one before it. The
   * budget used to be the first N survivors in `git worktree list` order, and
   * that order is identical every pass, so twelve dirty trees at the front of
   * the list took the whole budget every hour and nothing behind them was ever
   * looked at. Probing least-recently-probed first means a backlog gets fully
   * covered before any tree is looked at twice.
   *
   * In memory on purpose. Losing it on restart costs one pass that starts from
   * the front again, and that's not worth a table.
   */
  private readonly lastProbed = new Map<string, number>();
  /** A counter, not a clock, so two probes in the same millisecond still have an order. */
  private probeSeq = 0;

  /** Serializes sweeps so an hourly pass and a chat-idle pass can't race. */
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;

  constructor(deps: WorktreeReaperDeps) {
    this.store = deps.store;
    this.bus = deps.bus;
    this.worktrees = deps.worktrees;
    this.terminals = deps.terminals;
    this.runners = deps.runners;
    this.exec = deps.exec ?? realExec;
    this.now = deps.now ?? (() => Date.now());
    this.graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
    this.sweepProbeCap = deps.sweepProbeCap ?? DEFAULT_SWEEP_PROBE_CAP;
    this.probeConcurrency = deps.probeConcurrency ?? DEFAULT_PROBE_CONCURRENCY;
    this.probeTimeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.policy = deps.policy;
  }

  /**
   * The policy for an automatic pass. No `policy` dep (standalone / tests) means
   * fully on; a policy that throws means fully OFF — an automatic deletion must
   * never proceed on the strength of an unreadable setting.
   */
  private async autoPolicy(): Promise<{ enabled: boolean; deleteBranch: boolean }> {
    if (!this.policy) return { enabled: true, deleteBranch: true };
    try {
      return await this.policy();
    } catch {
      return { enabled: false, deleteBranch: false };
    }
  }

  /* ------------------------------------------------------------ planning */

  /**
   * Judge worktrees without touching any of them.
   *
   * Two phases, and the split is the whole performance story: the cheap phase
   * answers every gate but `dirty` for EVERY tree from batched/in-memory state,
   * and the probe phase then enters only the trees that survived it. On this
   * repo that is the difference between 91 probes and ~4.
   */
  async plan(opts: PlanOptions = {}): Promise<ReapPlan> {
    const projects = await this.projects(opts.projectId);
    if (projects.length === 0) {
      return { candidates: [], truncated: false, probed: 0 };
    }

    const [trees, prByBranch, live] = await Promise.all([
      this.listTrees(projects),
      this.mergedPrByBranch(),
      this.liveness(),
    ]);

    // One `for-each-ref` per project, not one `rev-list` per tree. Refs are
    // shared across a repo's worktrees, so the primary checkout can answer for
    // all of them at once.
    //
    // Keyed by PROJECT AND branch, never by branch alone: `main` and `feat/x`
    // exist in most repos, and a flat map would let one project's tracking
    // answer for another's identically-named branch.
    const track = new Map<string, TrackInfo>();
    for (const project of projects) {
      for (const [branch, info] of await this.trackingFor(project)) {
        track.set(branchKey(project.id, branch), info);
      }
    }

    const wanted = opts.paths ? new Set(opts.paths.map(pathKey)) : undefined;

    const candidates: ReapCandidate[] = [];
    for (const { project, tree } of trees) {
      if (wanted && !wanted.has(pathKey(tree.path))) continue;
      candidates.push(
        this.judgeCheap(project, tree, track, prByBranch, live, opts),
      );
    }

    if (opts.cheapOnly) {
      return { candidates, truncated: false, probed: 0 };
    }

    // An unscoped plan saw every tree there is, so a remembered probe for a path
    // it didn't see belongs to a tree that's gone. Scoped plans can't tell that.
    if (!opts.projectId && !wanted) {
      const seen = new Set(candidates.map((c) => pathKey(c.path)));
      for (const key of this.lastProbed.keys()) {
        if (!seen.has(key)) this.lastProbed.delete(key);
      }
    }

    // Only trees that cleared every cheap gate are worth ~35s each, and the ones
    // probed longest ago (or never) go first; see `lastProbed`. `sort` is
    // stable, so trees that tie keep their list order.
    const toProbe = candidates
      .filter((c) => c.blockers.length === 0)
      .sort((a, b) => this.probedAt(a.path) - this.probedAt(b.path));
    const cap = opts.probeCap ?? this.sweepProbeCap;
    const budget = toProbe.slice(0, cap === Infinity ? undefined : cap);
    await this.probeAll(budget);

    return {
      candidates,
      truncated: budget.length < toProbe.length,
      probed: budget.length,
    };
  }

  /**
   * Every cheap gate. Ordered so the answers that cost nothing come first, and
   * `dirty` — the only one needing a subprocess — is left to {@link probe}.
   */
  private judgeCheap(
    project: Project,
    tree: WorktreeInfo,
    track: Map<string, TrackInfo>,
    prByBranch: Map<string, number>,
    live: Liveness,
    opts: PlanOptions,
  ): ReapCandidate {
    const blockers: ReapBlocker[] = [];
    const path = canonicalWorktreePath(tree.path);
    const prNumber = prByBranch.get(branchKey(project.id, tree.branch));

    if (tree.isPrimary || samePath(path, project.repoPath)) {
      blockers.push("primary");
    }
    // A worktree checked out on the trunk is somebody's reference copy, not a
    // task tree — and `merged` would read TRUE for it (a branch is an ancestor
    // of itself), so without this gate the trunk is the FIRST thing reaped.
    if (tree.branch === (project.defaultBranch ?? "main")) {
      blockers.push("default-branch");
    }
    // git's own "don't touch this" flag, reused as the opt-out. Nothing in this
    // repo currently sets it, which is exactly what makes it a clean signal:
    // `git worktree lock` now means something.
    if (tree.locked) blockers.push("locked");
    // Tri-state. `undefined` means nobody could tell, and that is not a yes.
    if (tree.merged !== true) blockers.push("unmerged");
    if (!existsSync(path)) blockers.push("missing");

    // A branch absent from `for-each-ref` — the call failed, or this is a
    // detached HEAD — is treated as having NO upstream rather than skipped.
    // Skipping would mean "we couldn't find out, so assume it's pushed", which
    // is the one direction this file never reasons in.
    const t = track.get(branchKey(project.id, tree.branch)) ?? UNKNOWN_TRACK;
    if (this.hasUnpushedWork(t, prNumber !== undefined)) {
      blockers.push("unpushed");
    }

    if (tree.chatId && live.busyChats.has(tree.chatId)) blockers.push("chat-live");
    if (live.terminalDirs.some((cwd) => isUnder(cwd, path))) {
      blockers.push("terminal-live");
    }
    if (live.runnerPaths.some((p) => samePath(p, path))) blockers.push("runner-live");

    // `createdAt`, NOT `lastSeenAt`. `lastSeenAt` is a sighting stamp: every
    // `list()` re-stamps it once it's 5 minutes stale, and this plan's own
    // `listTrees()` is one of those lists, so it was never more than ~5 minutes
    // old by the time it got here. Read as "touched", it kept every tree inside
    // a 15-minute window forever, and the hourly sweep reaped nothing at all.
    // "Worked in recently" isn't this gate's job anyway. The liveness gates
    // cover a session standing in the tree, and `dirty`/`unpushed` cover work
    // left in it. What's left is the creation seam this window exists for.
    if (
      !opts.ignoreGrace &&
      tree.createdAt !== undefined &&
      this.now() - tree.createdAt < this.graceMs
    ) {
      blockers.push("too-new");
    }

    return {
      path,
      branch: tree.branch,
      projectId: tree.projectId ?? project.id,
      chatId: tree.chatId,
      blockers,
      probed: false,
      // The branch may go only where the work demonstrably landed. `merged`
      // alone is enough — that IS the proof — but a tree we can't even place is
      // not something to delete refs for.
      branchDeletable: tree.merged === true && !tree.isPrimary,
      prNumber,
      lastSeenAt: tree.lastSeenAt ?? tree.createdAt,
    };
  }

  /**
   * Does this branch hold commits the remote never saw?
   *
   * The subtlety is squash-merge, which is what this repo does. A squash rewrites
   * the branch's commits, so after landing, the local branch is NOT an ancestor
   * of the trunk and `origin/main..HEAD` is non-empty forever. Measuring against
   * the trunk would therefore call every landed branch "unpushed" and this
   * service would reap nothing, ever. So the measurement is against the branch's
   * OWN upstream — and when GitHub has auto-deleted that remote branch after the
   * merge, a recorded merged PR is the proof the work landed.
   */
  private hasUnpushedWork(t: TrackInfo, hasMergedPr: boolean): boolean {
    if (t.noUpstream || t.gone) {
      // Never pushed, or the remote ref is gone. A merged PR settles it; without
      // one there is no evidence this branch exists anywhere else.
      return !hasMergedPr;
    }
    return t.ahead > 0;
  }

  /* -------------------------------------------------------------- probing */

  /** Run the cleanliness probe over `candidates`, bounded by the concurrency pool. */
  private async probeAll(candidates: ReapCandidate[]): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        const c = candidates[i];
        if (!c) return;
        this.lastProbed.set(pathKey(c.path), ++this.probeSeq);
        const blocker = await this.probe(c.path);
        c.probed = true;
        if (blocker) c.blockers.push(blocker);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(this.probeConcurrency, candidates.length) },
        worker,
      ),
    );
  }

  /** Where `path` sits in the probe order; a tree never probed sorts first. */
  private probedAt(path: string): number {
    return this.lastProbed.get(pathKey(path)) ?? 0;
  }

  /**
   * The one call that has to enter the tree. Returns the blocker it found, or
   * `undefined` when the tree is clean.
   *
   * `--porcelain` with untracked files INCLUDED: an untracked file is the most
   * dangerous thing here, because it exists in exactly one place on earth and
   * `git worktree remove` will take it without a word.
   */
  private async probe(path: string): Promise<ReapBlocker | undefined> {
    try {
      const r = await this.exec("git", ["status", "--porcelain"], {
        cwd: path,
        timeout: this.probeTimeoutMs,
      });
      if (r.exitCode !== 0) return "unreadable";
      return r.stdout.trim() ? "dirty" : undefined;
    } catch {
      // A timeout or a spawn failure. Unknown is not clean.
      return "unreadable";
    }
  }

  /* -------------------------------------------------------------- removal */

  /**
   * Remove the given worktrees, re-judging every one of them first.
   *
   * The re-judgement is not optional here and that is the point: this is the
   * door the Source Control panel comes through, and minutes can pass between a
   * human reading a list of clean trees and pressing the button. A path that
   * stopped qualifying in that window comes back as a failed outcome carrying
   * its blockers, never as a silent skip.
   *
   * Removal goes through `WorktreeService.remove()` rather than shelling out
   * here, because that is the door that also releases the MCP port lease, drops
   * the registry record, notifies the detector's baseline and detaches the chat.
   * A second removal path would be a second place for all four to be forgotten.
   */
  async reap(paths: string[], opts: ReapOptions = {}): Promise<ReapResult> {
    if (paths.length === 0) return { outcomes: [], removed: 0, failed: 0 };
    // Re-judge, at full probe depth, exactly the paths asked for. Minutes can
    // pass between a human reading the list and pressing the button.
    const plan = await this.plan({ paths, probeCap: Infinity });
    const byPath = new Map(plan.candidates.map((c) => [pathKey(c.path), c]));
    return this.reapJudged(
      paths.map((p) => byPath.get(pathKey(p)) ?? canonicalWorktreePath(p)),
      opts,
    );
  }

  /**
   * Remove trees that have ALREADY been judged.
   *
   * The sweeps call this directly with the candidates they just produced, rather
   * than going back through `reap()` — which would spend the probe cost a second
   * time for no new information, and, in the first version of this file, meant
   * the sweep had no candidate in hand and so silently never deleted a branch
   * despite being asked to. A bare string here is a path that judging could not
   * place at all.
   */
  private async reapJudged(
    items: Array<ReapCandidate | string>,
    opts: ReapOptions,
  ): Promise<ReapResult> {
    const outcomes: ReapOutcome[] = [];
    for (const item of items) {
      if (typeof item === "string") {
        outcomes.push({
          path: item,
          branch: "",
          removed: false,
          error: "no longer a known worktree",
        });
        continue;
      }
      if (item.blockers.length > 0) {
        outcomes.push({
          path: item.path,
          branch: item.branch,
          removed: false,
          blockers: item.blockers,
          error: `not safe to remove: ${item.blockers.join(", ")}`,
        });
        continue;
      }
      outcomes.push(await this.removeOne(item, opts));
    }
    const removed = outcomes.filter((o) => o.removed).length;
    return { outcomes, removed, failed: outcomes.length - removed };
  }

  /** One removal: the tree, then — where the work landed — its branch. */
  private async removeOne(
    candidate: ReapCandidate,
    opts: ReapOptions,
  ): Promise<ReapOutcome> {
    const { path, branch } = candidate;
    // A leftover is not a refusal: the worktree is gone from git and the
    // registry, only files remain on disk (a dev server still holding one open,
    // say). The branch's fate doesn't depend on those files, so it is deleted
    // as it would have been — otherwise a landed branch survived exactly when
    // its tree was hardest to remove. The orphan sweep retries the disk.
    let leftover: WorktreeLeftoverError | undefined;
    try {
      await this.worktrees.remove(path, { chatId: opts.chatId ?? candidate.chatId });
    } catch (err) {
      if (!(err instanceof WorktreeLeftoverError)) {
        return {
          path,
          branch,
          removed: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      leftover = err;
    }
    let branchDeleted = false;
    if (opts.deleteBranch && branch && candidate.branchDeletable) {
      branchDeleted = await this.deleteBranch(candidate.projectId, branch);
    }
    return leftover
      ? { path, branch, removed: false, branchDeleted, error: leftover.message }
      : { path, branch, removed: true, branchDeleted };
  }

  /**
   * Delete a landed local branch. `-D` rather than `-d` on purpose: a
   * squash-merged branch is not an ancestor of the trunk, so `-d` refuses it —
   * which is the same squash problem `hasUnpushedWork` works around, showing up
   * one more time. The authorization for the force is `branchDeletable`, which
   * required a recorded merge; it is not git's judgement being overridden so
   * much as git being asked a question it can't answer here.
   */
  private async deleteBranch(
    projectId: string | undefined,
    branch: string,
  ): Promise<boolean> {
    const project = projectId ? await this.store.getProject(projectId) : null;
    if (!project) return false;
    try {
      const r = await this.exec("git", ["branch", "-D", "--end-of-options", branch], {
        cwd: project.repoPath,
      });
      return r.exitCode === 0;
    } catch {
      return false;
    }
  }

  /* -------------------------------------------------------------- sweeps */

  /**
   * The unattended pass. Plans within the sweep cap and removes what cleared
   * every gate — nothing more; a tree with any blocker is simply left for a
   * later pass, or for a human.
   */
  sweep(opts: { projectId?: string; deleteBranch?: boolean } = {}): Promise<ReapResult> {
    return this.enqueue(async () => {
      const policy = await this.autoPolicy();
      if (!policy.enabled) return { outcomes: [], removed: 0, failed: 0 };
      const plan = await this.plan({ projectId: opts.projectId });
      const ready = plan.candidates.filter((c) => c.blockers.length === 0 && c.probed);
      // Straight to `reapJudged`: these were judged microseconds ago at full
      // depth, and re-judging would double the sweep's only real cost.
      const trees =
        ready.length === 0
          ? { outcomes: [], removed: 0, failed: 0 }
          : await this.reapJudged(ready, {
              deleteBranch: opts.deleteBranch ?? policy.deleteBranch,
            });
      const orphans = await this.sweepOrphans(opts.projectId);
      const result = mergeResults(trees, orphans);
      this.announce(result);
      return result;
    });
  }

  /**
   * Delete the directories a removal left behind: children of a project's
   * worktree root that `git worktree list` does not report and that have no
   * git identity of their own.
   *
   * These exist because `git worktree remove` on Windows destroys a tree's
   * `.git` file and then dies on the first junction in `node_modules` (see
   * `WorktreeService.remove`). Once git's admin record is pruned the directory
   * is invisible to `plan()` — which enumerates through git — so a reaper that
   * only judged worktrees would leave every one of them forever, at 200MB+
   * apiece. There is no cleanliness probe here because there is nothing to
   * probe: without a `.git` there is no index to compare against, and git's
   * own refusal gate already ran, and passed, before it unlinked that file.
   * The one check that matters — no `.git` — is re-done at deletion time.
   */
  private async sweepOrphans(projectId?: string): Promise<ReapResult> {
    const outcomes: ReapOutcome[] = [];
    for (const project of await this.projects(projectId)) {
      let live: WorktreeInfo[];
      try {
        live = await this.worktrees.list(project);
      } catch {
        // No `git worktree list` means no idea what's live. Skip the project
        // rather than treat every directory in its root as unclaimed.
        continue;
      }
      const dirs = await this.worktrees.listOrphanDirectories(project, live).catch(() => []);
      for (const path of dirs) {
        try {
          await this.worktrees.removeOrphanDirectory(path);
          outcomes.push({ path, branch: "", removed: true });
        } catch (err) {
          outcomes.push({
            path,
            branch: "",
            removed: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    const removed = outcomes.filter((o) => o.removed).length;
    return { outcomes, removed, failed: outcomes.length - removed };
  }

  /**
   * The on-idle pass: when a chat's turn ends, clean up the trees IT owns.
   *
   * This is the "reap on merge" path, deferred to the only moment it is safe.
   * `approve_pr` lands the branch mid-turn, with the agent's cwd inside the very
   * tree that just became disposable — so the removal waits for the turn to end,
   * and then the tree is simply gone. No grace window applies: the work landed
   * and the owner has stopped, which is more evidence than the timer stands in for.
   */
  sweepChat(chatId: string, opts: { deleteBranch?: boolean } = {}): Promise<ReapResult> {
    return this.enqueue(async () => {
      const policy = await this.autoPolicy();
      if (!policy.enabled) return { outcomes: [], removed: 0, failed: 0 };
      const chat = await this.store.getChat(chatId).catch(() => null);
      const paths = chat?.worktrees ?? [];
      if (paths.length === 0) return { outcomes: [], removed: 0, failed: 0 };
      // `ignoreGrace`: the grace window stands in for "has this settled?", and
      // the owning chat going idle answers that question outright.
      const plan = await this.plan({ paths, probeCap: Infinity, ignoreGrace: true });
      const ready = plan.candidates.filter(
        (c) => c.probed && c.blockers.length === 0,
      );
      if (ready.length === 0) return { outcomes: [], removed: 0, failed: 0 };
      const result = await this.reapJudged(ready, {
        deleteBranch: opts.deleteBranch ?? policy.deleteBranch,
        chatId,
      });
      this.announce(result, chatId);
      return result;
    });
  }

  /* ----------------------------------------------------------- lifecycle */

  /** Arm the periodic sweep. `unref`ed so it can never hold the process open. */
  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch(() => {});
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Await any in-flight sweep (tests / graceful shutdown). */
  drain(): Promise<unknown> {
    return this.chain;
  }

  /* ------------------------------------------------------------- helpers */

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    // Swallow on the CHAIN only, so one failed sweep doesn't poison the next —
    // the caller still sees the rejection through `next`.
    this.chain = next.catch(() => {});
    return next;
  }

  private async projects(projectId?: string): Promise<Project[]> {
    if (projectId) {
      const p = await this.store.getProject(projectId).catch(() => null);
      return p ? [p] : [];
    }
    return this.store.listProjects().catch(() => []);
  }

  /** Every project's worktrees, tagged with the project they came from. */
  private async listTrees(
    projects: Project[],
  ): Promise<Array<{ project: Project; tree: WorktreeInfo }>> {
    const per = await Promise.all(
      projects.map(async (project) => {
        const trees = await this.worktrees.list(project).catch(() => []);
        return trees.map((tree) => ({ project, tree }));
      }),
    );
    return per.flat();
  }

  /**
   * `branch → PR number` for every branch with a merged PR on record.
   *
   * The same source `WorktreeService.mergedBranches` reads for its second half,
   * kept here as a map rather than a set because the panel shows the PR number:
   * "#97, merged" is a reason a human can check, where "merged" alone is this
   * service asking to be trusted.
   */
  private async mergedPrByBranch(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    try {
      for (const chat of await this.store.listChats()) {
        for (const pr of chat.prs ?? []) {
          if (pr.state === "merged" && pr.branch) {
            // Keyed by the CHAT's project, for the same reason `track` is: a
            // merged `feat/x` in one repo must not vouch for an unpushed
            // `feat/x` in another.
            const key = branchKey(chat.projectId, pr.branch);
            // Lowest number wins a tie: the first PR to land a branch is the one
            // that landed it; a later re-use of the name isn't the evidence.
            const prev = out.get(key);
            if (prev === undefined || pr.number < prev) out.set(key, pr.number);
          }
        }
      }
    } catch {
      /* an unreadable chat must not make every branch look unlanded — but it
         does make them look UNPUSHED, which is the safe direction. */
    }
    return out;
  }

  /**
   * Ahead/behind for every local branch, in ONE subprocess.
   *
   * `%(upstream:track)` renders as `[ahead 2]`, `[behind 3]`, `[ahead 1, behind 4]`,
   * `[gone]`, or empty. Parsing that beats N `rev-list --count` calls by the
   * entire cost model at the top of this file.
   */
  private async trackingFor(project: Project): Promise<Map<string, TrackInfo>> {
    const out = new Map<string, TrackInfo>();
    try {
      const r = await this.exec(
        "git",
        [
          "for-each-ref",
          "--format=%(refname:short)%09%(upstream)%09%(upstream:track)",
          "--end-of-options",
          "refs/heads",
        ],
        { cwd: project.repoPath },
      );
      if (r.exitCode !== 0) return out;
      for (const line of r.stdout.split("\n")) {
        if (!line.trim()) continue;
        const [branch = "", upstream = "", trackRaw = ""] = line.split("\t");
        if (!branch) continue;
        const track = trackRaw.trim();
        out.set(branch, {
          noUpstream: upstream.trim() === "",
          gone: track === "[gone]",
          ahead: Number(/\bahead (\d+)/.exec(track)?.[1] ?? 0),
        });
      }
    } catch {
      /* no tracking info → every branch reads as having no upstream, which reads
         as unpushed unless a merged PR says otherwise. Safe direction. */
    }
    return out;
  }

  /** In-memory liveness: which chats are working, which dirs are held. */
  private async liveness(): Promise<Liveness> {
    const busyChats = new Set<string>();
    try {
      for (const chat of await this.store.listChats()) {
        if (chat.status && LIVE_CHAT_STATUS.has(chat.status)) busyChats.add(chat.id);
      }
    } catch {
      /* ignore — the terminal/runner gates still cover an actually-busy tree */
    }
    // `live` only: an exited shell's recorded cwd is a historical fact, not a
    // process standing in the directory, and treating it as one would pin every
    // tree any agent ever `cd`-ed into.
    const terminalDirs = (this.terminals?.list() ?? [])
      .filter((t) => t.status === "live")
      .map((t) => t.cwd)
      .filter(Boolean);
    let runnerPaths: string[] = [];
    try {
      runnerPaths = (await this.runners?.list() ?? [])
        .filter((r) => r.status === "starting" || r.status === "running")
        .map((r) => r.worktreePath)
        .filter(Boolean);
    } catch {
      /* ignore */
    }
    return { busyChats, terminalDirs, runnerPaths };
  }

  /** One notice per sweep that actually did something. Silence when it didn't. */
  private announce(result: ReapResult, chatId?: string): void {
    if (result.removed > 0) {
      // The names go in the TEXT, not a detail field — a `notice` has no detail,
      // and "cleaned up 12 worktrees" without naming them is exactly the kind of
      // unattended deletion nobody can audit after the fact. An orphan has no
      // branch any more, so it is named by its directory.
      const names = result.outcomes
        .filter((o) => o.removed)
        .map((o) => o.branch || basename(o.path));
      this.bus?.publish({
        type: "notice",
        chatId,
        level: "info",
        text:
          result.removed === 1
            ? `Cleaned up merged worktree ${names[0]}`
            : `Cleaned up ${result.removed} merged worktrees: ${names.join(", ")}`,
      });
    }
    // A removal that git or the filesystem refused must be said out loud. The
    // first version of this only spoke when something was removed, so a sweep
    // that failed on every tree — which on Windows was every sweep — was silent,
    // and ~100 dead trees accumulated with nothing to say why.
    const failures = result.outcomes.filter((o) => !o.removed && !o.blockers);
    if (failures.length > 0) {
      const named = failures
        .slice(0, 3)
        .map((o) => `${o.branch || basename(o.path)}: ${o.error ?? "unknown"}`);
      const more = failures.length > 3 ? ` (+${failures.length - 3} more)` : "";
      this.bus?.publish({
        type: "notice",
        chatId,
        level: "warn",
        text: `Worktree cleanup could not remove ${failures.length === 1 ? "a tree" : `${failures.length} trees`} — ${named.join("; ")}${more}`,
      });
    }
  }
}

/* ------------------------------------------------------------- internals */

function mergeResults(a: ReapResult, b: ReapResult): ReapResult {
  return {
    outcomes: [...a.outcomes, ...b.outcomes],
    removed: a.removed + b.removed,
    failed: a.failed + b.failed,
  };
}

interface Liveness {
  busyChats: Set<string>;
  terminalDirs: string[];
  runnerPaths: string[];
}

/**
 * Map key for "this branch, in this project" — never the bare branch name.
 *
 * The separator is a newline because git forbids one in a ref name and project
 * ids are slugs, so the two halves can never be confused for one another. (A NUL
 * would do the same job, but a literal NUL in a `.ts` file makes git call the
 * whole source binary and GitHub then renders it as an opaque blob.)
 */
function branchKey(projectId: string, branch: string): string {
  return `${projectId}\n${branch}`;
}

/** Chat statuses that mean somebody may be standing in the directory. */
const LIVE_CHAT_STATUS = new Set([
  "running",
  "queued",
  "waiting",
  "awaiting-input",
]);

/**
 * True when `child` is `parent` or lives inside it.
 *
 * Both sides go through `pathKey`, which is the repo's existing answer to
 * "are these the same place" — resolved, de-slashed, and case-folded on Windows
 * where NTFS is. The trailing separator is what keeps `…/feat-ab` from reading
 * as inside `…/feat-a`.
 */
function isUnder(child: string, parent: string): boolean {
  const c = pathKey(child);
  const p = pathKey(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}
