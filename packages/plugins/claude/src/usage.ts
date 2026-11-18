/**
 * Claude's subscription windows — 5-hour, weekly, and the per-model weeklies —
 * as `Harness.readLimits` answers them.
 *
 * Source: the account OAuth usage endpoint
 *   GET https://api.anthropic.com/api/oauth/usage
 *   Authorization: Bearer <oauth access token from <configDir>/.credentials.json>
 *   anthropic-beta: oauth-2025-04-20
 * This endpoint is undocumented and AGGRESSIVELY rate-limited — polling faster
 * than a few minutes earns 429s that persist for a long time. So:
 *   - nothing here runs a timer. The host's limit sampler is the one schedule
 *     for every account, at a five-minute floor; a second timer against the
 *     same token is two requests where one was allowed;
 *   - after a 429 every read is held off for {@link RATE_LIMIT_COOLDOWN_MS} and
 *     answers with the last windows marked stale — a manual refresh included,
 *     since that is exactly the click that keeps a throttled token throttled;
 *   - the token is re-read from disk on each poll so a refresh by Claude Code /
 *     the SDK is picked up (the token is short-lived).
 *
 * This used to be the host's `services/usage.ts`, a `UsageService` the
 * container built unconditionally and the sampler reached by provider NAME. It
 * moved behind the harness so an install without Claude makes no Anthropic call
 * at all, and so a provider without `usageLimits` gets no meter instead of
 * whichever account the Claude poller happened to be watching (#425).
 *
 * The one place in the app that reads a token's contents, and it only ever
 * sends it back to the provider it came from.
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  claudeWindowOf,
  type HarnessAccount,
  type HarnessLimitWindow,
  type HarnessLimits,
  type LimitReading,
  type ResetGrant,
  type ResetSpendOutcome,
} from "@dispatch/shared";

/**
 * `cedar_ember=1` is what makes the endpoint report early-reset grants (the
 * November 2026 full reset, the Fable launch reset). Without it the field comes
 * back null, and for months Dispatch concluded Claude had no resets. This is
 * the same query Claude Code's `/limit-reset` sends. `skip_spend=1` drops the
 * spend block, which nothing here reads.
 */
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1";

/**
 * Used when the runtime's version can't be read. The endpoint gates grants on
 * the CLI version in the User-Agent: `claude-cli/2.0.0` got
 * `ineligible_reason: "cli_version"`. The live version is preferred so the
 * floor keeps moving with the install.
 */
const FALLBACK_CLI_VERSION = "2.1.319";

/** After a 429, skip reads for this long (the limit persists a while). */
const RATE_LIMIT_COOLDOWN_MS = 30 * 60_000;
/** Floor between reads so a double-click can't hammer the endpoint. */
const MIN_READ_GAP_MS = 5_000;
/** Per-request timeout so a hung fetch can't wedge a read. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Headers the endpoint expects. The CLI-shaped User-Agent avoids a stricter 429
 * bucket, and its version decides whether reset grants are reported at all.
 */
function requestHeaders(cliVersion: string | undefined): Record<string, string> {
  return {
    "anthropic-beta": "oauth-2025-04-20",
    "Content-Type": "application/json",
    "User-Agent": `claude-cli/${cliVersion || FALLBACK_CLI_VERSION} (external, cli)`,
  };
}

/** How the card tells someone to spend a Claude reset. */
const CLAUDE_RESET_HINT = "Spend one here once a limit is hit and a grant is available.";

/** One grant in the `cedar_ember` block (only the fields we use). */
interface RawGrant {
  id?: string;
  label?: string;
  resets_total?: number;
  resets_left?: number;
  ends_at?: string | null;
  usable_now?: boolean;
  unavailable_reason?: string | null;
  clears?: string[];
  paused?: boolean;
  starts_at?: string | null;
}
interface RawCedarEmber {
  eligible?: boolean;
  grants?: RawGrant[] | null;
  next_grant_id?: string | null;
  at_limit?: boolean;
}

