/**
 * Background update checks for git-installed plugins, and the `auto` policy.
 *
 * Every pass runs the SAME `checkUpdate` / `update` the Settings pane's buttons
 * do — nothing here decides what an update is, only when to ask and what to do
 * with the answer, per `AppSettings.plugins[id].autoUpdate`:
 *
 *   off     — skipped
 *   notify  — checked; a NEW available update (one this process has not
 *             announced at that commit) becomes a notice
 *   auto    — checked; installed when it asks for nothing new and is
 *             installable, otherwise treated as `notify`
 *
 * An auto-installed update is files on disk and `needsRestart` on the row —
 * never a restart. Stopping the server tree-kills every subApp and cuts every
 * running chat, and choosing when that happens is the owner's.
 *
 * Like `ReleaseService`: the first pass is deferred so an unreachable git host
 * delays no boot, timers are unref'd, and a failed check is a row result, so
 * one dead remote never stops the pass.
 */
import {
  DEFAULT_PLUGIN_AUTO_UPDATE,
  type PluginAutoApplied,
  type PluginAutoUpdate,
  type PluginInfo,
  type PluginUpdateCheck,
  type PluginUpdateStatus,
} from "@dispatch/shared";
import type { PluginInspector } from "./index.js";

const HOUR = 3_600_000;

export interface PluginUpdateWatcherOptions {
  inspector: Pick<PluginInspector, "checkUpdate" | "update">;
  /** Every plugin row; only `origin: "url"` ones are checked. */
  list: () => PluginInfo[];
  /** A toast for whoever has a tab open. */
  notice: (level: "info" | "warn", text: string) => void;
  /** 0 switches background checks off. */
  intervalHours: number;
  firstCheckMs?: number;
  now?: () => number;
}

/**
 * Bounds on a non-zero interval. The top one is not taste: `setInterval` takes
 * at most 2^31-1 ms (~596 h), and past it Node clamps the delay to 1 ms — a
 * "monthly" 720 would `ls-remote` and fetch tarballs from every plugin's
 * remote in a loop. The bottom one keeps a typo like 0.0001 from doing the same.
 */
export const MIN_PLUGIN_UPDATE_HOURS = 0.25;
export const MAX_PLUGIN_UPDATE_HOURS = 24 * 21;

/** 0 stays 0 (off); anything else is clamped into range. */
export function clampPluginUpdateHours(hours: number): number {
  if (hours <= 0) return 0;
  return Math.min(MAX_PLUGIN_UPDATE_HOURS, Math.max(MIN_PLUGIN_UPDATE_HOURS, hours));
}

/** `DISPATCH_PLUGIN_UPDATE_HOURS`, defaulting to 6; anything unparseable is the default, not "off". */
export function pluginUpdateHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DISPATCH_PLUGIN_UPDATE_HOURS;
  if (raw === undefined || raw.trim() === "") return 6;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? clampPluginUpdateHours(n) : 6;
}

/** Would `auto` install this? Nothing new asked for, the same plugin, and installable. */
export function autoApplicable(check: PluginUpdateCheck): boolean {
  return (
    check.status === "available" &&
    !!check.target &&
    !!check.diff &&
    check.diff.escalations.length === 0 &&
    !!check.inspection?.installable &&
    check.inspection.id === check.id
  );
}

export class PluginUpdateWatcher {
  private firstTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private lastRunAt?: number;
  private nextRunAt?: number;
  private checks: Record<string, PluginUpdateCheck> = {};
  private applied: Record<string, PluginAutoApplied> = {};
  /** `id@sha` already announced, so a pass every six hours does not re-toast the same update. */
  private announced = new Set<string>();
  private readonly now: () => number;

  constructor(private opts: PluginUpdateWatcherOptions) {
    this.now = opts.now ?? Date.now;
    // Clamped here too, not only when read from the environment: a caller
    // passing hours directly must not be able to arm a 1 ms interval either.
    this.opts = { ...opts, intervalHours: clampPluginUpdateHours(opts.intervalHours) };
  }

