import { create } from "zustand";
import type { WorktreeInfo, PRInfo, WorkflowRun } from "@dispatch/shared";

export interface WorktreeDiff {
  additions: number;
  deletions: number;
  files: { path: string; add: number; del: number }[];
}

interface PanelsStore {
  worktrees: WorktreeInfo[];
  diffs: Record<string, WorktreeDiff>;
  prs: PRInfo[];
  workflowRuns: WorkflowRun[];

  hydrate: (data: {
    worktrees: WorktreeInfo[];
    diffs: Record<string, WorktreeDiff>;
    prs: PRInfo[];
    workflowRuns: WorkflowRun[];
  }) => void;
  upsertWorktree: (wt: WorktreeInfo) => void;
  upsertPr: (pr: PRInfo) => void;
  upsertRun: (run: WorkflowRun) => void;
  /** Cache a worktree's diff-vs-base summary (keyed by worktree path). */
  setDiff: (path: string, diff: WorktreeDiff) => void;
}

/** Right-panel runtime views: worktrees (+diff-vs-main), PRs, and Actions runs. */
export const usePanels = create<PanelsStore>((set) => ({
  worktrees: [],
  diffs: {},
  prs: [],
  workflowRuns: [],

  hydrate: (data) => set({ ...data }),

  upsertWorktree: (wt) =>
    set((s) => {
      const i = s.worktrees.findIndex((w) => w.path === wt.path);
      return {
        worktrees: i === -1 ? [...s.worktrees, wt] : s.worktrees.map((w) => (w.path === wt.path ? wt : w)),
      };
    }),

  upsertPr: (pr) =>
    set((s) => {
      const i = s.prs.findIndex((p) => p.number === pr.number);
      return { prs: i === -1 ? [pr, ...s.prs] : s.prs.map((p) => (p.number === pr.number ? pr : p)) };
    }),

  upsertRun: (run) =>
    set((s) => {
      const i = s.workflowRuns.findIndex((r) => r.id === run.id);
      return {
        workflowRuns: i === -1 ? [run, ...s.workflowRuns] : s.workflowRuns.map((r) => (r.id === run.id ? run : r)),
      };
    }),

  setDiff: (path, diff) => set((s) => ({ diffs: { ...s.diffs, [path]: diff } })),
}));
