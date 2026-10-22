/**
 * LimitSampler — the ONE schedule that reads every account's limit windows.
 *
 * Before this, each Claude account's usage poller ran its own 5-minute timer,
 * and only once something had asked about that account — so a second login
 * nobody had opened a chat on was never read at all, and Codex was read only
 * when the card opened. A history needs every account read on a schedule
 * nobody has to remember to trigger; one scheduler is also the only way to
 * guarantee two timers never spend the same token's rate-limit bucket.
 *
 * WHERE A READING COMES FROM is a {@link LimitSource}, one per provider: Claude
 * through its OAuth usage endpoint (the existing {@link UsageService}, which
 * keeps the 429 cooldown), a runtime that reports its own limits (Codex)
 * through `Harness.readLimits`. A new provider is a new source, not a new
 * branch in the scheduler.
 *
 * CADENCE IS ADAPTIVE, never faster than the source's floor:
 *   - every `activeMs` while the figures are moving or a turn just ran;
 *   - every `idleMs` once several reads in a row came back unchanged;
 *   - one extra read just after a window's announced reset, so a scheduled
 *     reset is seen within a minute even on an idle account — and an early
 *     one is not mistaken for it;
 *   - after a failure, exponential backoff; after a 429, the source's cooldown.
 * Reads are jittered so two accounts never ask in the same instant.
 */
import {
  accountLabel,
  type HarnessKind,
  type LimitAccountStatus,
  type LimitReading,
  type ResolvedSubscription,
  type SubscriptionSettings,
} from "@dispatch/shared";
import type { HarnessRegistry } from "../harness/index.js";
import type { Harness, HarnessLimits } from "../harness/types.js";
import type { LimitLedger } from "./limit-ledger.js";
import { accountOf, subscriptionStatuses } from "./subscriptions.js";
import type { UsageRegistry } from "./usage.js";

/** One read's answer. */
export type LimitRead =
  | { ok: true; readings: LimitReading[]; planType?: string; resetCredits?: number }
  | { ok: false; error: string; /** Don't ask again before this. */ retryAt?: number };

export interface LimitCadence {
  /** Never two reads of one account closer than this. */
  floorMs: number;
  /** While figures move. */
  activeMs: number;
  /** Once they've stopped moving. */
  idleMs: number;
}

/** Where one provider's readings come from. */
export interface LimitSource {
  cadence: LimitCadence;
  read(sub: ResolvedSubscription): Promise<LimitRead>;
}

/**
 * Claude, through the OAuth usage endpoint. Five minutes is the poll the header
 * meter always ran at without trouble; the endpoint punishes anything much
 * faster with a 429 that lasts long after the burst.
 */
export class ClaudeLimitSource implements LimitSource {
  readonly cadence: LimitCadence = { floorMs: 5 * 60_000, activeMs: 5 * 60_000, idleMs: 15 * 60_000 };

  constructor(private readonly usage: UsageRegistry) {}

  async read(sub: ResolvedSubscription): Promise<LimitRead> {
    const poller = this.usage.for(accountOf(sub));
    const snap = await poller.sample();
    if (snap.error === "rate_limited") return { ok: false, error: "rate_limited", retryAt: poller.cooldownEndsAt };
    if (snap.stale || snap.error) return { ok: false, error: snap.error ?? "unavailable" };
    return {
      ok: true,
      readings: snap.limits ?? [],
      ...(snap.planType ? { planType: snap.planType } : {}),
    };
  }
}

/** HarnessLimits → readings: the tracked list when given, else the two slots. */
export function readingsOfLimits(limits: HarnessLimits): LimitReading[] {
  const windows =
    limits.tracked ??
    [
      limits.primary ? { ...limits.primary, id: "primary", title: "Primary window" } : null,
      limits.secondary ? { ...limits.secondary, id: "secondary", title: "Secondary window" } : null,
    ].filter((w) => w !== null);
  return windows.flatMap((w) =>
    typeof w.usedPercent === "number"
      ? [
          {
            windowId: w.id,
            title: w.title,
            windowMinutes: w.windowMinutes ?? null,
            percent: w.usedPercent,
            resetsAt: w.resetsAt ?? null,
          },
        ]
      : [],
  );
}

/**
 * A runtime that reports its own limits (Codex's `account/rateLimits/read`).
 * The read rides the runtime's existing connection rather than a public HTTP
 * endpoint, but it still reaches the vendor's backend, so it keeps the same
 * five-minute floor rather than inventing a faster one nobody has tested.
 */
export class HarnessLimitSource implements LimitSource {
  readonly cadence: LimitCadence = { floorMs: 5 * 60_000, activeMs: 5 * 60_000, idleMs: 15 * 60_000 };

  constructor(private readonly harness: Harness) {}

