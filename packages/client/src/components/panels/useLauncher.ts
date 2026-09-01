/**
 * Shared launch model for the right-panel RunnerPanel AND the left Sidebar.
 *
 * A "launch target" is a branch you can run a subApp against. It resolves to one
 * of three kinds — the primary repo checkout, an existing worktree, or a bare
 * branch (no worktree yet; the server creates one on launch). The picker is
 * driven off `useLaunchTargets`, and both surfaces call `launchSubApp` so the
 * behaviour (and branch tracking) stays identical.
 */
import { useCallback, useEffect, useState } from "react";
import { create } from "zustand";
import type { BranchInfo, RunnerInstance } from "@dispatch/shared";
import { api } from "../../lib/api.js";
import { actions } from "../../lib/actions.js";
import { usePanels } from "../../stores/panels.js";
import { samePath } from "./panelBus.js";

export type LaunchKind = "repo" | "worktree" | "branch";

export interface LaunchTarget {
  /** Branch name — the stable id used as the picker's controlled value. */
  branch: string;
  kind: LaunchKind;
  /** Run dir for `repo`/`worktree`; undefined for a bare `branch`. */
  worktreePath?: string;
  /** Last-commit date (epoch ms) — the recency sort key. */
  editedAt?: number;
  /** True for the primary checkout's current branch. */
  isCurrent?: boolean;
  /** Working tree has uncommitted changes (best-effort, from the panels store). */
  isDirty?: boolean;
}

function toTarget(b: BranchInfo, dirtyByPath: Map<string, boolean>): LaunchTarget {
  const kind: LaunchKind = b.isCurrent ? "repo" : b.worktreePath ? "worktree" : "branch";
  return {
    branch: b.name,
    kind,
    worktreePath: b.worktreePath,
    editedAt: b.lastCommitAt,
    isCurrent: b.isCurrent,
    isDirty: b.worktreePath ? dirtyByPath.get(norm(b.worktreePath)) : undefined,
  };
}

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Local branches (recency-sorted) as launch targets for a project, enriched with
 * dirty state from the panels store. Re-fetches when the known worktree set
 * changes (a newly created worktree should surface without a manual refresh).
 */
export function useLaunchTargets(projectId: string | undefined): {
  targets: LaunchTarget[];
  loading: boolean;
  reload: () => void;
} {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const worktrees = usePanels((s) => s.worktrees);
  const worktreeKey = worktrees.map((w) => w.path).join("|");

  const reload = useCallback(() => {
    if (!projectId) {
      setBranches([]);
      return;
    }
    setLoading(true);
    api.worktrees
      .branches(projectId)
      .then((b) => setBranches(b))
      .catch(() => setBranches([]))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    reload();
    // worktreeKey in deps: a created/removed worktree changes the branch⇄worktree
    // mapping, so re-pull the branch list to reflect it.
  }, [reload, worktreeKey]);

  const dirtyByPath = new Map(
    worktrees.map((w) => [norm(w.path), !!w.isDirty] as const),
  );
  const targets = branches.map((b) => toTarget(b, dirtyByPath));
  return { targets, loading, reload };
}

/**
 * Pick the default target branch: prefer a specific worktree path (the caller's
 * "current" context, e.g. a chat's worktree), else the primary checkout, else the
 * most-recent branch.
 */
export function defaultBranch(
  targets: LaunchTarget[],
  preferPath?: string,
): string | undefined {
  if (preferPath) {
    const byPath = targets.find(
      (t) => t.worktreePath && samePath(t.worktreePath, preferPath),
    );
    if (byPath) return byPath.branch;
  }
  return (targets.find((t) => t.isCurrent) ?? targets[0])?.branch;
}

