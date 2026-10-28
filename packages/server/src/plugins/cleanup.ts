/**
 * PluginCleanupQueue — per-chat plugin cleanups that have not succeeded yet,
 * kept in `plugin_cleanup` (state.db) and retried until they do.
 *
 * Why it exists: a terminal backend's `onChatDeleted` was fire-and-forget. The
 * Proxmox plugin destroys the chat's container there, so a hypervisor that was
 * unreachable at the moment of the delete meant a container running forever,
 * with nothing left in Dispatch that remembered it should not exist. Now a
 * rejection or timeout is a row, and the row is retried:
 *
 *   - on a timer while the server runs, with backoff ({@link BACKOFF_MS});
 *   - after the owning plugin's next activation, once its `reconcile` has run;
 *   - on demand from Settings → Plugins ("Retry now").
 *
 * until the hook resolves. A retry whose target is not registered (the plugin
 * is off) is left alone without counting an attempt — activation retries it.
 * Uninstalling the plugin drops its rows: there is no code left to run them.
 *
 * The queue knows nothing about backends. `run` is injected, so the hook it
 * repeats is whatever the caller recorded under `hook`.
 */
import type { PluginCleanupSummary } from "@dispatch/shared";
import type { StateDb } from "../store/db.js";

/** The one hook recorded today. A string column so a second needs no migration. */
export type CleanupHook = "onChatDeleted";

export interface CleanupKey {
  plugin: string;
  /** The backend (or other registration) the hook belongs to. */
  target: string;
  hook: CleanupHook;
  chatId: string;
}

export interface CleanupRow extends CleanupKey {
  projectId?: string;
  attempts: number;
  lastError?: string;
  createdAt: number;
  nextAt: number;
}

/** What running a row once came to. `unavailable` = its target is not registered right now. */
export type CleanupOutcome = { ok: true } | { ok: false; unavailable: true } | { ok: false; error: string };

/**
 * Delay before the next attempt, by attempts so far. Tops out at six hours: a
 * hypervisor down for a day still gets asked a handful of times, and the row
 * stays visible in Settings the whole while.
 */
export const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000] as const;
/** How often the timer looks for due rows. */
const SWEEP_MS = 60_000;

export interface PluginCleanupQueueOptions {
  db: StateDb;
  run: (row: CleanupRow) => Promise<CleanupOutcome>;
  now?: () => number;
  sweepMs?: number;
  log?: (message: string, err?: unknown) => void;
  /** Told whenever a plugin's rows change, so its Settings row can refresh. */
  changed?: (plugin: string) => void;
}

interface DbRow {
  plugin: string;
  target: string;
  hook: string;
  chat_id: string;
  project_id: string | null;
  attempts: number;
  last_error: string | null;
  created_at: number;
  next_at: number;
}

function fromDb(r: DbRow): CleanupRow {
  return {
    plugin: r.plugin,
    target: r.target,
    hook: r.hook as CleanupHook,
    chatId: r.chat_id,
    ...(r.project_id ? { projectId: r.project_id } : {}),
    attempts: r.attempts,
    ...(r.last_error ? { lastError: r.last_error } : {}),
    createdAt: r.created_at,
    nextAt: r.next_at,
  };
}

/** The delay {@link PluginCleanupQueue.failed} put after a row's latest attempt. */
const backoffAfter = (attempts: number) => BACKOFF_MS[Math.min(Math.max(attempts, 1) - 1, BACKOFF_MS.length - 1)]!;

/**
 * When a row was last attempted. Derived rather than stored: `next_at` is
 * always that moment plus the backoff for its attempt count. NOT `next_at`
 * itself — the most backed-off row is the OLDEST failure, and picking it
 * would show a stale error over the fresh one a human can act on.
 */
const lastAttemptAt = (r: CleanupRow) => r.nextAt - backoffAfter(r.attempts);

const keyOf = (k: CleanupKey) => `${k.plugin}\u0000${k.target}\u0000${k.hook}\u0000${k.chatId}`;

