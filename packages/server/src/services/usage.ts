/**
 * UsageService — surfaces the Claude subscription's 5-hour + weekly (7-day) usage
 * windows (the same numbers Claude Code's `/usage` shows) for the header meter.
 *
 * Source: the account OAuth usage endpoint
 *   GET https://api.anthropic.com/api/oauth/usage
 *   Authorization: Bearer <oauth access token from ~/.claude/.credentials.json>
 *   anthropic-beta: oauth-2025-04-20
 * This endpoint is undocumented and AGGRESSIVELY rate-limited — polling faster
 * than a few minutes earns 429s that persist for a long time. So we:
 *   - poll ONCE server-side (every 5 min) and fan the snapshot to every client
 *     over the bus, rather than letting each browser tab hit the endpoint;
 *   - back off hard on 429 (skip scheduled polls during a cooldown) and keep
 *     serving the last good windows marked `stale`;
 *   - re-read the token from disk each poll so a refresh by Claude Code / the SDK
 *     is picked up (the token is short-lived).
 *
 * Purely informational: nothing gates on this. A missing token / API-key-only
 * setup just yields an `unavailable` snapshot and the meter hides itself.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageSnapshot, UsageWindow } from "@dispatch/shared";
import type { EventBus } from "../bus.js";
import type { HarnessAccount } from "../harness/types.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** Default 5-min poll (the endpoint punishes anything much faster). */
const DEFAULT_POLL_MS = 5 * 60_000;
/** After a 429, skip scheduled polls for this long (the limit persists a while). */
const RATE_LIMIT_COOLDOWN_MS = 30 * 60_000;
/** Floor between manual refreshes so a double-click can't hammer the endpoint. */
const MIN_MANUAL_GAP_MS = 5_000;
/** Per-request timeout so a hung fetch can't wedge the poll loop. */
const FETCH_TIMEOUT_MS = 10_000;

/** Headers the endpoint expects; the User-Agent avoids a stricter 429 bucket. */
const REQUEST_HEADERS: Record<string, string> = {
  "anthropic-beta": "oauth-2025-04-20",
  "Content-Type": "application/json",
  "User-Agent": "claude-cli/2.0.0 (external, cli)",
};

/** One window as the endpoint reports it (only the fields we use). */
interface RawWindow {
  utilization?: number | null;
  resets_at?: string | null;
}
interface RawUsage {
  five_hour?: RawWindow | null;
  seven_day?: RawWindow | null;
}

export interface UsageServiceDeps {
  bus: EventBus;
  /** Injectable for tests (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Injectable token source (defaults to reading `<configDir>/.credentials.json`). */
  readToken?: () => Promise<string | null>;
  /** The account's Claude config dir. Absent = `~/.claude`, the default login. */
  configDir?: string;
  /** Stamped on every snapshot, so a client can tell whose windows they are. */
  subscriptionId?: string;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Poll interval override (tests / DISPATCH_USAGE_POLL_MS). */
  pollMs?: number;
}