  async read(sub: ResolvedSubscription): Promise<LimitRead> {
    const limits = await this.harness.readLimits(accountOf(sub));
    if (!limits) return { ok: false, error: "unavailable" };
    return {
      ok: true,
      readings: readingsOfLimits(limits),
      ...(limits.planType ? { planType: limits.planType } : {}),
      ...(typeof limits.resetCredits === "number" ? { resetCredits: limits.resetCredits } : {}),
    };
  }
}

/**
 * The source for a provider, or none. Claude is named outright rather than
 * "anything without `usageLimits`": an endpoint provider (goose, a local
 * model) has no limits at all, and routing it at the Claude poller would read
 * a `.credentials.json` that was never going to exist.
 */
export function limitSourceFor(
  provider: HarnessKind,
  harnesses: HarnessRegistry,
  claude: LimitSource,
): LimitSource | undefined {
  if (provider === "claude") return claude;
  const harness = harnesses.find(provider);
  return harness?.capabilities.usageLimits ? new HarnessLimitSource(harness) : undefined;
}

/** Unchanged reads in a row before an account counts as idle. */
const IDLE_AFTER = 3;
/** Read this long after an announced reset — late enough to see it rolled. */
const AFTER_RESET_MS = 45_000;
/** Longest backoff after plain failures. */
const MAX_BACKOFF_MS = 30 * 60_000;
/** How often the loop looks for due accounts. */
const TICK_MS = 30_000;

interface AccountSchedule {
  provider: HarnessKind;
  label: string;
  lastAt: number | null;
  lastOkAt: number | null;
  nextAt: number;
  error: string | null;
  failures: number;
  unchanged: number;
  /** Fingerprint of the last good read, for "did anything move". */
  print: string | null;
  planType: string | null;
  resetCredits: number | null;
  inflight: boolean;
}

export interface LimitSamplerDeps {
  ledger: LimitLedger;
  harnesses: HarnessRegistry;
  usage: UsageRegistry;
  /** The current settings — accounts come and go while the server runs. */
  settings: () => Promise<SubscriptionSettings | null>;
  now?: () => number;
  /** Jitter source in [0,1) (tests pin it). */
  random?: () => number;
  /** Override a provider's source (tests). */
  sourceFor?: (provider: HarnessKind) => LimitSource | undefined;
  /** Installed providers only (tests stub). */
  installed?: () => Set<HarnessKind>;
  /** The accounts to read (tests stub; default: logged-in, installed ones). */
  accounts?: () => Promise<ResolvedSubscription[]>;
}

export class LimitSampler {
  private readonly ledger: LimitLedger;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sourceFor: (provider: HarnessKind) => LimitSource | undefined;
  private readonly installed: () => Set<HarnessKind>;
  private readonly schedules = new Map<string, AccountSchedule>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  private offPush: Array<() => void> = [];

  constructor(private readonly deps: LimitSamplerDeps) {
    this.ledger = deps.ledger;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    const claude = new ClaudeLimitSource(deps.usage);
    this.sourceFor = deps.sourceFor ?? ((p) => limitSourceFor(p, deps.harnesses, claude));
    this.installed =
      deps.installed ??
      (() =>
        new Set(
          deps.harnesses
            .list()
            .filter((h) => h.runtime().available)
            .map((h) => h.kind),
        ));
  }

