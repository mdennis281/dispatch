/**
 * Source Control store — everything the Git view (and the sidebar's change
 * count) reads.
 *
 * Scoped to ONE repo directory at a time (`repoPath`): the active project's
 * checkout by default, switchable to any of its worktrees. All git state is
 * derived server-side, so this store holds no optimistic copies — every
 * mutation posts and swallows the FRESH status the server returns with it,
 * which is why a stage/commit never has to guess and can't drift.
 *
 * Errors surface as toasts (git's own stderr is the useful message: "your
 * branch has no upstream", "please commit your changes before switching"), and
 * the store keeps a `busy` label so the UI can disable the control that's
 * mid-flight without freezing the whole panel.
 */
import { create } from "zustand";
import type { GitBranch, GitCommit, GitCommitFile, GitStash, GitStatus } from "@cm/shared";
import { GIT_REV_EMPTY, GIT_REV_INDEX, GIT_REV_WORKTREE } from "@cm/shared";
import { api, ApiError } from "../lib/api.js";
import { useNotices } from "./notices.js";

/** Which list the Git view is showing. */
export type GitTab = "changes" | "history" | "stashes";

/**
 * The two snapshots the diff pane compares. Keeping BOTH sides explicit is what
 * lets one pane serve every case — staged (HEAD↔INDEX), unstaged
 * (INDEX↔WORKTREE), a commit (`sha^`↔`sha`) and a stash (`stash@{n}^1`↔`stash@{n}`).
 */
export interface GitSelection {
  relPath: string;
  /** Left/original side rev, or `EMPTY` when there is none (a new file). */
  leftRev: string;
  /** Right/modified side rev. */
  rightRev: string;
  /** Short label for the diff header ("staged", "working tree", "a1b2c3d"). */
  label: string;
  /** True for a working-tree right side — the only case that's editable. */
  live?: boolean;
}

interface GitStore {
  /** The repo directory every call is scoped to (null until a project loads). */
  repoPath: string | null;
  status: GitStatus | null;
  branches: GitBranch[];
  commits: GitCommit[];
  stashes: GitStash[];
  /** Files of an expanded commit, keyed by full sha (lazy, cached per view). */
  commitFiles: Record<string, GitCommitFile[]>;

  tab: GitTab;
  selection: GitSelection | null;
  /** Draft commit message (survives tab switches). */
  message: string;
  amend: boolean;

  loading: boolean;
  error: string | null;
  /** Label of the in-flight mutation, or null. Drives per-control spinners. */
  busy: string | null;

  setRepoPath: (path: string | null) => void;
  setTab: (tab: GitTab) => void;
  select: (selection: GitSelection | null) => void;
  setMessage: (message: string) => void;
  setAmend: (amend: boolean) => void;

  /** Re-read status (+ the active tab's list). Cheap; safe to poll. */
  refresh: (opts?: { full?: boolean }) => Promise<void>;
  loadCommitFiles: (sha: string) => Promise<void>;
  /** Run a mutation with busy/error/toast handling, then refresh. */
  run: <T>(label: string, fn: (repoPath: string) => Promise<T>) => Promise<T | null>;
}

/**
 * The in-flight refresh, if any. A background POLL piggybacks on it (the
 * sidebar's 60s tick and the view's 5s tick overlap constantly, and one `git
 * status` is as good as two). A `full` refresh — a tab switch or the read that
 * follows a mutation — must NOT piggyback: the in-flight pass may have fetched
 * BEFORE the mutation landed, so reusing it would leave the UI a poll-interval
 * stale on exactly the change the user just made. Those chain and re-fetch.
 */
