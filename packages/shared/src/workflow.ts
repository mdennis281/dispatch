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
import { EffortSchema } from "./common.js";
import { ReviewerIdentitySchema } from "./reviewer.js";

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
 * Dispatch's OWN reviewer: a chat spawned to review a pull request, in place of
 * (or alongside) whatever bot the repo asks.
 *
 * WHY this is a workflow concern rather than a button somewhere. The review loop
 * this app is built around — ship, watch, fix, re-request, land — only turns
 * because something reviews. When the configured reviewer stops answering (a
 * quota runs out, a bot is uninstalled, a repo never had one), every chat on the
 * `review` rung stalls in exactly the same place: `approve_pr` refuses for
 * `no-review`, and the only ways out are a human override card or turning the
 * requirement off. Naming the reviewer in the profile is what lets a project
 * answer that with "spawn one" instead.
 *
 * The trigger is deliberately the REVIEW REQUEST, not "a PR opened". A request
 * is a fact the whole loop already produces and re-produces: `create_pr` makes
 * one, `request_review` makes another after every fix round, and a human can
 * make one by hand on GitHub. Hanging the reviewer off it means no new protocol,
 * and re-review after a fix round comes for free.
 *
 * Where that request COMES FROM depends on {@link WorkflowReviewAgentConfigSchema.identity}:
 *
 *   - **`self`** — the request is recorded on the PR's registry row, and the
 *     review is posted under whatever identity `gh` is already authenticated as
 *     (you). Nothing to set up. GitHub refuses `APPROVE`/`REQUEST_CHANGES` on
 *     your own pull request, so the verdict degrades to a comment — the inline
 *     threads still block the merge, so it keeps its teeth, just not its title.
 *   - **`dedicated`** — a GitHub machine account, added to the repo as a Read
 *     collaborator. It goes on `reviewers` like any other reviewer, so GitHub's
 *     OWN queue is the trigger, it can genuinely request changes, and the review
 *     carries its own name and avatar. Costs one free GitHub account.
 *
 * The account's login and token are NOT here. This file is committed, so a token
 * in it would be a published secret; and one machine account naturally serves
 * every repo you own, which makes it app-level rather than project-level state.
 * It lives in the config dir beside `auth.json` — see {@link ReviewerCredential}
 * — and this key only decides whether to USE it.
 *
 * A dedicated reviewer cannot be a GitHub App, and that is not a gap to close
 * later. `POST /pulls/{n}/requested_reviewers` takes `reviewers[]` (user logins)
 * and `team_reviewers[]` — there is no bots key, and Copilot appears in the
 * queue only because GitHub special-cases it server-side (the read side of that
 * asymmetry is documented at `GitHubService.prReviewState`). An App could post
 * the review but could never be asked for it, which is the half that matters.
 */
export const WorkflowReviewAgentConfigSchema = z.object({
  /** Spawn a reviewer when one is requested here. Off unless a project says so. */
  enabled: z.boolean().optional(),
  /** Who the review is posted as (see the docblock). Default `self`. */
  identity: ReviewerIdentitySchema.optional(),
  /** Reasoning effort the reviewer runs at. Reviewing well is not a cheap job. */
  effort: EffortSchema.optional(),
  model: z.string().optional(),
  /** A configured agent (`.dispatch/agents/`) to run the review as. */
  agentId: z.string().optional(),
  /** House rules appended to the briefing — what to be strict about, what to skip. */
  instructions: z.string().optional(),
  /**
   * Hard cap on review rounds per PR.
   *
   * Review → fix → `request_review` → review is a genuine cycle, and the
   * per-head-sha dedup only bounds it while the author stops pushing. A run of
   * rounds that never converges is the failure mode worth capping, because it
   * spends quota indefinitely and looks like progress the whole time.
   */
  maxRounds: z.number().int().min(1).max(20).optional(),
  /**
   * Post the review to GitHub. Off = the reviewer reports in its own chat and
   * touches nothing — the honest way to try this on a repo before trusting it.
   */
  post: z.boolean().optional(),
});
export type WorkflowReviewAgentConfig = z.infer<typeof WorkflowReviewAgentConfigSchema>;

/** The reviewer policy with every implication made explicit. */
export const ResolvedReviewAgentSchema = z.object({
  enabled: z.boolean(),
  identity: ReviewerIdentitySchema,
  /**
   * The dedicated account's login, overlaid by the SERVER from the stored
   * credential — never authored here.
   *
   * `resolveWorkflow` is pure and lives in a package that cannot read the config
   * dir, so it always resolves this to `undefined`; whoever holds the credential
   * store fills it in (see `reviewerPolicyFor` in the container). Consumers must
   * therefore treat "identity is dedicated but login is absent" as NOT CONFIGURED
   * rather than as self-review — silently posting under the human's own name
   * because a token went missing is the one outcome nobody asked for.
   */
  login: z.string().optional(),
  effort: EffortSchema,
  model: z.string().optional(),
  agentId: z.string().optional(),
  instructions: z.string().optional(),
  maxRounds: z.number().int(),
  post: z.boolean(),
});
export type ResolvedReviewAgent = z.infer<typeof ResolvedReviewAgentSchema>;