function pollIntervalFromEnv(): number {
  const raw = process.env.DISPATCH_USAGE_POLL_MS;
  if (!raw || raw.trim() === "") return DEFAULT_POLL_MS;
  const n = Number.parseInt(raw, 10);
  // Guard the floor: never let an env typo drop us into 429 territory.
  return Number.isFinite(n) && n >= 60_000 ? n : DEFAULT_POLL_MS;
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

/** ISO-8601 (`2026-07-07T18:39:59.678+00:00`) → epoch ms, or null. */
function isoToMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function toWindow(w: RawWindow | null | undefined): UsageWindow | null {
  if (!w || typeof w.utilization !== "number") return null;
  return { percent: w.utilization, resetsAt: isoToMs(w.resets_at) };
}

export class UsageService {
  private readonly bus: EventBus;
  private readonly fetchImpl: typeof fetch;
  private readonly readToken: () => Promise<string | null>;
  private readonly now: () => number;
  private readonly pollMs: number;
  /**
   * Mutable: the registry re-stamps it on every lookup, because a subscription
   * can be renamed out from under a poller that is still watching its directory.
   */
  subscriptionId?: string;

  private latest: UsageSnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** In-flight poll, so refresh()/get() coalesce onto one request. */
  private inflight: Promise<UsageSnapshot> | null = null;
  /** Scheduled polls are skipped until this time after a 429. */
  private cooldownUntil = 0;
  private lastPollAt = 0;

  constructor(deps: UsageServiceDeps) {
    this.bus = deps.bus;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    const configDir = deps.configDir ?? join(homedir(), ".claude");
    this.readToken = deps.readToken ?? (() => readClaudeOauthToken(configDir));
    this.subscriptionId = deps.subscriptionId;
    this.now = deps.now ?? Date.now;
    this.pollMs = deps.pollMs ?? pollIntervalFromEnv();
  }

  /** Kick an initial poll and start the interval. Best-effort; never throws. */
  start(): void {
    if (this.timer) return;
    void this.poll().catch(() => {});
    this.timer = setInterval(() => {
      // Honor the 429 cooldown: keep the timer cheap, skip the actual fetch.
      if (this.now() < this.cooldownUntil) return;
      void this.poll().catch(() => {});
    }, this.pollMs);
    // Don't keep the process alive just for usage polling.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Latest snapshot, fetching once if we've never polled. */
  async get(): Promise<UsageSnapshot> {
    if (this.latest) return this.latest;
    return this.poll();
  }

  /** Force a fresh fetch now (the manual "refresh" button), floor-spaced. */
  async refresh(): Promise<UsageSnapshot> {
    if (this.inflight) return this.inflight;
    if (this.latest && this.now() - this.lastPollAt < MIN_MANUAL_GAP_MS) {
      return this.latest;
    }
    return this.poll();
  }

  /** Fetch + parse + cache + publish. Coalesces concurrent callers. */
  private poll(): Promise<UsageSnapshot> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doPoll().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doPoll(): Promise<UsageSnapshot> {
    this.lastPollAt = this.now();
    const token = await this.readToken();
    if (!token) return this.commit(this.errorSnapshot("unavailable"));

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
        return this.commit(this.errorSnapshot("rate_limited"));
      }
      if (res.status === 401 || res.status === 403) {
        return this.commit(this.errorSnapshot("unauthenticated"));
      }
      if (!res.ok) return this.commit(this.errorSnapshot("unavailable"));

      const data = (await res.json()) as RawUsage;
      // A successful fetch clears any lingering cooldown.
      this.cooldownUntil = 0;
      return this.commit({
        fiveHour: toWindow(data.five_hour),
        sevenDay: toWindow(data.seven_day),
        fetchedAt: this.now(),
        provider: "claude",
        ...(this.subscriptionId ? { subscriptionId: this.subscriptionId } : {}),
        primaryLabel: "5-hour session",
        secondaryLabel: "Weekly",
      });
    } catch {
      return this.commit(this.errorSnapshot("unavailable"));
    }
  }

  /**
   * A failed refresh keeps the last good windows (marked `stale`) so the meter
   * doesn't blank on a transient blip; only the reason/`fetchedAt` update.
   */
  private errorSnapshot(error: string): UsageSnapshot {
    return {
      fiveHour: this.latest?.fiveHour ?? null,
      sevenDay: this.latest?.sevenDay ?? null,
      fetchedAt: this.now(),
      stale: true,
      error,
      provider: "claude",
      ...(this.subscriptionId ? { subscriptionId: this.subscriptionId } : {}),
      primaryLabel: "5-hour session",
      secondaryLabel: "Weekly",
    };
  }

  /** Cache + broadcast the snapshot. */
  private commit(snapshot: UsageSnapshot): UsageSnapshot {
    this.latest = snapshot;
    this.bus.publish({ type: "usage-update", usage: snapshot });
    return snapshot;
  }
}

/**
 * One {@link UsageService} per Claude account.
 *
 * The default account keeps the service the container always started, so an
 * install with one login polls exactly what it did before. Any other account
 * gets its own poller the first time something asks about it — each has its own
 * token, its own 429 bucket and its own windows, which is the whole reason the
 * meter has to follow the chat's account rather than the provider's.
 */
export class UsageRegistry {
  private readonly others = new Map<string, UsageService>();

  constructor(
    private readonly base: UsageService,
    private readonly make: (account: HarnessAccount) => UsageService,
  ) {}

  /** The poller for an account; absent or default means the base service. */
  for(account: HarnessAccount | undefined): UsageService {
    if (!account || !Object.keys(account.env).length) {
      if (account) this.base.subscriptionId = account.subscriptionId;
      return this.base;
    }
    let svc = this.others.get(account.configDir);
    if (!svc) {
      svc = this.make(account);
      svc.start();
      this.others.set(account.configDir, svc);
    }
    svc.subscriptionId = account.subscriptionId;
    return svc;
  }

  /**
   * Stop the pollers for accounts that no longer exist. Without this an account
   * removed from the list keeps being polled — spending its token's rate-limit
   * bucket and pushing snapshots nobody can select — until the server restarts.
   */
  retain(configDirs: readonly string[]): void {
    const keep = new Set(configDirs);
    for (const [dir, svc] of this.others) {
      if (keep.has(dir)) continue;
      svc.stop();
      this.others.delete(dir);
    }
  }

  /** Stop every poller this registry started (the base is the container's). */
  stop(): void {
    for (const svc of this.others.values()) svc.stop();
    this.others.clear();
  }
}
