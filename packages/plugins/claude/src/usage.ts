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
import { homedir } from "node:os";
import { join } from "node:path";
import {
  claudeWindowOf,
  type HarnessAccount,
  type HarnessLimitWindow,
  type HarnessLimits,
  type LimitReading,
} from "@dispatch/shared";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** After a 429, skip reads for this long (the limit persists a while). */
const RATE_LIMIT_COOLDOWN_MS = 30 * 60_000;
/** Floor between reads so a double-click can't hammer the endpoint. */
const MIN_READ_GAP_MS = 5_000;
/** Per-request timeout so a hung fetch can't wedge a read. */
const FETCH_TIMEOUT_MS = 10_000;

/** Headers the endpoint expects; the User-Agent avoids a stricter 429 bucket. */
const REQUEST_HEADERS: Record<string, string> = {
  "anthropic-beta": "oauth-2025-04-20",
  "Content-Type": "application/json",
  "User-Agent": "claude-cli/2.0.0 (external, cli)",
};

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
export function limitsOfUsage(data: RawUsage & Record<string, unknown>): HarnessLimits {
  const primary = toWindow(data.five_hour, FIVE_HOUR_MINUTES);
  const secondary = toWindow(data.seven_day, WEEK_MINUTES);
  return {
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
}

/** One account's poller: a cache, a cooldown and request coalescing — no timer. */
export class ClaudeUsagePoller {
  private readonly fetchImpl: typeof fetch;
  private readonly readToken: () => Promise<string | null>;
  private readonly now: () => number;

  private latest: HarnessLimits | null = null;
  /** In-flight poll, so concurrent readers coalesce onto one request. */
  private inflight: Promise<HarnessLimits> | null = null;
  /** Reads are held off until this time after a 429. */
  private cooldownUntil = 0;
  private lastPollAt = 0;

  constructor(deps: ClaudeUsagePollerDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.readToken = deps.readToken ?? (() => readClaudeOauthToken(deps.configDir));
    this.now = deps.now ?? Date.now;
  }

  /** Latest limits, fetching once if never read. Marked `stale` when the last read failed. */
  async cached(): Promise<HarnessLimits> {
    return this.latest ?? this.poll();
  }

  /**
   * A read that answers from the endpoint or throws — `readLimits({ fresh })`.
   * Honours the 429 cooldown and the double-click floor; inside either, the
   * last good answer is returned if it IS good, and a cooldown otherwise throws
   * with the time it lifts so the sampler doesn't ask again before then.
   */
  async fresh(): Promise<HarnessLimits> {
    const now = this.now();
    if (now < this.cooldownUntil) throw new ClaudeLimitReadError("rate_limited", this.cooldownUntil);
    if (this.inflight) return this.raiseStale(await this.inflight);
    if (this.latest && !this.latest.stale && now - this.lastPollAt < MIN_READ_GAP_MS) return this.latest;
    return this.raiseStale(await this.poll());
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
          headers: { ...REQUEST_HEADERS, Authorization: `Bearer ${token}` },
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
      return this.commit(limitsOfUsage(data));
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
