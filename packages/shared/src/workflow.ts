/**
 * Workflow profiles — the per-project "how does change ship here" contract.
 *
 * A managed repo is a multi-agent repo, but not every repo is at the same stage.
 * An adolescent project wants an agent that just edits files; a mature one wants
 * every task isolated in a worktree and landed through a reviewed PR. Encoding
 * that as a PROFILE (rather than "this repo happens to have a ship script and a
 * CLAUDE.md") is what lets Dispatch actually hold the line: the profile
 * drives the injected workflow rules, the permission guard, the memory commit
 * policy, and the post-merge main sync.
 *
 * Three rungs, in increasing ceremony:
 *
 *   - `none`   — work in the primary checkout. No branch, no PR, no commit
 *                obligation. The agent edits; the human batches commits. This is
 *                the right posture while a codebase is still forming.
 *   - `commit` — still the primary checkout, but work lands as small, coherent,
 *                conventional commits before a task is done. No branches, no
 *                GitHub. The rung a project graduates to once losing work starts
 *                to hurt.
 *   - `review` — one task → one worktree → one PR. Commit, ship, let CI and the
 *                reviewer run, respond to review, and let the merge land the
 *                branch; local `main` is fast-forwarded afterwards. Direct
 *                commits/pushes to the trunk are refused.
 *
 * Everything a profile implies is also individually overridable in the manifest,
 * so a repo can sit on `review` but (say) keep its own sync policy.
 */
import * as z from "zod";

/* ------------------------------------------------------------------ profile */

/** The three workflow rungs. See the module docblock. */
export const WorkflowProfileSchema = z.enum(["none", "commit", "review"]);
export type WorkflowProfile = z.infer<typeof WorkflowProfileSchema>;

/**
 * How hard the permission guard pushes back on a trunk-violating command
 * (`git commit`/`push` on the default branch, a manual `gh pr merge`):
 *   - `off`  — never intervene,
 *   - `warn` — let it through but surface a notice,
 *   - `deny` — refuse the tool call before it runs (the agent sees the reason).
 */
export const WorkflowGuardSchema = z.enum(["off", "warn", "deny"]);
export type WorkflowGuard = z.infer<typeof WorkflowGuardSchema>;

/**
 * What happens to `.dispatch/memory/` after an agent writes a memory.
 * Memories are always written to the PRIMARY checkout (they're project-scoped,
 * not branch-scoped — see MemoryService), so without a policy they accumulate
 * as permanently-uncommitted changes there.
 *   - `ignore` — leave them dirty; the human commits them with everything else,
 *   - `commit` — commit them on the primary checkout in their own `chore(memory)`
 *                commit, and push when the trunk has an upstream.
 */
export const WorkflowMemoryPolicySchema = z.enum(["ignore", "commit"]);
export type WorkflowMemoryPolicy = z.infer<typeof WorkflowMemoryPolicySchema>;

/** When to fast-forward the primary checkout's trunk to its remote. */
export const WorkflowSyncMainSchema = z.enum(["never", "ship", "merge"]);
export type WorkflowSyncMain = z.infer<typeof WorkflowSyncMainSchema>;

/**
 * Whether the agent may LAND its own PR, and how far that permission goes. A
 * `review`-only sub-setting: the other rungs have no PR to land.
 *
 *   - `off`      — the agent ships and waits; a human (or the repo's auto-merge
 *                  job) merges. The default, and what `review` has always meant.
 *   - `on-green` — once CI is green, review is clean, and nothing is parked, the
 *                  agent approves and merges its own PR without asking. "All
 *                  changes get pushed forward" — the whole point of the flag.
 *
 * `on-green` never means "merge regardless": {@link MERGE_HOLD_LABEL}, a failing
 * or pending check, an unresolved review thread, a draft, or a conflict each stop
 * it, and the agent is told to stand down whenever the human said to.
 */
export const WorkflowAutoMergeSchema = z.enum(["off", "on-green"]);
export type WorkflowAutoMerge = z.infer<typeof WorkflowAutoMergeSchema>;

/** How an auto-merged PR is landed (maps onto `gh pr merge`'s flags). */
export const WorkflowMergeMethodSchema = z.enum(["squash", "merge", "rebase"]);
export type WorkflowMergeMethod = z.infer<typeof WorkflowMergeMethodSchema>;

