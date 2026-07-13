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
import type { BranchInfo, RunnerInstance } from "@cm/shared";
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
  });
  return mine.find((r) => active.has(r.status)) ?? mine[0];
}
