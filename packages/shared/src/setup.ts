/**
 * First-run setup — the wire types for the wizard a brand-new install lands on.
 *
 * The wizard exists because "installed" and "usable" were not the same state.
 * A fresh Dispatch used to boot straight into a seeded example project pointing
 * at a directory that did not exist on the new machine, with no indication of
 * whether the two things it actually needs — an agent runtime, and `gh` for the
 * PR workflow — were present at all. The first honest answer to "does this
 * work?" arrived at the first failed send.
 *
 * So the checks are the setup. `gh` and the harness are PROBED and reported
 * before anything is created, and the wizard ends by making a real project
 * rather than pretending one already exists.
 */

import type { HarnessKind } from "./common.js";

/**
 * Whether the `gh` CLI is on PATH and logged in.
 *
 * Two independent facts, and they fail differently: a missing binary is fixed
 * by an install, a missing login by `gh auth login`, and telling someone to run
 * the second when they needed the first is the whole reason this isn't a
 * boolean. `login` names the ACCOUNT because the mistake that survives setup is
 * being authenticated as the wrong one.
 */
export interface GhCliStatus {
  installed: boolean;
  /** Parsed from `gh --version`; absent when it ran but wouldn't parse. */
  version?: string;
  authenticated: boolean;
  /** The GitHub account `gh` is acting as, when authenticated. */
  login?: string;
  /** Why the probe failed, trimmed for display. Never a stack. */
  error?: string;
  /**
   * Whether `git` itself is on PATH. Probed alongside `gh` because the wizard's
   * last step runs `git init`, and until this existed nothing before that step
   * had asked — a machine with no git got its first honest answer as a raw
   * spawn error from the project form.
   */
  git?: GitCliStatus;
}

/** Whether the `git` binary the project step (and every worktree) needs is present. */
export interface GitCliStatus {
  installed: boolean;
  /** Parsed from `git --version`; absent when it ran but wouldn't parse. */
  version?: string;
}

/**
 * Whether an agent runtime is INSTALLED, and separately whether it is LOGGED
 * IN — probed live, the way `GhCliStatus` is.
 *
 * Two facts because they fail differently and the second was invisible. The
 * runtime step used to read `available` alone, and for Claude that is always
 * true (the SDK bundles a binary), so the one step the wizard calls "blocking"
 * could not block: a machine with no Claude subscription and no API key walked
 * through setup and learned otherwise from its first failed send. `login` is
 * what the runtime's own CLI reports (`claude auth status`, `codex login
 * status`) rather than a guess from a credentials file — which is wrong on
 * macOS, where Claude Code keeps its login in the Keychain.
 */
export interface RuntimeSetupStatus {
  kind: HarnessKind;
  available: boolean;
  version?: string;
  /** Which rule resolved the binary — `bundled` is the SDK's own copy. */
  source: "override" | "installed" | "bundled" | "missing";
  /** The executable the probe ran, when there was one. */
  path?: string;
  login: RuntimeLoginStatus;
}

export interface RuntimeLoginStatus {
  /** False when the runtime is absent or the probe could not run at all. */
  checked: boolean;
  loggedIn: boolean;
  /** How it is logged in, in the runtime's own words (`claude.ai`, `api-key`, `chatgpt`). */
  method?: string;
  /** Plan or tier, when the runtime says (`max`, `pro`, `team`). */
  subscription?: string;
  /** The account, when the runtime names it (an email for Claude). */
  account?: string;
  /** Why `checked` is false or `loggedIn` is false, trimmed for display. */
  error?: string;
}

/** First-run setup progress. `completed` is what gates the wizard. */
export interface SetupStatus {
  completed: boolean;
  /** Epoch ms the wizard was finished, when it has been. */
  completedAt?: number;
}