/**
 * The PR policy — what OPENING a pull request here must include, and what
 * "ready to land" actually requires.
 *
 * WHY this block exists, in the words of the failure that produced it: a project
 * declaring `profile: review` + `autoMerge: on-green` still had every step of the
 * PR lifecycle riding on the agent choosing correctly. It ran `gh pr create` by
 * hand, so nothing requested a reviewer (Copilot only showed up because of a
 * GitHub-side repo setting) and nothing linked the PR back to the chat. Two
 * rounds of review comments then landed into silence. And because that repo has
 * zero checks reporting, "on-green" was VACUOUS — `approve_pr` would have merged
 * on the strength of an empty check list.
 *
 * So the fix is to make the project DECLARE what it needs and let the harness
 * hold the line, rather than relying on per-project prose and accumulated
 * memories to re-teach every new agent the same lesson:
 *
 *   - `reviewers`     — logins (or `org/team`) the sanctioned create path requests.
 *                       Nothing else is trusted to remember.
 *   - `requireReview` — a PR isn't "done" until a requested reviewer has reported.
 *   - `requireChecks` — `on-green` REFUSES when zero checks reported, instead of
 *                       treating "no evidence" as "good news".
 *   - `draft`         — open PRs as drafts by default.
 */
export const WorkflowPrConfigSchema = z.object({
  /** Reviewers to request on create: user logins and/or `org/team` slugs. */
  reviewers: z.array(z.string()).optional(),
  /** A PR is not "done" until a requested reviewer reports. */
  requireReview: z.boolean().optional(),
  /** `on-green` refuses when NO check reported (vacuous green). */
  requireChecks: z.boolean().optional(),
  /** Open the PR as a draft. */
  draft: z.boolean().optional(),
});
export type WorkflowPrConfig = z.infer<typeof WorkflowPrConfigSchema>;

/** The PR policy with every implication made explicit (see {@link WorkflowPrConfigSchema}). */
export const ResolvedPrPolicySchema = z.object({
  reviewers: z.array(z.string()),
  requireReview: z.boolean(),
  requireChecks: z.boolean(),
  draft: z.boolean(),
});
export type ResolvedPrPolicy = z.infer<typeof ResolvedPrPolicySchema>;

/**
 * The label that parks a PR. Pre-existing (the repo's auto-merge job honours it);
 * auto-merge honours it too, so a human can stop a specific PR from being landed
 * without turning the feature off project-wide.
 */
export const MERGE_HOLD_LABEL = "hold";

/**
 * Every label this app reads as "parked", not just the one it writes.
 *
 * `MERGE_HOLD_LABEL` is what `hold()` applies; these are the conventions a HUMAN
 * may have applied instead, and a PR carrying `do-not-merge` must not be
 * rendered as ready to land just because the label isn't spelled `hold`. The
 * client had this set duplicated in two components with no shared definition —
 * which is how "held" came to mean something slightly different in each panel.
 */
export const HOLD_LABELS: readonly string[] = [
  MERGE_HOLD_LABEL,
  "no-automerge",
  "do-not-merge",
  "wip",
];

/** Is this PR parked by a hold label? Case-insensitive, like `approve_pr`'s gate. */
export function isHeldByLabel(labels: readonly string[] | undefined): boolean {
  if (!labels?.length) return false;
  const held = new Set(HOLD_LABELS);
  return labels.some((l) => held.has(l.trim().toLowerCase()));
}

/**
 * GitHub's Copilot code reviewer. The `review` profile's default reviewer, and
 * the login every hand-rolled ship path in this repo already requested.
 *
 * It lives HERE rather than in the server's GitHub service because the profile
 * default needs it and `@dispatch/shared` can't import from the server.
 */
export const COPILOT_LOGIN = "copilot-pull-request-reviewer[bot]";

/* ------------------------------------------------------- authored + resolved */

/**
 * The workflow block as authored in `.dispatch/project.yaml` (and stored
 * on the project record). Only `profile` is required; every other field is an
 * override of that profile's default.
 */
export const WorkflowConfigSchema = z.object({
  profile: WorkflowProfileSchema,
  /** Custom worktree command (e.g. `pnpm worktree`); `review` only. */
  worktree: z.string().optional(),
  /** Custom ship command (e.g. `pnpm ship`); `review` only. */
  ship: z.string().optional(),
  syncMainAfter: WorkflowSyncMainSchema.optional(),
  memory: WorkflowMemoryPolicySchema.optional(),
  guard: WorkflowGuardSchema.optional(),
  /** Whether the agent lands its own PRs (see {@link WorkflowAutoMergeSchema}); `review` only. */
  autoMerge: WorkflowAutoMergeSchema.optional(),
  /** Strategy used when auto-merge lands a PR (default `squash`). */
  mergeMethod: WorkflowMergeMethodSchema.optional(),
  /** What opening/landing a PR here requires (see {@link WorkflowPrConfigSchema}); `review` only. */
  pr: WorkflowPrConfigSchema.optional(),
});
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;