/**
 * The selected launch branch, PER PROJECT and shared by every picker.
 *
 * The sidebar's Apps header and the right panel's Runner each held their own
 * `useState` for this, seeded from different hints — so the two pickers could
 * sit on screen at the same time showing different branches while claiming to
 * answer the same question ("which branch does Run use?"). Whichever one you
 * hadn't touched was lying.
 *
 * One value per project. `seed` only fills a slot that is still empty, so the
 * first picker to mount supplies the default (the chat's worktree when there is
 * one, else the project's current branch) and an explicit choice afterwards is
 * never silently overwritten by another picker mounting.
 */
interface LaunchBranchStore {
  byProject: Record<string, string>;
  set: (projectId: string, branch: string) => void;
  seed: (projectId: string, branch: string) => void;
  clear: (projectId: string) => void;
}

const useLaunchBranchStore = create<LaunchBranchStore>((set) => ({
  byProject: {},
  set: (projectId, branch) =>
    set((s) => ({ byProject: { ...s.byProject, [projectId]: branch } })),
  seed: (projectId, branch) =>
    set((s) =>
      s.byProject[projectId] ? s : { byProject: { ...s.byProject, [projectId]: branch } },
    ),
  clear: (projectId) =>
    set((s) => {
      const { [projectId]: _gone, ...rest } = s.byProject;
      return { byProject: rest };
    }),
}));

/**
 * `[branch, setBranch]` for a project's launch picker, plus the resolved target.
 *
 * `preferPath` is only a SEED hint (a chat's worktree, the project checkout) —
 * it decides the default, never an existing choice. A stored branch that no
 * longer exists (worktree removed, branch deleted) is dropped and re-seeded, so
 * the picker can't point at something un-runnable.
 */
export function useLaunchBranch(
  projectId: string | undefined,
  targets: LaunchTarget[],
  preferPath?: string,
): {
  branch: string | undefined;
  setBranch: (branch: string) => void;
  target: LaunchTarget | undefined;
} {
  const branch = useLaunchBranchStore((s) => (projectId ? s.byProject[projectId] : undefined));
  const setStored = useLaunchBranchStore((s) => s.set);
  const seed = useLaunchBranchStore((s) => s.seed);
  const clear = useLaunchBranchStore((s) => s.clear);

  useEffect(() => {
    if (!projectId || targets.length === 0) return;
    if (branch && targets.some((t) => t.branch === branch)) return;
    const next = defaultBranch(targets, preferPath);
    if (!next) return;
    if (branch) clear(projectId);
    seed(projectId, next);
  }, [projectId, targets, branch, preferPath, seed, clear]);

  const setBranch = useCallback(
    (next: string) => {
      if (projectId) setStored(projectId, next);
    },
    [projectId, setStored],
  );

  return { branch, setBranch, target: targets.find((t) => t.branch === branch) };
}

/** Start a subApp on a launch target (branch-tracked; bare branches resolve
 *  a worktree server-side). Shared by the panel + the sidebar. */
export function launchSubApp(
  target: LaunchTarget | undefined,
  subAppId: string,
  projectId: string,
  chatId?: string,
): void {
  if (!target) return;
  actions.startRunner({
    subAppId,
    projectId,
    chatId,
    branch: target.branch,
    worktreePath: target.worktreePath, // undefined ⇒ server resolves/creates
  });
}

/** The live runner (if any) for a subApp on a given branch/path in this scope. */
export function findRunner(
  runners: Record<string, RunnerInstance>,
  opts: { subAppId: string; branch?: string; worktreePath?: string; chatId?: string },
): RunnerInstance | undefined {
  const active = new Set(["starting", "running", "stopping"]);
  const mine = Object.values(runners).filter((r) => {
    if (r.subAppId !== opts.subAppId) return false;
    if (opts.chatId !== undefined && r.chatId !== opts.chatId) return false;
    if (opts.worktreePath && r.worktreePath) return samePath(r.worktreePath, opts.worktreePath);
    if (opts.branch && r.branch) return r.branch === opts.branch;
    return false;
  }).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  // Active wins even when an older run record happens to precede it; otherwise
  // the newest terminal result is the one the sidebar should explain.
  return mine.find((r) => active.has(r.status)) ?? mine[0];
}