/**
 * One row of the reviewer roster: a login, or a login that is switched OFF.
 *
 * Muting rather than deleting exists because "who reviews here" is a thing
 * people SWITCH — Copilot this week, the dedicated account next week — and the
 * only way to express that was to delete a row and retype the login (spelled
 * exactly right, `[bot]` suffix and all) to get it back. A wrong retype is not
 * loud, either: GitHub accepts the request and simply queues nobody, so the
 * cost of the round trip is a PR that waits for a review that will never come.
 *
 * A bare string is an ENABLED reviewer, so every manifest written before this
 * existed keeps its exact meaning and hand-editing stays a one-line job. The
 * long form is only worth its extra lines when a row is off:
 *
 * ```yaml
 * reviewers:
 *   - copilot-pull-request-reviewer[bot]
 *   - login: dispatch-review
 *     enabled: false
 * ```
 *
 * The roster stays ONE list rather than a second `reviewersOff` key, because two
 * lists can disagree — a login in both is a state nothing on either side owns —
 * and because order is the only thing that says who this project asks first.
 */
export const PrReviewerEntrySchema = z.union([
  z.string(),
  z.object({
    login: z.string(),
    /** Off = kept in the list, never requested. Absent means on. */
    enabled: z.boolean().optional(),
  }),
]);
export type PrReviewerEntry = z.infer<typeof PrReviewerEntrySchema>;

/** A roster row with the shorthand expanded — what consumers actually read. */
export const ReviewerRosterEntrySchema = z.object({
  login: z.string(),
  enabled: z.boolean(),
});
export type ReviewerRosterEntry = z.infer<typeof ReviewerRosterEntrySchema>;

/**
 * Expand an authored roster into `{ login, enabled }` rows.
 *
 * Three things are dropped rather than passed on:
 *
 *   - BLANK logins. A stray `- ""` in the YAML would otherwise reach
 *     `POST /pulls/{n}/requested_reviewers` as a login, where it fails the whole
 *     batch of reviewers rather than just itself.
 *   - DUPLICATES, case-insensitively, first occurrence winning. GitHub logins are
 *     case-insensitive, so two rows are one reviewer asked twice — and a
 *     hand-edited manifest can now hold the same login twice in DISAGREEING
 *     states (one bare, one muted), which has no meaning to resolve. Collapsing
 *     here is also what lets the editor key its rows by login: the roster is
 *     unique by construction, so the switch on one row cannot move another.
 *   - MALFORMED entries — anything whose login isn't a string. Every path into
 *     this function is supposed to be schema-validated first, but it is exported
 *     and pure, and a `TypeError` thrown mid-resolve is a far worse failure than
 *     a dropped row: it takes out whatever was resolving the workflow, rather
 *     than the one reviewer that was written wrong.
 */
export function normalizeReviewerRoster(
  entries: readonly PrReviewerEntry[] | undefined,
): ReviewerRosterEntry[] {
  const out: ReviewerRosterEntry[] = [];
  const seen = new Set<string>();
  for (const e of entries ?? []) {
    const raw: unknown = typeof e === "string" ? e : (e as { login?: unknown } | null)?.login;
    if (typeof raw !== "string") continue;
    const login = raw.trim();
    if (!login || seen.has(login.toLowerCase())) continue;
    seen.add(login.toLowerCase());
    const enabled = typeof e === "string" ? true : e.enabled;
    out.push({ login, enabled: typeof enabled === "boolean" ? enabled : true });
  }
  return out;
}

/**
 * The inverse — the roster in the shortest form that still says what it means,
 * so an editor that never touches the switches doesn't rewrite the file into
 * long form and hand the human a diff full of rows that changed nothing.
 */
export function authorReviewerRoster(roster: readonly ReviewerRosterEntry[]): PrReviewerEntry[] {
  return roster.map((r) => (r.enabled ? r.login : { login: r.login, enabled: false }));
}

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
  /**
   * Reviewers to request on create: user logins and/or `org/team` slugs.
   *
   * An entry may be muted rather than removed — see {@link PrReviewerEntrySchema}.
   */
  reviewers: z.array(PrReviewerEntrySchema).optional(),
  /** A PR is not "done" until a requested reviewer reports. */
  requireReview: z.boolean().optional(),
  /** `on-green` refuses when NO check reported (vacuous green). */
  requireChecks: z.boolean().optional(),
  /** Open the PR as a draft. */
  draft: z.boolean().optional(),
  /** Dispatch's own reviewer (see {@link WorkflowReviewAgentConfigSchema}). */
  reviewAgent: WorkflowReviewAgentConfigSchema.optional(),
});
export type WorkflowPrConfig = z.infer<typeof WorkflowPrConfigSchema>;

