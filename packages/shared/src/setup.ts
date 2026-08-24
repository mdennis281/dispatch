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
}

/** First-run setup progress. `completed` is what gates the wizard. */
export interface SetupStatus {
  completed: boolean;
  /** Epoch ms the wizard was finished, when it has been. */
  completedAt?: number;
}