let refreshing: Promise<void> | null = null;
/** Monotonic id of the newest refresh, so an older pass can't clear the slot. */
let refreshEpoch = 0;

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export const useGit = create<GitStore>((set, get) => ({
  repoPath: null,
  status: null,
  branches: [],
  commits: [],
  stashes: [],
  commitFiles: {},

  tab: "changes",
  selection: null,
  message: "",
  amend: false,

  loading: false,
  error: null,
  busy: null,

  setRepoPath: (repoPath) => {
    if (get().repoPath === repoPath) return;
    // A different repo means every list, the selection and the draft message
    // belong to something else — start clean rather than showing stale rows.
    set({
      repoPath,
      status: null,
      branches: [],
      commits: [],
      stashes: [],
      commitFiles: {},
      selection: null,
      message: "",
      amend: false,
      error: null,
    });
    if (repoPath) void get().refresh({ full: true });
  },

  setTab: (tab) => {
    set({ tab });
    void get().refresh({ full: true });
  },
  select: (selection) => set({ selection }),
  setMessage: (message) => set({ message }),
  setAmend: (amend) => set({ amend }),

  refresh: async (opts = {}) => {
    const { repoPath } = get();
    if (!repoPath) return;
    const prior = refreshing;
    // Background polls piggyback; full refreshes queue behind and re-read.
    if (prior && !opts.full) return prior;

    const epoch = ++refreshEpoch;
    const work = (async () => {
      if (prior) await prior.catch(() => {});
      // Re-read the tab AFTER the wait — it may be why this refresh was asked for.
      const { tab } = get();
      set({ loading: true });
      try {
        // Status always; the heavier lists only when the tab needs them (or on
        // an explicit full refresh after a mutation).
        const wantBranches = opts.full;
        const wantCommits = opts.full || tab === "history";
        const wantStashes = opts.full || tab === "stashes";
        const [status, branches, commits, stashes] = await Promise.all([
          api.git.status(repoPath),
          wantBranches ? api.git.branches(repoPath).catch(() => get().branches) : get().branches,
          wantCommits ? api.git.log(repoPath, { limit: 80 }).catch(() => get().commits) : get().commits,
          wantStashes ? api.git.stashes(repoPath).catch(() => get().stashes) : get().stashes,
        ]);
        // Guard against a repo switch that landed mid-flight.
        if (get().repoPath !== repoPath) return;
        set({ status, branches, commits, stashes, error: null });
      } catch (err) {
        if (get().repoPath !== repoPath) return;
        set({ error: errorText(err) });
      } finally {
        set({ loading: false });
        // Only clear if we're still the newest pass — a queued full refresh may
        // have taken the slot while this one was running.
        if (refreshEpoch === epoch) refreshing = null;
      }
    })();
    refreshing = work;
    return work;
  },

  loadCommitFiles: async (sha) => {
    const { repoPath, commitFiles } = get();
    if (!repoPath || commitFiles[sha]) return;
    try {
      const files = await api.git.commitFiles(repoPath, sha);
      set((s) => ({ commitFiles: { ...s.commitFiles, [sha]: files } }));
    } catch (err) {
      useNotices.getState().push({ level: "error", text: "Couldn't read commit", detail: errorText(err) });
    }
  },

  run: async (label, fn) => {
    const { repoPath } = get();
    if (!repoPath || get().busy) return null;
    set({ busy: label });
    try {
      const result = await fn(repoPath);
      return result;
    } catch (err) {
      useNotices.getState().push({
        level: "error",
        text: `${label} failed`,
        detail: errorText(err),
      });
      return null;
    } finally {
      set({ busy: null });
      // git state can change in more ways than the call touched (a checkout
      // rewrites the working tree; a pop restores files), so always re-read.
      await get().refresh({ full: true });
    }
  },
}));

/* ------------------------------------------------------------- selectors */

/** Total changed paths — the sidebar badge and the "nothing to commit" gate. */
export function changeCount(status: GitStatus | null): number {
  if (!status) return 0;
  return (
    status.staged.length +
    status.unstaged.length +
    status.untracked.length +
    status.conflicted.length
  );
}

/** Reactive change count for the active repo. */
export function useGitChangeCount(): number {
  return useGit((s) => changeCount(s.status));
}

/* ---------------------------------------------------- selection builders */

/** Diff a STAGED path: HEAD → index. */
export function stagedSelection(relPath: string): GitSelection {
  return { relPath, leftRev: "HEAD", rightRev: GIT_REV_INDEX, label: "staged" };
}

/**
 * Diff an UNSTAGED path: index → working tree. An untracked file has no index
 * side at all, so its left is the EMPTY sentinel and the whole file reads as an
 * addition instead of failing to load.
 */
export function unstagedSelection(relPath: string, untracked = false): GitSelection {
  return {
    relPath,
    leftRev: untracked ? GIT_REV_EMPTY : GIT_REV_INDEX,
    rightRev: GIT_REV_WORKTREE,
    label: untracked ? "new file" : "working tree",
    live: true,
  };
}

/** Diff a file as it changed IN a commit: its first parent → the commit. */
export function commitSelection(sha: string, relPath: string, short: string): GitSelection {
  return { relPath, leftRev: `${sha}^`, rightRev: sha, label: short };
}

/** Diff a file carried in a stash: the stash's base commit → the stash. */
export function stashSelection(ref: string, relPath: string): GitSelection {
  return { relPath, leftRev: `${ref}^1`, rightRev: ref, label: ref };
}
