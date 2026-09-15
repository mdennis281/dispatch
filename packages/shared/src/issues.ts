/**
 * ISSUES — the provider-neutral contract behind issue-triggered chats and the
 * `dispatch-issues` MCP.
 *
 * Nothing here knows GitHub exists. A provider (see `services/issues/` on the
 * server) maps its own wire shapes onto {@link Issue}, and everything above it —
 * the watcher's filters, the MCP's rendering, the config UI — speaks only these
 * types. That is the whole point of the split: supporting GitLab later means one
 * new provider file, not a second copy of the filter logic that quietly drifts.
 *
 * One property of this data drives several defaults below: an issue's title and
 * body are written by WHOEVER OPENED IT. On a public repo that is anyone with an
 * account, and the watcher hands that text to an agent that can push code. So the
 * default filter only admits authors the repo already trusts, and triage — not
 * implementation — is the default mode.
 */
import * as z from "zod";
import { EffortSchema, HarnessKindSchema } from "./common.js";

/* ------------------------------------------------------------------ source */

/** Issue trackers Dispatch can talk to. One entry per provider implementation. */
export const ISSUE_PROVIDERS = ["github"] as const;
export const IssueProviderIdSchema = z.enum(ISSUE_PROVIDERS);
export type IssueProviderId = z.infer<typeof IssueProviderIdSchema>;

/** `owner/repo` — the same strict shape GitHubService validates before any call. */
export const ISSUE_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A bare hostname (optionally with a port) — never a URL, never a path. */
const HOST_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;

/**
 * WHERE a project's issues live.
 *
 * Authorable, because `origin` is only a good guess: a fork's origin is the fork
 * while its issues are upstream, and a GitHub Enterprise host can't be told apart
 * from any other git server by its name. Absent → derived from `origin` at use
 * time (see {@link detectIssueSource}), so a project that never touches this key
 * follows its remote rather than a copy of it that goes stale.
 */
export const IssueSourceSchema = z.object({
  provider: IssueProviderIdSchema,
  /** Absent = the provider's public host (github.com). */
  host: z.string().regex(HOST_RE, "a hostname, not a URL").optional(),
  repo: z.string().regex(ISSUE_REPO_RE, "expected owner/repo"),
});
export type IssueSource = z.infer<typeof IssueSourceSchema>;

/** `github:owner/repo` / `github@ghe.corp:owner/repo` — for logs and labels. */
export function issueSourceLabel(source: IssueSource): string {
  return `${source.provider}${source.host ? `@${source.host}` : ""}:${source.repo}`;
}

/**
 * The durable identity of one issue: `github:owner/repo#12`.
 *
 * The provider and host are part of the key, not decoration — two trackers can
 * both have an `acme/api#12`, and a claim keyed without them would let working
 * one block the other.
 */
export function issueKey(source: IssueSource, number: number): string {
  return `${issueSourceLabel(source)}#${number}`;
}

/**
 * Split a git remote URL into host + path. Handles the three spellings git
 * accepts for the same repo — `https://host/o/r.git`, `ssh://git@host/o/r.git`
 * and scp-style `git@host:o/r.git` — plus embedded credentials, which must never
 * survive into anything this returns.
 */