/**
 * A profile with every implication made explicit. This is what the session
 * broker, guard, memory service and PR watcher actually read — none of them
 * branch on the profile name directly, so adding a rung stays a one-place change.
 */
export const ResolvedWorkflowSchema = z.object({
  profile: WorkflowProfileSchema,
  /** Each task gets its own worktree + branch (never the primary checkout). */
  isolate: z.boolean(),
  /** Work must land as commits before the task is done. */
  requireCommit: z.boolean(),
  /** Change reaches the trunk through a PR, not a direct push. */
  requirePr: z.boolean(),
  /** Ship, then work the CI + review loop until the PR lands. */
  reviewLoop: z.boolean(),
  worktreeCmd: z.string().optional(),
  shipCmd: z.string().optional(),
  syncMainAfter: WorkflowSyncMainSchema,
  memory: WorkflowMemoryPolicySchema,
  guard: WorkflowGuardSchema,
  /** Whether the agent may land its own PR, and how far that goes. */
  autoMerge: WorkflowAutoMergeSchema,
  /** Strategy auto-merge lands with. */
  mergeMethod: WorkflowMergeMethodSchema,
  /**
   * What opening and landing a PR here requires. Non-optional so no consumer has
   * to re-derive it (or forget to) — the same reason `autoMerge` is resolved
   * rather than left as "maybe authored". Inert on the rungs with no PR.
   */
  pr: ResolvedPrPolicySchema,
});
export type ResolvedWorkflow = z.infer<typeof ResolvedWorkflowSchema>;

/** The inert PR policy — what the rungs with no PR resolve to. */
const INERT_PR_POLICY: ResolvedPrPolicy = {
  reviewers: [],
  requireReview: false,
  requireChecks: false,
  draft: false,
};

/** The per-profile defaults every override is applied on top of. */
const PROFILE_DEFAULTS: Record<WorkflowProfile, Omit<ResolvedWorkflow, "worktreeCmd" | "shipCmd">> =
  {
    none: {
      profile: "none",
      isolate: false,
      requireCommit: false,
      requirePr: false,
      reviewLoop: false,
      syncMainAfter: "never",
      memory: "ignore",
      guard: "off",
      autoMerge: "off",
      mergeMethod: "squash",
      pr: INERT_PR_POLICY,
    },
    commit: {
      profile: "commit",
      isolate: false,
      requireCommit: true,
      requirePr: false,
      reviewLoop: false,
      syncMainAfter: "never",
      // Working ON the trunk is the whole point of this rung — never guard it.
      memory: "commit",
      guard: "off",
      autoMerge: "off",
      mergeMethod: "squash",
      pr: INERT_PR_POLICY,
    },
    review: {
      profile: "review",
      isolate: true,
      requireCommit: true,
      requirePr: true,
      reviewLoop: true,
      syncMainAfter: "merge",
      memory: "commit",
      guard: "deny",
      // Opt-in: landing your own work is a real delegation, so it's a toggle the
      // human flips, not something a profile choice hands over silently.
      autoMerge: "off",
      mergeMethod: "squash",
      // This rung is the one that HAS a PR, so its policy is the one with teeth.
      // Both requirements default ON: the observed failure was a `review` project
      // where a PR could be called done with nobody having looked at it and no
      // check having reported.
      //
      // The reviewer list defaults to Copilot rather than empty because the
      // empty default paired with `requireReview: true` produced pure friction:
      // `approve_pr` refused for want of a review that NOBODY COULD BE ASKED
      // for, so agents merged with `allowNoReview` and the requirement bought
      // nothing. Copilot is repo-agnostic and works on any GitHub repo, so it's
      // the one reviewer a default can name. Author `reviewers: []` to opt out.
      pr: {
        reviewers: [COPILOT_LOGIN],
        requireReview: true,
        requireChecks: true,
        draft: false,
      },
    },
  };

/** The minimal project shape {@link resolveWorkflow} needs (avoids a cycle). */
export interface WorkflowSource {
  workflow?: WorkflowConfig;
  worktreeCmd?: string;
  shipCmd?: string;
}