  start(): void {
    if (this.timer) return;
    for (const h of this.deps.harnesses.list()) {
      const off = h.onLimits?.((subscriptionId, limits) => this.onPush(h.kind, subscriptionId, limits));
      if (off) this.offPush.push(off);
    }
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.offPush) off();
    this.offPush = [];
  }

  /**
   * A turn just spent from this account — read it as soon as the floor allows.
   * Called per turn; the floor is what keeps a busy account at one read per
   * five minutes rather than one per turn.
   */
  nudge(subscriptionId: string | undefined): void {
    if (!subscriptionId) return;
    const s = this.schedules.get(subscriptionId);
    if (!s) return;
    const floor = this.sourceFor(s.provider)?.cadence.floorMs ?? 0;
    s.unchanged = 0;
    s.nextAt = Math.min(s.nextAt, Math.max(this.now(), (s.lastAt ?? 0) + floor));
  }

  /** Every account the sampler is watching, for the tab's status strip. */
  status(): LimitAccountStatus[] {
    return [...this.schedules].map(([subscriptionId, s]) => ({
      subscriptionId,
      label: s.label,
      provider: s.provider,
      lastAt: s.lastAt,
      lastOkAt: s.lastOkAt,
      nextAt: s.nextAt,
      error: s.error,
      planType: s.planType,
      resetCredits: s.resetCredits,
    }));
  }

  /** One pass: refresh the account list, read whatever is due. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    const accounts = await this.accounts();
    const now = this.now();
    const due = accounts.filter((sub) => {
      const s = this.schedules.get(sub.id)!;
      return !s.inflight && s.nextAt <= now;
    });
    // In parallel: each account has its own token and its own bucket, and one
    // slow runtime must not delay another account's read past its reset.
    await Promise.all(due.map((sub) => this.sample(sub)));
  }

  /** The accounts worth reading, with schedules for any new ones. */
  private async accounts(): Promise<ResolvedSubscription[]> {
    const subs = (await this.listAccounts()).filter((s) => this.sourceFor(s.provider));
    const live = new Set(subs.map((s) => s.id));
    for (const id of this.schedules.keys()) if (!live.has(id)) this.schedules.delete(id);
    for (const sub of subs) {
      const known = this.schedules.get(sub.id);
      if (known) {
        known.label = accountLabel(sub);
        continue;
      }
      this.schedules.set(sub.id, {
        provider: sub.provider,
        label: accountLabel(sub),
        lastAt: null,
        lastOkAt: null,
        // Due at once: each account is its own token and its own bucket, so
        // reading them together costs nothing, and a boot that waited a tick
        // to read would leave the meter blank for half a minute.
        nextAt: this.now(),
        error: null,
        failures: 0,
        unchanged: 0,
        print: null,
        planType: null,
        resetCredits: null,
        inflight: false,
      });
    }
    return subs;
  }

  private async listAccounts(): Promise<ResolvedSubscription[]> {
    if (this.deps.accounts) return this.deps.accounts();
    const settings = await this.deps.settings().catch(() => null);
    const installed = this.installed();
    return subscriptionStatuses(settings).filter((s) => s.loggedIn && installed.has(s.provider));
  }

  private async sample(sub: ResolvedSubscription): Promise<void> {
    const s = this.schedules.get(sub.id);
    const source = this.sourceFor(sub.provider);
    if (!s || !source) return;
    s.inflight = true;
    s.lastAt = this.now();
    let read: LimitRead;
    try {
      read = await source.read(sub);
    } catch (err) {
      read = { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      s.inflight = false;
    }
    this.apply(sub.id, s, source.cadence, read, "poll");
  }

  /** A snapshot the runtime volunteered — recorded, and it counts as a read. */
  private onPush(provider: HarnessKind, subscriptionId: string | undefined, limits: HarnessLimits): void {
    // A push from the provider's default login names no account; it belongs to
    // the account whose id is the provider's own (the implicit one).
    const id = subscriptionId ?? provider;
    const s = this.schedules.get(id);
    const source = this.sourceFor(provider);
    if (!s || !source) return;
    this.apply(
      id,
      s,
      source.cadence,
      {
        ok: true,
        readings: readingsOfLimits(limits),
        ...(limits.planType ? { planType: limits.planType } : {}),
      },
      "push",
    );
  }

  private apply(
    id: string,
    s: AccountSchedule,
    cadence: LimitCadence,
    read: LimitRead,
    source: "poll" | "push",
  ): void {
    const now = this.now();
    const jitter = (ms: number) => Math.round(ms * (0.9 + this.random() * 0.2));
    if (!read.ok) {
      s.error = read.error;
      s.failures += 1;
      const backoff = Math.min(cadence.activeMs * 2 ** (s.failures - 1), MAX_BACKOFF_MS);
      s.nextAt = Math.max(now + jitter(backoff), read.retryAt ?? 0);
      return;
    }
    s.error = null;
    s.failures = 0;
    s.lastOkAt = now;
    if (read.planType) s.planType = read.planType;
    if (read.resetCredits !== undefined) s.resetCredits = read.resetCredits;

    this.ledger.observe({
      ts: now,
      subscriptionId: id,
      provider: s.provider,
      readings: read.readings,
      planType: read.planType ?? null,
      resetCredits: read.resetCredits ?? null,
      source,
    });

    // A push carries one bucket, so it says nothing about whether the
    // account as a whole went quiet; only a poll moves the idle count.
    if (source === "poll") {
      const print = JSON.stringify(read.readings.map((r) => [r.windowId, r.percent, r.resetsAt]));
      s.unchanged = print === s.print ? s.unchanged + 1 : 0;
      s.print = print;
    }
    const interval = s.unchanged >= IDLE_AFTER ? cadence.idleMs : cadence.activeMs;
    let next = now + jitter(interval);
    // Look again just after the next announced reset of a window that has
    // something in it — the read that tells a scheduled reset from an early one.
    for (const r of read.readings) {
      if (r.resetsAt === null || r.percent < 0.5 || r.resetsAt <= now) continue;
      next = Math.min(next, r.resetsAt + AFTER_RESET_MS);
    }
    const floorAt = (source === "poll" ? now : (s.lastAt ?? now)) + cadence.floorMs;
    // A push postpones the next poll — the runtime just told us — but never
    // pulls one in closer than the floor allows.
    s.nextAt = Math.max(next, floorAt);
  }
}