/** The PR policy with every implication made explicit (see {@link WorkflowPrConfigSchema}). */
export const ResolvedPrPolicySchema = z.object({
  /**
   * Who is actually REQUESTED — muted rows are already gone.
   *
   * Resolving the mute away here rather than at each call site is the point of
   * this field: `create_pr`, `request_review`, the reviewer-account check and
   * `approve_pr`'s `no-review` refusal all read this list, and a switch that
   * only some of them honoured would be worse than no switch at all.
   */
  reviewers: z.array(z.string()),
  /** The full roster, muted rows included — what the editor renders. */
  reviewerRoster: z.array(ReviewerRosterEntrySchema),
  requireReview: z.boolean(),
  requireChecks: z.boolean(),
  draft: z.boolean(),
  reviewAgent: ResolvedReviewAgentSchema,
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

/**
 * The reviewer, off — what every rung without a PR resolves to, and the base
 * every authored `reviewAgent` block is applied on top of.
 *
 * `high` rather than `medium` because effort is the biggest quality lever on a
 * one-shot reading job, and the same reasoning the agent-task catalog uses for
 * its own hard tasks applies here: a review that misses the bug is worse than no
 * review, because it reads as a clean bill of health.
 */
const REVIEW_AGENT_OFF: ResolvedReviewAgent = {
  enabled: false,
  identity: "self",
  effort: "high",
  maxRounds: 4,
  post: true,
};

/** The inert PR policy — what the rungs with no PR resolve to. */
const INERT_PR_POLICY: ResolvedPrPolicy = {
  reviewers: [],
  reviewerRoster: [],
  requireReview: false,
  requireChecks: false,
  draft: false,
  reviewAgent: REVIEW_AGENT_OFF,
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
        reviewerRoster: normalizeReviewerRoster([COPILOT_LOGIN]),
        requireReview: true,
        requireChecks: true,
        draft: false,
        // Off by default, on the same reasoning as `autoMerge` above: spending
        // a human's model quota on every PR that opens is a real delegation, so
        // it is a toggle they flip rather than something a profile choice hands
        // over silently.
        reviewAgent: REVIEW_AGENT_OFF,
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
  // `?? base` and not `|| base`: an authored `reviewers: []` means "ask nobody",
  // which is a decision and not an omission. A roster whose rows are all MUTED
  // resolves to the same empty request list by a different route — the rows are
  // still there to switch back on, but nobody is asked meanwhile.
  const roster = normalizeReviewerRoster(pr?.reviewers ?? base.pr.reviewerRoster);
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
            reviewers: roster.filter((r) => r.enabled).map((r) => r.login),
            reviewerRoster: roster,
            requireReview: pr?.requireReview ?? base.pr.requireReview,
            requireChecks: pr?.requireChecks ?? base.pr.requireChecks,
            draft: pr?.draft ?? base.pr.draft,
            reviewAgent: resolveReviewAgent(pr?.reviewAgent, base.pr.reviewAgent),
          }
        : INERT_PR_POLICY,
  });
}

/**
 * Apply an authored reviewer block over the profile's default.
 *
 * Field-by-field rather than a spread, for the reason every other resolver here
 * is: an authored block that omits `maxRounds` must inherit the cap, not resolve
 * it to `undefined` and hand every consumer an unbounded loop to re-derive.
 */
function resolveReviewAgent(
  authored: WorkflowReviewAgentConfig | undefined,
  base: ResolvedReviewAgent,
): ResolvedReviewAgent {
  return {
    enabled: authored?.enabled ?? base.enabled,
    identity: authored?.identity ?? base.identity,
    // Always absent here: the login comes from the credential store, which this
    // package cannot read. See the field's docblock.
    login: undefined,
    effort: authored?.effort ?? base.effort,
    model: authored?.model ?? base.model,
    agentId: authored?.agentId ?? base.agentId,
    instructions: authored?.instructions ?? base.instructions,
    maxRounds: authored?.maxRounds ?? base.maxRounds,
    post: authored?.post ?? base.post,
  };
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
   * A PR opened with a raw `gh pr create` instead of `mcp__dispatch-github__create_pr`.
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
 * (`git worktree add` → `mcp__dispatch-workspace__worktree`) is NOT exemptible: its
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
   * `mcp__dispatch-github__approve_pr`, which runs the readiness checks, honours the
   * `hold` label, and tells the manager the trunk moved. This flag only changes
   * the sentence the agent reads, pointing it at the sanctioned path instead of
   * telling it to wait for a human who isn't coming.
   */
  autoMerge?: boolean;
  /**
   * True when this project's change reaches the trunk through a PR
   * ({@link ResolvedWorkflow.requirePr}) — i.e. opening one is a first-class step
   * of the workflow, so it goes through `mcp__dispatch-github__create_pr`. On the rungs
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
            ? "Use `mcp__dispatch-github__approve_pr` to land this PR — it verifies CI, review threads " +
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
            "Use `mcp__dispatch-github__create_pr` to open this PR — it pushes the branch, requests " +
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