/**
 * Resolve a project's effective workflow.
 *
 * Back-compat: a project with no authored `workflow` block infers its rung from
 * what it already had — a `shipCmd` meant it was running the full PR loop, so it
 * resolves to `review`; anything else resolves to `none`. That keeps every
 * pre-existing project behaving exactly as it did before profiles existed.
 *
 * `autoMerge` is clamped to `off` outside the `review` rung — the lower rungs
 * don't open PRs, so an authored `autoMerge` there is a mistake, and resolving it
 * away here means no consumer has to re-check the profile before trusting it.
 * The authored `pr:` block is clamped INERT on those same rungs for exactly the
 * same reason: there is no PR to request reviewers on, so a policy there would be
 * a trap for any consumer that trusted the field without re-checking the profile.
 */
export function resolveWorkflow(source: WorkflowSource | null | undefined): ResolvedWorkflow {
  const wf = source?.workflow;
  const profile: WorkflowProfile = wf?.profile ?? (source?.shipCmd ? "review" : "none");
  const base = PROFILE_DEFAULTS[profile];
  const pr = wf?.pr;
  return ResolvedWorkflowSchema.parse({
    ...base,
    // Command overrides fall back to the legacy top-level project fields.
    worktreeCmd: wf?.worktree ?? source?.worktreeCmd,
    shipCmd: wf?.ship ?? source?.shipCmd,
    syncMainAfter: wf?.syncMainAfter ?? base.syncMainAfter,
    memory: wf?.memory ?? base.memory,
    guard: wf?.guard ?? base.guard,
    autoMerge: profile === "review" ? (wf?.autoMerge ?? base.autoMerge) : "off",
    mergeMethod: wf?.mergeMethod ?? base.mergeMethod,
    pr:
      profile === "review"
        ? {
            reviewers: pr?.reviewers ?? base.pr.reviewers,
            requireReview: pr?.requireReview ?? base.pr.requireReview,
            requireChecks: pr?.requireChecks ?? base.pr.requireChecks,
            draft: pr?.draft ?? base.pr.draft,
          }
        : INERT_PR_POLICY,
  });
}

/* -------------------------------------------------------------------- guard */

/** What kind of trunk violation a command represents. */
export const WorkflowViolationKindSchema = z.enum([
  /** A commit made directly on the protected trunk branch. */
  "commit-on-trunk",
  /** A push whose destination is the protected trunk branch. */
  "push-to-trunk",
  /** A merge the review loop is supposed to perform, done by hand. */
  "manual-merge",
  /**
   * A PR opened with a raw `gh pr create` instead of `mcp__manager__create_pr`.
   *
   * This is the asymmetry that produced the failure this whole block exists for:
   * a hand-rolled `gh pr merge` was already refused and redirected at
   * `approve_pr`, but `gh pr create` was wide open — so the PR got opened with no
   * reviewer requested, no link back to the chat, and no watcher armed, and two
   * rounds of review comments landed into silence.
   */
  "pr-create-by-hand",
]);
export type WorkflowViolationKind = z.infer<typeof WorkflowViolationKindSchema>;

/** A detected violation: what it was, and the sentence to show the agent. */
export interface WorkflowViolation {
  kind: WorkflowViolationKind;
  reason: string;
}

/* --------------------------------------------------------------- exemptions */

/**
 * What a single granted exemption lifts.
 *
 * WHY this exists at all: on 2026-08-17 a GitHub outage poisoned a cache in
 * `create_pr`, so the sanctioned path refused every call for the rest of the
 * session — while the guard went on (correctly) refusing the raw `gh pr create`
 * it redirects to. The chat sat on two finished, pushed branches it could not
 * open PRs for, and the only escapes were editing project config (which changes
 * the rule for every chat, permanently) or restarting the server. Both are far
 * too big a hammer for "let this one chat run this one command".
 *
 * Deliberately only the WORKFLOW guard's kinds, plus `all`. The worktree guard
 * (`git worktree add` → `mcp__manager__worktree`) is NOT exemptible: its
 * sanctioned path has no observed failure mode, so there is no incident to
 * justify a hole in it. Widen this when one exists, not before.
 *
 * `all` is offered because the guard an agent is blocked on is not always one it
 * can name — a compound command trips whichever clause the classifier reaches
 * first, and an agent that guesses wrong gets a grant that silently doesn't
 * apply and re-asks. It stays the LOUD option everywhere it is rendered
 * ({@link describeExemptionScope}), because it is the one that lifts guards
 * nobody discussed.
 */