  start(): void {
    if (this.opts.intervalHours <= 0 || this.timer || this.stopped) return;
    const first = this.opts.firstCheckMs ?? 2 * 60_000;
    this.nextRunAt = this.now() + first;
    this.firstTimer = setTimeout(() => void this.run().catch(() => {}), first);
    this.firstTimer.unref?.();
    const every = this.opts.intervalHours * HOUR;
    this.timer = setInterval(() => void this.run().catch(() => {}), every);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.timer) clearInterval(this.timer);
    this.firstTimer = null;
    this.timer = null;
  }

  /** Let a pass that is mid-update land before the host goes away under it. */
  async drain(): Promise<void> {
    await this.inFlight?.catch(() => {});
  }

  status(): PluginUpdateStatus {
    return {
      intervalHours: this.opts.intervalHours,
      running: !!this.inFlight,
      ...(this.lastRunAt ? { lastRunAt: this.lastRunAt } : {}),
      ...(this.nextRunAt && this.timer ? { nextRunAt: this.nextRunAt } : {}),
      checks: { ...this.checks },
      applied: { ...this.applied },
    };
  }

  /** One pass now; joins a pass already running rather than starting a second. */
  run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.inFlight ??= this.pass().finally(() => {
      this.inFlight = null;
      this.lastRunAt = this.now();
      if (this.timer) this.nextRunAt = this.lastRunAt + this.opts.intervalHours * HOUR;
    });
    return this.inFlight;
  }

  private async pass(): Promise<void> {
    const rows = this.opts.list().filter((p) => p.origin === "url");
    const seen = new Set<string>();
    const found: PluginUpdateCheck[] = [];
    for (const p of rows) {
      if (this.stopped) return;
      const policy: PluginAutoUpdate = p.autoUpdate ?? DEFAULT_PLUGIN_AUTO_UPDATE;
      if (policy === "off") continue;
      seen.add(p.id);
      let check: PluginUpdateCheck;
      try {
        check = await this.opts.inspector.checkUpdate(p.id);
      } catch (err) {
        // `checkUpdate` maps network trouble to a row result already; this is
        // the plugin vanishing mid-pass, or a bug — neither may end the pass.
        check = { id: p.id, status: "error", origin: p.origin, message: err instanceof Error ? err.message : String(err), checkedAt: this.now() };
      }
      if (policy === "auto" && autoApplicable(check)) {
        try {
          const res = await this.opts.inspector.update(p.id, check.target!.sha);
          this.applied[p.id] = {
            fromSha: res.fromSha,
            sha: res.sha,
            ref: res.ref,
            ...(check.diff?.fromVersion ? { fromVersion: check.diff.fromVersion } : {}),
            ...(check.target!.version ? { version: check.target!.version } : {}),
            at: this.now(),
          };
          delete this.checks[p.id];
          const to = check.target!.version ? `v${check.target!.version}` : res.sha.slice(0, 7);
          this.opts.notice("info", `Updated plugin ${p.name} to ${to}. Restart Dispatch to load it.`);
          continue;
        } catch (err) {
          // Refused (the ref moved since the check, a concurrent install…):
          // fall through and announce it like `notify` would.
          check = { ...check, message: [check.message, `auto-update failed: ${err instanceof Error ? err.message : String(err)}`].filter(Boolean).join("; ") };
        }
      }
      this.checks[p.id] = check;
      if (check.status === "available" && check.target) found.push(check);
    }
    // A plugin uninstalled, or switched to `off`, since the last pass.
    for (const id of Object.keys(this.checks)) if (!seen.has(id)) delete this.checks[id];

    const fresh = found.filter((c) => !this.announced.has(`${c.id}@${c.target!.sha}`));
    for (const c of fresh) this.announced.add(`${c.id}@${c.target!.sha}`);
    if (fresh.length) {
      const names = fresh.map((c) => rows.find((r) => r.id === c.id)?.name ?? c.id);
      const asks = fresh.some((c) => (c.diff?.escalations.length ?? 0) > 0);
      this.opts.notice(
        "info",
        `Plugin update${fresh.length === 1 ? "" : "s"} available: ${names.join(", ")}` +
          `${asks ? " — some ask for more access" : ""}. Review in Settings → Plugins.`,
      );
    }
  }
}