export class PluginCleanupQueue {
  private readonly db: StateDb;
  private readonly now: () => number;
  private readonly sweepMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Keys being run right now, so a sweep and a manual retry never run one row twice at once. */
  private readonly inFlight = new Set<string>();
  private sweeping: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly opts: PluginCleanupQueueOptions) {
    this.db = opts.db;
    this.now = opts.now ?? (() => Date.now());
    this.sweepMs = opts.sweepMs ?? SWEEP_MS;
  }

  /**
   * A hook failed: record it, or count another attempt on the existing row.
   * The original `created_at` survives every retry — "stuck since" is the
   * number a human needs.
   */
  failed(key: CleanupKey, error: string, projectId?: string): void {
    const now = this.now();
    const prev = this.get(key);
    const attempts = (prev?.attempts ?? 0) + 1;
    const delay = backoffAfter(attempts);
    this.db
      .prepare(
        "INSERT INTO plugin_cleanup (plugin, target, hook, chat_id, project_id, attempts, last_error, created_at, next_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(plugin, target, hook, chat_id) DO UPDATE SET attempts = excluded.attempts, " +
          "last_error = excluded.last_error, next_at = excluded.next_at, " +
          "project_id = COALESCE(excluded.project_id, plugin_cleanup.project_id)",
      )
      .run(key.plugin, key.target, key.hook, key.chatId, projectId ?? null, attempts, error, prev?.createdAt ?? now, now + delay);
    this.opts.changed?.(key.plugin);
  }

  /** The hook resolved — including a late success after its timeout was recorded. */
  succeeded(key: CleanupKey): void {
    const r = this.db
      .prepare("DELETE FROM plugin_cleanup WHERE plugin = ? AND target = ? AND hook = ? AND chat_id = ?")
      .run(key.plugin, key.target, key.hook, key.chatId);
    if (Number(r.changes) > 0) this.opts.changed?.(key.plugin);
  }

  get(key: CleanupKey): CleanupRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM plugin_cleanup WHERE plugin = ? AND target = ? AND hook = ? AND chat_id = ?")
      .get(key.plugin, key.target, key.hook, key.chatId) as DbRow | undefined;
    return r && fromDb(r);
  }

  list(plugin?: string): CleanupRow[] {
    const rows = (
      plugin === undefined
        ? this.db.prepare("SELECT * FROM plugin_cleanup ORDER BY created_at").all()
        : this.db.prepare("SELECT * FROM plugin_cleanup WHERE plugin = ? ORDER BY created_at").all(plugin)
    ) as unknown as DbRow[];
    return rows.map(fromDb);
  }

  /** What the plugin's Settings row shows. Undefined when nothing is pending. */
  summary(plugin: string): PluginCleanupSummary | undefined {
    const rows = this.list(plugin);
    if (!rows.length) return undefined;
    // The most recently attempted row carries the freshest error.
    const latest = rows.reduce((a, b) => (lastAttemptAt(b) > lastAttemptAt(a) ? b : a));
    return {
      count: rows.length,
      oldestAt: rows[0]!.createdAt,
      nextAt: Math.min(...rows.map((r) => r.nextAt)),
      attempts: Math.max(...rows.map((r) => r.attempts)),
      ...(latest.lastError ? { lastError: latest.lastError } : {}),
      chats: rows.slice(0, 20).map((r) => r.chatId),
    };
  }

  /** The plugin was uninstalled: no code is left that could ever run its rows. */
  dropPlugin(plugin: string): number {
    const n = Number(this.db.prepare("DELETE FROM plugin_cleanup WHERE plugin = ?").run(plugin).changes);
    if (n > 0) this.opts.changed?.(plugin);
    return n;
  }

  /**
   * Run rows now. `dueOnly` is the timer's filter; activation and the Retry
   * button run everything for the plugin regardless of backoff. Sequential:
   * these are remote calls into one plugin, and a burst of fifty destroys at
   * a hypervisor that just came back is not kinder than fifty in a row.
   */
  async retry(filter: { plugin?: string; dueOnly?: boolean } = {}): Promise<{ ok: number; failed: number; skipped: number }> {
    const result = { ok: 0, failed: 0, skipped: 0 };
    const now = this.now();
    for (const row of this.list(filter.plugin)) {
      if (this.stopped) break;
      if (filter.dueOnly && row.nextAt > now) continue;
      const k = keyOf(row);
      if (this.inFlight.has(k)) continue;
      this.inFlight.add(k);
      try {
        let outcome: CleanupOutcome;
        try {
          outcome = await this.opts.run(row);
        } catch (err) {
          outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        if (outcome.ok) {
          this.succeeded(row);
          result.ok++;
        } else if ("unavailable" in outcome) {
          result.skipped++;
        } else {
          this.failed(row, outcome.error, row.projectId);
          this.opts.log?.(`plugin "${row.plugin}": ${row.hook} for chat ${row.chatId} failed again (attempt ${row.attempts + 1}): ${outcome.error}`);
          result.failed++;
        }
      } finally {
        this.inFlight.delete(k);
      }
    }
    return result;
  }

  /** Arm the backoff timer. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      if (this.sweeping) return;
      this.sweeping = this.retry({ dueOnly: true })
        .then(() => undefined)
        .catch((err: unknown) => this.opts.log?.("plugin cleanup sweep failed", err))
        .finally(() => (this.sweeping = undefined));
    }, this.sweepMs);
    this.timer.unref?.();
  }

  /** Disarm; an in-flight sweep stops at its next row. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async drain(): Promise<void> {
    await this.sweeping;
  }
}