/**
 * The `cedar_ember` block → grants. Null when the block is absent or the
 * account is ineligible: "reports no resets" must stay distinct from "holds
 * none", or a Claude row would show a misleading 0.
 *
 * A grant past its `ends_at` is dropped: unspent resets are gone at that
 * point, and showing a dead one would inflate the count on the chip.
 */
export function resetGrantsOf(block: unknown, now: number): ResetGrant[] | null {
  const ce = block as RawCedarEmber | null | undefined;
  if (!ce || typeof ce !== "object" || ce.eligible === false || !Array.isArray(ce.grants)) return null;
  const out: ResetGrant[] = [];
  for (const g of ce.grants) {
    if (!g || typeof g.id !== "string" || !/^[a-z0-9_-]{1,40}$/.test(g.id) ||
        typeof g.resets_left !== "number" || !Number.isInteger(g.resets_left) || g.resets_left < 0) continue;
    const expiresAt = isoToMs(g.ends_at);
    if (expiresAt !== undefined && expiresAt <= now) continue;
    out.push({
      id: g.id,
      label: typeof g.label === "string" && g.label.trim() ? g.label : "Limit reset",
      left: g.resets_left,
      spendable: true,
      ...(typeof g.resets_total === "number" ? { total: g.resets_total } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      usableNow: ce.eligible === true && g.usable_now === true && !g.paused &&
        (isoToMs(g.starts_at) ?? 0) <= now,
      ...(g.unavailable_reason ? { unavailableReason: g.unavailable_reason } : {}),
      ...(Array.isArray(g.clears) && g.clears.length
        ? { refills: g.clears.map((k) => claudeWindowOf(k).title) }
        : {}),
    });
  }
  return out;
}

const FIVE_HOUR_MINUTES = 5 * 60;
const WEEK_MINUTES = 7 * 24 * 60;

/** One window as the endpoint reports it (only the fields we use). */
interface RawWindow {
  utilization?: number | null;
  resets_at?: string | null;
}
interface RawUsage {
  five_hour?: RawWindow | null;
  seven_day?: RawWindow | null;
}

/** Read an account's Claude Code OAuth access token from its credential store (or null). */
async function readClaudeOauthToken(configDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(configDir, ".credentials.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: string };
    };
    const tok = parsed.claudeAiOauth?.accessToken;
    return typeof tok === "string" && tok.length > 0 ? tok : null;
  } catch {
    // No file / unreadable / API-key-only setup → no subscription usage to show.
    return null;
  }
}

/** ISO-8601 (`2026-07-07T18:39:59.678+00:00`) → epoch ms, or undefined. */
function isoToMs(s: string | null | undefined): number | undefined {
  if (!s) return undefined;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : undefined;
}