export function parseGitRemote(url: string): { host: string; path: string } | null {
  const raw = url.trim();
  if (!raw) return null;
  // No `URL` here: this package compiles without DOM or Node libs. The shapes a
  // git remote takes are few enough to match directly.
  const full = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?([^/\s?#]+)(\/[^?#\s]*)?/i.exec(raw);
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(raw);
  let host: string;
  let path: string;
  if (full) {
    host = full[1] ?? "";
    path = full[2] ?? "";
  } else if (scp) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else {
    return null;
  }
  if (!host) return null;
  // Index scans, not `/^\/+|\/+$/`: the anchored-at-end alternative backtracks
  // quadratically on a long run of slashes, and a remote URL is input we don't
  // control (CodeQL js/polynomial-redos).
  let start = 0;
  let end = path.length;
  while (start < end && path[start] === "/") start++;
  while (end > start && path[end - 1] === "/") end--;
  path = path.slice(start, end);
  if (path.toLowerCase().endsWith(".git")) path = path.slice(0, -4);
  return path ? { host: host.toLowerCase(), path } : null;
}

/**
 * The issue source an `origin` URL implies, or null when no provider claims it.
 *
 * Deliberately conservative about GitHub Enterprise: only a host with "github" in
 * its name is guessed at. A self-hosted git server that happens to be GitLab must
 * not be silently pointed at the GitHub API — the human authors `source` instead.
 * `ssh.github.com` (the port-443 SSH endpoint) is github.com, not an Enterprise host.
 */
export function detectIssueSource(remoteUrl: string): IssueSource | null {
  const parsed = parseGitRemote(remoteUrl);
  if (!parsed) return null;
  const repo = parsed.path.split("/").slice(-2).join("/");
  if (!ISSUE_REPO_RE.test(repo) || parsed.path.split("/").length !== 2) return null;
  const host = parsed.host.replace(/:\d+$/, "");
  if (host === "github.com" || host === "ssh.github.com" || host === "www.github.com") {
    return { provider: "github", repo };
  }
  if (/(^|[.-])github([.-]|$)/.test(host)) return { provider: "github", host, repo };
  return null;
}

/* ------------------------------------------------------------------- issue */

/**
 * How much the repo trusts an issue's author — provider-neutral, ordered from
 * most to least. GitHub's `author_association` maps onto it; a provider with
 * access levels (GitLab) maps those.
 */
export const ISSUE_AUTHOR_TRUST = ["owner", "member", "collaborator", "contributor", "none"] as const;
export const IssueAuthorTrustSchema = z.enum(ISSUE_AUTHOR_TRUST);
export type IssueAuthorTrust = z.infer<typeof IssueAuthorTrustSchema>;

export const IssueStateSchema = z.enum(["open", "closed"]);
export type IssueState = z.infer<typeof IssueStateSchema>;

export const IssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  state: IssueStateSchema,
  url: z.string(),
  author: z.string(),
  authorTrust: IssueAuthorTrustSchema,
  /** Is the author an automation account (dependabot, renovate…)? */
  authorIsBot: z.boolean(),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  commentCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Issue = z.infer<typeof IssueSchema>;

export const IssueCommentSchema = z.object({
  id: z.string(),
  author: z.string(),
  authorTrust: IssueAuthorTrustSchema,
  body: z.string(),
  createdAt: z.string(),
  url: z.string().optional(),
});
export type IssueComment = z.infer<typeof IssueCommentSchema>;

/** A change to one issue. Every field optional; an empty patch is a no-op. */
export const IssuePatchSchema = z.object({
  addLabels: z.array(z.string().min(1)).optional(),
  removeLabels: z.array(z.string().min(1)).optional(),
  addAssignees: z.array(z.string().min(1)).optional(),
  removeAssignees: z.array(z.string().min(1)).optional(),
  state: IssueStateSchema.optional(),
  /** Why it closed. Ignored unless `state` is `closed`. */
  stateReason: z.enum(["completed", "not_planned"]).optional(),
});
export type IssuePatch = z.infer<typeof IssuePatchSchema>;

/* ------------------------------------------------------------------ config */

/** What a spawned chat is briefed to do with an issue. */
export const IssueModeSchema = z.enum(["triage", "implement"]);
export type IssueMode = z.infer<typeof IssueModeSchema>;

/** Rejects a pattern `new RegExp` would throw on, at config LOAD rather than mid-poll. */
const RegexSourceSchema = z.string().refine(
  (s) => {
    try {
      new RegExp(s, "i");
      return true;
    } catch {
      return false;
    }
  },
  { message: "not a valid regular expression" },
);

/**
 * Which new issues a project picks up. Every condition must pass.
 *
 * `authors` WIDENS `trust` (a named outsider you want handled) and
 * `excludeAuthors` beats both (a bot account you never want handled, however
 * trusted it is on paper). Bots are excluded by default for the same reason: a
 * dependency bot's issues are machine-generated, frequent, and handled elsewhere.
 */
export const IssueFiltersSchema = z.object({
  /** Author trust levels admitted. Default: owner, member, collaborator. */
  trust: z.array(IssueAuthorTrustSchema).optional(),
  /** Logins admitted regardless of trust. */
  authors: z.array(z.string().min(1)).optional(),
  /** Logins never admitted. */
  excludeAuthors: z.array(z.string().min(1)).optional(),
  /** Admit issues opened by bot accounts. Default false. */
  includeBots: z.boolean().optional(),
  /** Require at least ONE of these labels. Absent/empty = no requirement. */
  labels: z.array(z.string().min(1)).optional(),
  /** Skip an issue carrying ANY of these labels. */
  excludeLabels: z.array(z.string().min(1)).optional(),
  /** Case-insensitive regex the title must match. */
  titlePattern: RegexSourceSchema.optional(),
  /** Skip an issue somebody is already assigned to. Default true. */
  skipAssigned: z.boolean().optional(),
});
export type IssueFilters = z.infer<typeof IssueFiltersSchema>;

export const ISSUE_INTERVAL_MIN_MINUTES = 5;
export const ISSUE_INTERVAL_MAX_MINUTES = 24 * 60;

/**
 * The `issues:` block of a project manifest. Off unless a project says so — the
 * enrollment IS this key, because Dispatch has no notion of an "active" project
 * and a watcher that spawned agents on every repo it had ever been pointed at
 * would be a surprise with a bill attached.
 */
export const IssueConfigSchema = z.object({
  enabled: z.boolean().optional(),
  /** Where the issues live. Absent → derived from `origin`. */
  source: IssueSourceSchema.optional(),
  /** Default `triage`. */
  mode: IssueModeSchema.optional(),
  /** How often to poll, in minutes. Default 60. */
  intervalMinutes: z
    .number()
    .int()
    .min(ISSUE_INTERVAL_MIN_MINUTES)
    .max(ISSUE_INTERVAL_MAX_MINUTES)
    .optional(),
  /** Issue chats allowed to run at once in this project. Default 2. */
  maxConcurrent: z.number().int().min(1).max(20).optional(),
  filters: IssueFiltersSchema.optional(),
  /**
   * The label that marks an issue as being worked. It is the claim OTHER
   * instances and humans can see — `state.db` is per-instance, so without it two
   * installs polling one repo would each pick up the same issue.
   */
  claimLabel: z.string().min(1).max(50).optional(),
  harness: HarnessKindSchema.optional(),
  model: z.string().optional(),
  effort: EffortSchema.optional(),
  personaId: z.string().optional(),
  agentId: z.string().optional(),
  /** House rules appended to the briefing. */
  instructions: z.string().optional(),
});
export type IssueConfig = z.infer<typeof IssueConfigSchema>;

export const DEFAULT_ISSUE_CLAIM_LABEL = "dispatch:working";
export const DEFAULT_ISSUE_TRUST: readonly IssueAuthorTrust[] = ["owner", "member", "collaborator"];

/** An issue policy with every default made explicit. */
export interface ResolvedIssuePolicy {
  enabled: boolean;
  source?: IssueSource;
  mode: IssueMode;
  intervalMinutes: number;
  maxConcurrent: number;
  claimLabel: string;
  filters: Required<Pick<IssueFilters, "trust" | "authors" | "excludeAuthors" | "includeBots" | "labels" | "excludeLabels" | "skipAssigned">> &
    Pick<IssueFilters, "titlePattern">;
  harness?: IssueConfig["harness"];
  model?: string;
  effort?: IssueConfig["effort"];
  personaId?: string;
  agentId?: string;
  instructions?: string;
}

/**
 * Apply defaults field by field — never a spread, so an authored `filters` block
 * that names only `labels` still inherits the trust gate rather than resolving it
 * to "anyone".
 */
export function resolveIssuePolicy(config: IssueConfig | null | undefined): ResolvedIssuePolicy {
  const f = config?.filters;
  return {
    enabled: config?.enabled ?? false,
    source: config?.source,
    mode: config?.mode ?? "triage",
    intervalMinutes: config?.intervalMinutes ?? 60,
    maxConcurrent: config?.maxConcurrent ?? 2,
    claimLabel: config?.claimLabel ?? DEFAULT_ISSUE_CLAIM_LABEL,
    filters: {
      trust: f?.trust ?? [...DEFAULT_ISSUE_TRUST],
      authors: f?.authors ?? [],
      excludeAuthors: f?.excludeAuthors ?? [],
      includeBots: f?.includeBots ?? false,
      labels: f?.labels ?? [],
      excludeLabels: f?.excludeLabels ?? [],
      skipAssigned: f?.skipAssigned ?? true,
      titlePattern: f?.titlePattern,
    },
    harness: config?.harness,
    model: config?.model,
    effort: config?.effort,
    personaId: config?.personaId,
    agentId: config?.agentId,
    instructions: config?.instructions,
  };
}

export type IssueMatch = { ok: true } | { ok: false; reason: string };

/**
 * Does an issue pass a project's filters — and if not, WHY not?
 *
 * The reason is the product, not a debugging aid: "the watcher is on and nothing
 * happened" is the first thing anyone configuring this will hit, and the answer
 * is almost always a filter. Returning it lets the UI say which one.
 *
 * Logins compare case-insensitively (GitHub's do); labels compare exactly
 * except for case, which GitHub also ignores.
 */
export function matchIssue(issue: Issue, policy: Pick<ResolvedIssuePolicy, "filters" | "claimLabel">): IssueMatch {
  const f = policy.filters;
  const lower = (xs: readonly string[]) => new Set(xs.map((x) => x.toLowerCase()));
  const labels = lower(issue.labels);
  const author = issue.author.toLowerCase();

  if (issue.state !== "open") return { ok: false, reason: "not open" };
  if (labels.has(policy.claimLabel.toLowerCase())) {
    return { ok: false, reason: `already claimed (${policy.claimLabel})` };
  }
  if (lower(f.excludeAuthors).has(author)) return { ok: false, reason: `author ${issue.author} is excluded` };
  if (issue.authorIsBot && !f.includeBots) return { ok: false, reason: `author ${issue.author} is a bot` };
  if (!lower(f.authors).has(author) && !f.trust.includes(issue.authorTrust)) {
    return { ok: false, reason: `author ${issue.author} is ${issue.authorTrust}, not ${f.trust.join("/")}` };
  }
  if (f.skipAssigned && issue.assignees.length) {
    return { ok: false, reason: `already assigned to ${issue.assignees.join(", ")}` };
  }
  const excluded = f.excludeLabels.find((l) => labels.has(l.toLowerCase()));
  if (excluded) return { ok: false, reason: `labelled ${excluded}` };
  if (f.labels.length && !f.labels.some((l) => labels.has(l.toLowerCase()))) {
    return { ok: false, reason: `missing a required label (${f.labels.join(", ")})` };
  }
  if (f.titlePattern && !new RegExp(f.titlePattern, "i").test(issue.title)) {
    return { ok: false, reason: `title doesn't match /${f.titlePattern}/` };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ claims */

/**
 * Where a claimed issue is in its life. Rows never go back: a `released` issue
 * is one a human ended (deleted the chat), and re-claiming it automatically
 * would undo exactly the thing they did — it can only be picked up again by hand.
 */
export const IssueClaimStateSchema = z.enum(["claimed", "working", "done", "released", "failed"]);
export type IssueClaimState = z.infer<typeof IssueClaimStateSchema>;

/**
 * One issue this instance has taken on — the `state.db` half of the lock. The
 * other half is the claim label on the issue itself, which is what a SECOND
 * instance (or a human) sees; this row is what stops this instance from
 * re-spawning for an issue it already handed to a chat.
 */
export const IssueClaimSchema = z.object({
  /** {@link issueKey}: `github:owner/repo#12`. */
  key: z.string(),
  projectId: z.string(),
  source: IssueSourceSchema,
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  state: IssueClaimStateSchema,
  mode: IssueModeSchema,
  /** The chat handling it (absent while `claimed` — before the spawn landed). */
  chatId: z.string().optional(),
  /** Why it failed or was released, when it was. */
  note: z.string().optional(),
  claimedAt: z.number(),
  updatedAt: z.number(),
});
export type IssueClaim = z.infer<typeof IssueClaimSchema>;

/**
 * Per-project poll bookkeeping. `baselineAt` is the enrolment moment: only an
 * issue opened AFTER it is ever picked up, so switching a project on does not
 * hand the whole backlog to agents in one pass.
 */
export const IssueWatchSchema = z.object({
  projectId: z.string(),
  baselineAt: z.number(),
  lastPolledAt: z.number().optional(),
  lastError: z.string().optional(),
  /** What the last poll saw, for the pane: every open issue and why it was or wasn't taken. */
  lastSeen: z
    .array(
      z.object({
        number: z.number().int(),
        title: z.string(),
        url: z.string(),
        taken: z.boolean(),
        reason: z.string().optional(),
      }),
    )
    .optional(),
});
export type IssueWatch = z.infer<typeof IssueWatchSchema>;

/** The chat purpose kind the watcher spawns — matches the `issue:handle` task. */
export const ISSUE_HANDLE_KIND = "issue:handle";

/** The sidebar sentence for an issue-handling chat. */
export function issueHandlingPurposeLabel(sourceLabel: string, numbers: readonly number[]): string {
  return numbers.length === 1
    ? `Handling issue #${numbers[0]} in ${sourceLabel}`
    : `Handling ${numbers.length} issues in ${sourceLabel}`;
}