export const WorkflowExemptionScopeSchema = z.enum([
  ...WorkflowViolationKindSchema.options,
  "all",
]);
export type WorkflowExemptionScope = z.infer<typeof WorkflowExemptionScopeSchema>;

/**
 * How long a grant lives.
 *
 * The HUMAN picks this on the consent card, not the agent and not a constant:
 * "just this once" and "for the rest of this chat" are answers to different
 * situations (a one-off vs. a sanctioned path that's down for the session), and
 * only the person approving knows which one they're in. An agent that could
 * propose the lifetime would always propose the generous one.
 *
 * Neither survives the live session. Even `session` is in-memory on the broker's
 * `LiveSession`, so a stop, a fork, or a server restart clears it — an exemption
 * is a response to a live incident, and one that outlived the incident silently
 * would be exactly the permanent config change this feature exists to avoid.
 */
export const WorkflowExemptionLifetimeSchema = z.enum(["once", "session"]);
export type WorkflowExemptionLifetime = z.infer<typeof WorkflowExemptionLifetimeSchema>;

/** One human-approved lift of a guard, scoped to one chat's live session. */
export const WorkflowExemptionSchema = z.object({
  id: z.string(),
  scope: WorkflowExemptionScopeSchema,
  lifetime: WorkflowExemptionLifetimeSchema,
  /** The agent's stated justification, as the human approved it. */
  reason: z.string(),
  /**
   * The command the agent said it would run. Shown on the card and in the UI,
   * but deliberately NOT part of the match: a retry with a corrected flag is the
   * same intent, and an exemption that stopped applying there would read to the
   * agent as "the grant didn't work" and send it back for another card.
   */
  command: z.string().optional(),
  grantedAt: z.number().int(),
  /** How many blocked commands this grant has actually let through. */
  uses: z.number().int().nonnegative(),
});
export type WorkflowExemption = z.infer<typeof WorkflowExemptionSchema>;

/** Whether a grant covers a given violation. `all` covers every kind. */
export function exemptionCovers(
  exemption: Pick<WorkflowExemption, "scope">,
  kind: WorkflowViolationKind,
): boolean {
  return exemption.scope === "all" || exemption.scope === kind;
}

/**
 * The scope, in the words a human reads on the card and on the chip.
 *
 * One definition, because the card and the chip disagreeing about what was
 * granted is the failure mode a consent surface can least afford.
 */
export function describeExemptionScope(scope: WorkflowExemptionScope): string {
  switch (scope) {
    case "commit-on-trunk":
      return "committing on the trunk";
    case "push-to-trunk":
      return "pushing to the trunk";
    case "manual-merge":
      return "merging by hand (`gh pr merge` / `git merge`)";
    case "pr-create-by-hand":
      return "opening a PR by hand (`gh pr create`)";
    case "all":
      return "EVERY workflow guard";
  }
}

/** Context the classifier needs about where a command is about to run. */
export interface WorkflowCommandContext {
  /** The protected trunk (project `defaultBranch`, typically `main`). */
  defaultBranch: string;
  /** The branch the session's cwd is on, when known. */
  currentBranch?: string | null;
  /** True when the session is running inside a task worktree. */
  inWorktree?: boolean;
  /**
   * True when this session may land its own PR (`autoMerge: "on-green"`). A raw
   * `gh pr merge` stays REFUSED either way — auto-merge goes through
   * `mcp__manager__approve_pr`, which runs the readiness checks, honours the
   * `hold` label, and tells the manager the trunk moved. This flag only changes
   * the sentence the agent reads, pointing it at the sanctioned path instead of
   * telling it to wait for a human who isn't coming.
   */
  autoMerge?: boolean;
  /**
   * True when this project's change reaches the trunk through a PR
   * ({@link ResolvedWorkflow.requirePr}) — i.e. opening one is a first-class step
   * of the workflow, so it goes through `mcp__manager__create_pr`. On the rungs
   * that don't open PRs at all there is nothing to redirect a `gh pr create` TO,
   * so it's left alone rather than refused with no alternative.
   */
  requirePr?: boolean;
}