function toWindow(w: RawWindow | null | undefined, windowMinutes: number): HarnessLimitWindow | undefined {
  if (!w || typeof w.utilization !== "number") return undefined;
  const resetsAt = isoToMs(w.resets_at);
  return { usedPercent: w.utilization, windowMinutes, ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

/**
 * Every window in the response, not just the two the meter draws. The
 * endpoint also reports per-model and per-surface weekly windows
 * (`seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps`…), most of them
 * null on most plans; any key whose value carries a numeric `utilization` is a
 * window, so one Anthropic adds later is tracked without a code change.
 */
export function limitReadingsOf(data: Record<string, unknown>): LimitReading[] {
  const out: LimitReading[] = [];
  for (const [key, value] of Object.entries(data)) {
    const w = value as RawWindow | null;
    if (!w || typeof w.utilization !== "number") continue;
    out.push({ ...claudeWindowOf(key), percent: w.utilization, resetsAt: isoToMs(w.resets_at) ?? null });
  }
  return out;
}

/** A 200 body → limits. Exported for the tests that pin the mapping. */
export function limitsOfUsage(data: RawUsage & Record<string, unknown>, now = Date.now()): HarnessLimits {
  const primary = toWindow(data.five_hour, FIVE_HOUR_MINUTES);
  const secondary = toWindow(data.seven_day, WEEK_MINUTES);
  const grants = resetGrantsOf(data.cedar_ember, now);
  return {
    ...(grants ? { resetGrants: grants, resetHint: CLAUDE_RESET_HINT } : {}),
    ...((data.cedar_ember as RawCedarEmber | undefined)?.at_limit === true ? { reached: true } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    // Named windows so the card keeps saying "5-hour session" — the generic
    // label from `windowMinutes` would read "5-hour window".
    windows: [
      ...(primary ? [{ ...primary, title: "5-hour session" }] : []),
      ...(secondary ? [{ ...secondary, title: "Weekly" }] : []),
    ],
    // Same ids the limit history has always recorded Claude under
    // (`claudeWindowOf`), so moving the poller didn't fork any account's series.
    tracked: limitReadingsOf(data).map((r) => ({
      id: r.windowId,
      title: r.title,
      usedPercent: r.percent,
      ...(r.windowMinutes !== null ? { windowMinutes: r.windowMinutes } : {}),
      ...(r.resetsAt !== null ? { resetsAt: r.resetsAt } : {}),
    })),
  };
}

/** A failed read, carrying when it is worth asking again. */
export class ClaudeLimitReadError extends Error {
  constructor(
    message: string,
    /** Epoch ms before which another read would only be refused (a 429 cooldown). */
    readonly retryAt?: number,
  ) {
    super(message);
    this.name = "ClaudeLimitReadError";
  }
}

export interface ClaudeUsagePollerDeps {
  /** The account's Claude config dir. */
  configDir: string;
  /** Injectable for tests (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Injectable token source (defaults to reading `<configDir>/.credentials.json`). */
  readToken?: () => Promise<string | null>;
  /** Injectable clock (tests). */
  now?: () => number;
  /**
   * The Claude Code version to name in the User-Agent — the installed
   * runtime's, read lazily (resolving it runs `claude --version` once).
   */
  cliVersion?: () => string | undefined;
}

/** One account's poller: a cache, a cooldown and request coalescing — no timer. */
export class ClaudeUsagePoller {
  private readonly fetchImpl: typeof fetch;
  private readonly readToken: () => Promise<string | null>;
  private readonly now: () => number;
  private readonly cliVersion: () => string | undefined;

  private latest: HarnessLimits | null = null;
  /** In-flight poll, so concurrent readers coalesce onto one request. */
  private inflight: Promise<HarnessLimits> | null = null;
  /** Reads are held off until this time after a 429. */
  private cooldownUntil = 0;
  private lastPollAt = 0;
  private spending: Promise<ResetSpendOutcome> | null = null;
  // An uncertain POST may already have spent a credit. Retry its request id,
  // never a new claim, even if the next usage read offers a different grant.
  private pendingClaim: { organization: string; grantId: string; requestId: string; at: number } | null = null;

  constructor(deps: ClaudeUsagePollerDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.readToken = deps.readToken ?? (() => readClaudeOauthToken(deps.configDir));
    this.now = deps.now ?? Date.now;
    this.cliVersion = deps.cliVersion ?? (() => undefined);
  }

  /** Latest limits, fetching once if never read. Marked `stale` when the last read failed. */
  async cached(): Promise<HarnessLimits> {
    if (this.spending) await this.spending.catch(() => {});
    return this.latest ?? this.poll();
  }

  /**
   * A read that answers from the endpoint or throws — `readLimits({ fresh })`.
   * Honours the 429 cooldown and the double-click floor; inside either, the
   * last good answer is returned if it IS good, and a cooldown otherwise throws
   * with the time it lifts so the sampler doesn't ask again before then.
   */
  async fresh(): Promise<HarnessLimits> {
    if (this.spending) await this.spending.catch(() => {});
    const now = this.now();
    if (now < this.cooldownUntil) throw new ClaudeLimitReadError("rate_limited", this.cooldownUntil);
    if (this.inflight) return this.raiseStale(await this.inflight);
    if (this.latest && !this.latest.stale && now - this.lastPollAt < MIN_READ_GAP_MS) return this.latest;
    return this.raiseStale(await this.poll());
  }

  /** Account-local serialization also covers two browser tabs confirming together. */
  spendReset(grantId?: string): Promise<ResetSpendOutcome> {
    if (this.spending) return this.spending;
    this.spending = this.doSpendReset(grantId).finally(() => { this.spending = null; });
    return this.spending;
  }

  private async doSpendReset(grantId?: string): Promise<ResetSpendOutcome> {
    // Let a poll already in flight finish before invalidating its old numbers.
    await this.inflight;
    if (this.now() < this.cooldownUntil) throw new ClaudeLimitReadError("rate_limited", this.cooldownUntil);
    const token = await this.readToken();
    if (!token) throw new Error("Sign in to this Claude account before resetting its limits.");
    // Resolve the organization from the SAME bearer used for the claim. The
    // global .claude.json profile can belong to a different subscription.
    const profile = await this.resetRequest(token, "/api/oauth/profile") as { organization?: { uuid?: unknown } };
    const organization = profile?.organization?.uuid;
    if (typeof organization !== "string" || !/^[a-f0-9-]{36}$/i.test(organization)) {
      throw new Error("Claude did not report this account's organization.");
    }
    if (this.pendingClaim && (this.pendingClaim.organization !== organization ||
        this.now() - this.pendingClaim.at >= 10 * 60_000)) this.pendingClaim = null;
    if (!this.pendingClaim) {
      // A five-minute-old chip is not authority to consume an expiring grant.
      const data = await this.resetRequest(token, "/api/oauth/usage?cedar_ember=1&skip_spend=1") as RawUsage & Record<string, unknown>;
      const grants = resetGrantsOf(data?.cedar_ember, this.now());
      if (!grants) throw new Error("Claude did not report reset eligibility. Refresh usage or sign in again.");
      this.commit(limitsOfUsage(data, this.now()));
      this.lastPollAt = this.now();
      const available = grants.filter((g) => g.left > 0 && g.usableNow);
      const next = (data?.cedar_ember as RawCedarEmber | undefined)?.next_grant_id;
      const chosen = grantId ? available.find((g) => g.id === grantId) :
        available.find((g) => g.id === next) ?? available[0];
      if (!chosen) {
        if (!grants.some((g) => g.left > 0)) return "noCredit";
        throw new Error("No Claude reset can be used right now. Refresh usage for its availability.");
      }
      this.pendingClaim = { organization, grantId: chosen.id, requestId: randomUUID(), at: this.now() };
    }
    const claim = this.pendingClaim;
    try {
      // Matches Claude Code's /limit-reset protocol; the provider remains the
      // authority on eligibility and deduplicates a retried request_id.
      const body = await this.resetRequest(token, `/api/organizations/${organization}/reset_rate_limits`, {
        program: "cedar_ember", grant_id: claim.grantId, request_id: claim.requestId,
      }) as { result?: string; reason?: string };
      switch (body?.result) {
        case "reset": this.pendingClaim = null; return "reset";
        case "already_used": this.pendingClaim = null; return "alreadyRedeemed";
        case "not_limited": this.pendingClaim = null; return "nothingToReset";
        case "cooldown":
          this.pendingClaim = null;
          throw new Error("Claude resets are on cooldown. Try again later.");
        case "ineligible":
          this.pendingClaim = null;
          throw new Error("Claude says this account or grant is no longer eligible. Refresh usage.");
        default:
          throw new Error("Claude did not confirm the reset. Retrying will check the same request.");
      }
    } finally {
      // Even a timed-out POST may have succeeded. Don't let the 5s read floor
      // paint the old 100% and credit count over the subsequent refresh.
      this.latest = this.failed("unavailable");
      this.lastPollAt = 0;
    }
  }

  private async resetRequest(token: string, path: string, body?: unknown): Promise<unknown> {
    try {
      const res = await this.fetchImpl(`https://api.anthropic.com${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...requestHeaders(this.cliVersion()), Authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(25_000),
        redirect: "error",
      });
      if (res.status === 429) {
        this.cooldownUntil = this.now() + RATE_LIMIT_COOLDOWN_MS;
        throw new ClaudeLimitReadError("rate_limited", this.cooldownUntil);
      }
      if (res.status === 401 || res.status === 403) throw new Error("Sign in to this Claude account again before resetting limits.");
      if (!res.ok) throw new Error(`Claude reset request failed (HTTP ${res.status}).`);
      return await res.json();
    } catch (err) {
      // Never expose a transport error that could embed the bearer or headers.
      if (err instanceof ClaudeLimitReadError || (err instanceof Error &&
          /^(Sign in to this Claude|Claude reset request failed)/.test(err.message))) throw err;
      throw new Error("Could not confirm the Claude reset request. Try again.");
    }
  }

  private raiseStale(limits: HarnessLimits): HarnessLimits {
    if (!limits.stale) return limits;
    throw new ClaudeLimitReadError(
      limits.error ?? "unavailable",
      limits.error === "rate_limited" ? this.cooldownUntil : undefined,
    );
  }

  /** Fetch + parse + cache. Coalesces concurrent callers. */
  private poll(): Promise<HarnessLimits> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doPoll().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doPoll(): Promise<HarnessLimits> {
    this.lastPollAt = this.now();
    const token = await this.readToken();
    if (!token) return this.commit(this.failed("unavailable"));

    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await this.fetchImpl(USAGE_URL, {
          method: "GET",
          headers: { ...requestHeaders(this.cliVersion()), Authorization: `Bearer ${token}` },
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (res.status === 429) {
        this.cooldownUntil = this.now() + RATE_LIMIT_COOLDOWN_MS;
        return this.commit(this.failed("rate_limited"));
      }
      if (res.status === 401 || res.status === 403) return this.commit(this.failed("unauthenticated"));
      if (!res.ok) return this.commit(this.failed("unavailable"));

      const data = (await res.json()) as RawUsage & Record<string, unknown>;
      // A successful fetch clears any lingering cooldown.
      this.cooldownUntil = 0;
      return this.commit(limitsOfUsage(data, this.now()));
    } catch {
      return this.commit(this.failed("unavailable"));
    }
  }

  /**
   * A failed read keeps the last good windows (marked `stale`) so the meter
   * doesn't blank on a transient blip; only the reason updates.
   */
  private failed(error: string): HarnessLimits {
    const { stale: _stale, error: _error, ...last } = this.latest ?? {};
    return { ...last, stale: true, error };
  }

  private commit(limits: HarnessLimits): HarnessLimits {
    this.latest = limits;
    return limits;
  }
}

/**
 * One poller per Claude account, keyed by config dir: each has its own token,
 * its own 429 bucket and its own windows, which is the whole reason the meter
 * follows the chat's account rather than the provider's.
 *
 * Keyed by DIRECTORY, never by subscription id. The old registry handed the
 * default login's poller to any account with an empty env overlay and re-stamped
 * its id on every lookup — so a goose default account (empty overlay, nothing to
 * do with Claude) got the Claude account's windows under its own name.
 */
export class ClaudeUsage {
  private readonly pollers = new Map<string, ClaudeUsagePoller>();

  constructor(private readonly make: (configDir: string) => ClaudeUsagePoller = (configDir) => new ClaudeUsagePoller({ configDir })) {}

  /** The poller for an account; absent means Claude's default login dir. */
  for(account: HarnessAccount | undefined): ClaudeUsagePoller {
    const dir = account?.configDir ?? defaultClaudeConfigDir();
    let poller = this.pollers.get(dir);
    if (!poller) {
      poller = this.make(dir);
      this.pollers.set(dir, poller);
    }
    return poller;
  }
}

/** Where Claude Code keeps its login when no account names a directory. */
function defaultClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}