/** Split a shell string on `&&`, `||`, `;` and `|` into its component commands. */
function splitCommands(command: string): string[] {
  return command
    .split(/\|\||&&|[;\n|]/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/** Tokenize one command, dropping surrounding quotes from each argument. */
function tokenize(command: string): string[] {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return tokens.map((t) =>
    (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))
      ? t.slice(1, -1)
      : t,
  );
}

/**
 * Decide whether a shell command violates the trunk contract.
 *
 * Deliberately narrow: it only fires on the three things the `review` loop
 * actually forbids, and it only fires when it can TELL. A `git commit` whose
 * branch we don't know is allowed through — a guard that blocks legitimate work
 * on a false positive gets turned off, which is worse than one that misses.
 *
 * Returns null when the command is fine (which is almost always).
 */
export function classifyWorkflowViolation(
  command: string,
  ctx: WorkflowCommandContext,
): WorkflowViolation | null {
  const trunk = ctx.defaultBranch || "main";
  for (const raw of splitCommands(command)) {
    const tokens = tokenize(raw);
    if (!tokens.length) continue;
    const [bin, ...rest] = tokens;
    const exe = (bin ?? "").replace(/\.exe$/i, "").split(/[\\/]/).pop() ?? "";
    // Skip global git flags (`git -C dir push`) to find the subcommand.
    const args = [...rest];
    if (exe === "git") {
      let i = 0;
      while (i < args.length && args[i]?.startsWith("-")) {
        // `-C <dir>` and `-c <cfg>` consume a value; bare flags don't.
        i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
      }
      const sub = args[i];
      const subArgs = args.slice(i + 1);

      if (sub === "commit") {
        // Only a KNOWN trunk checkout is a violation — see the docblock.
        if (ctx.currentBranch === trunk) {
          return {
            kind: "commit-on-trunk",
            reason: `\`${trunk}\` is the protected trunk — commit on a task branch in a worktree instead.`,
          };
        }
        continue;
      }

      if (sub === "push") {
        const positional = subArgs.filter((a) => !a.startsWith("-"));
        // `git push origin main`, `git push origin HEAD:main`, `git push origin +main`
        const targets = positional.slice(1).map((r) => {
          const dst = r.includes(":") ? (r.split(":").pop() ?? "") : r;
          return dst.replace(/^\+/, "").replace(/^refs\/heads\//, "");
        });
        if (targets.includes(trunk)) {
          return {
            kind: "push-to-trunk",
            reason: `Refusing to push to \`${trunk}\` — open a PR from a task worktree instead.`,
          };
        }
        // A bare `git push` from a trunk checkout pushes the trunk.
        if (!targets.length && ctx.currentBranch === trunk) {
          return {
            kind: "push-to-trunk",
            reason: `A bare \`git push\` from \`${trunk}\` pushes the trunk — open a PR from a task worktree instead.`,
          };
        }
        continue;
      }

      // A local `git merge` INTO the trunk checkout bypasses the PR entirely.
      if (sub === "merge" && ctx.currentBranch === trunk && !ctx.inWorktree) {
        return {
          kind: "manual-merge",
          reason: `Merging into \`${trunk}\` by hand bypasses the PR — ship the branch and let the merge land it.`,
        };
      }
      continue;
    }

    if (exe === "gh") {
      const positional = args.filter((a) => !a.startsWith("-"));
      if (positional[0] === "pr" && positional[1] === "merge") {
        return {
          kind: "manual-merge",
          reason: ctx.autoMerge
            ? "Use `mcp__manager__approve_pr` to land this PR — it verifies CI, review threads " +
              "and the `hold` label first, and syncs the trunk afterwards. A raw `gh pr merge` " +
              "skips all of that."
            : "Merging the PR by hand skips the review loop — ship it and let the merge land once review is green.",
        };
      }
      // The counterpart to the `gh pr merge` refusal above. Same shape of
      // argument: the raw command "works", which is exactly why it was reached
      // for — and then every downstream guarantee the workflow promised is
      // quietly missing, with nothing to notice it until a human reads the PR
      // page by hand two review rounds later.
      if (ctx.requirePr && positional[0] === "pr" && positional[1] === "create") {
        return {
          kind: "pr-create-by-hand",
          reason:
            "Use `mcp__manager__create_pr` to open this PR — it pushes the branch, requests " +
            "the reviewers this project configured, records the PR on this chat, and arms the " +
            "watcher so review activity comes back to you. A raw `gh pr create` does none of " +
            "that: the PR opens with nobody asked to look at it and no way for the review " +
            "round to reach you.",
        };
      }
      continue;
    }
  }
  return null;
}
