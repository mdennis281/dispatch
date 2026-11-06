/**
 * `ctx.shared` — plugin state and locks in the CONFIG root, which both
 * instances on the machine (stable and dev) and every plugin update share.
 *
 * `ctx.kv` lives in the per-instance state database on purpose, so it cannot
 * do this. A plugin that coordinates work OUTSIDE Dispatch — one Tier B agent
 * per Mac, one elevation at a time per machine, an upgrade that must not run
 * twice — needs one record both instances agree on. Before this the only
 * shared, writable thing was settings, which is the human's, and secrets.
 *
 * WHY ITS OWN DATABASE, AND WHY NO MIGRATION LIST. Two DIFFERENT builds open
 * this file at once as a matter of course: stable is whatever was installed
 * last, dev is whatever is checked out. `StateDb` refuses a schema newer than
 * it knows (correct for one instance's own data). Here that would let a dev
 * build lock stable out of its plugins' shared state. So the schema is
 * `CREATE … IF NOT EXISTS` and ADDITIVE ONLY: a new column or table is fine,
 * changing or dropping one is not, ever — an older build must keep working
 * against a file a newer one touched.
 *
 * Every write runs in `BEGIN IMMEDIATE`, which takes SQLite's write lock up
 * front, so a read-check-write (compareAndSet, taking a lock) is atomic across
 * processes, not just within this one. WAL lets readers in the other instance
 * carry on meanwhile.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  PLUGIN_SHARED_DB_FILENAME,
  PLUGIN_SHARED_LIMITS,
  type PluginContext,
  type PluginInstance,
  type PluginSharedEntry,
  type PluginSharedLock,
  type PluginSharedLockHolder,
  type PluginSharedLockOptions,
} from "@dispatch/shared";

/** Additive only — see the module comment. */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS plugin_shared_kv (
    plugin      TEXT    NOT NULL,
    key         TEXT    NOT NULL,
    value       TEXT    NOT NULL,
    version     INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    updated_by  TEXT,
    PRIMARY KEY (plugin, key)
  );
  -- Each plugin's write counter. A value's version is the counter at its last
  -- write, so a key deleted and created again never gets back a version a
  -- reader may still be holding (the ABA a restart-at-1 version allowed).
  CREATE TABLE IF NOT EXISTS plugin_shared_seq (
    plugin  TEXT    PRIMARY KEY,
    seq     INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS plugin_shared_lock (
    plugin       TEXT    NOT NULL,
    name         TEXT    NOT NULL,
    token        TEXT    NOT NULL,
    instance_id  TEXT,
    role         TEXT,
    acquired_at  INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    PRIMARY KEY (plugin, name)
  );
`;

export function pluginSharedDbPath(configDir: string): string {
  return join(configDir, PLUGIN_SHARED_DB_FILENAME);
}

export interface SharedEntryRow {
  value: unknown;
  version: number;
  updatedAt: number;
  updatedBy?: string;
}

export interface SharedLockRow {
  token: string;
  instanceId?: string;
  role?: string;
  acquiredAt: number;
  expiresAt: number;
}

/** Who is writing: the instance, so a holder can be named and a row attributed. */
export interface SharedWriter {
  instanceId?: string;
  role?: string;
}

export class PluginSharedStore {
  private db: DatabaseSync | null = null;

  constructor(
    readonly file: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private open(): DatabaseSync {
    if (this.db) return this.db;
    mkdirSync(dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    // The other instance holds the write lock for a few ms per write; wait for
    // it rather than failing with SQLITE_BUSY.
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SCHEMA);
    this.db = db;
    return db;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // Closing twice, or after the file vanished, changes nothing worth saying.
    }
    this.db = null;
  }

  /** One write transaction, taken up front so the read inside it cannot go stale. */
  private tx<T>(fn: (db: DatabaseSync) => T): T {
    const db = this.open();
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn(db);
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /* ---------------------------------------------------------------- kv */

  get(plugin: string, key: string): SharedEntryRow | undefined {
    const row = this.open()
      .prepare("SELECT value, version, updated_at, updated_by FROM plugin_shared_kv WHERE plugin = ? AND key = ?")
      .get(plugin, key) as { value: string; version: number; updated_at: number; updated_by: string | null } | undefined;
    if (!row) return undefined;
    return {
      value: JSON.parse(row.value),
      version: Number(row.version),
      updatedAt: Number(row.updated_at),
      ...(row.updated_by ? { updatedBy: row.updated_by } : {}),
    };
  }

  /** Write unconditionally. Returns the new version. */
  set(plugin: string, key: string, json: string, by: SharedWriter): number {
    return this.tx((db) => this.writeRow(db, plugin, key, json, by));
  }

  /**
   * Write only if the entry is still at `expected` (`null`: only if it does
   * not exist). `json` undefined deletes. Atomic across processes.
   */
  compareAndSet(
    plugin: string,
    key: string,
    expected: number | null,
    json: string | undefined,
    by: SharedWriter,
  ): { ok: true; version: number } | { ok: false; current?: SharedEntryRow } {
    return this.tx((db) => {
      const current = this.get(plugin, key);
      const at = current ? current.version : null;
      if (at !== expected) return { ok: false, ...(current ? { current } : {}) };
      if (json === undefined) {
        db.prepare("DELETE FROM plugin_shared_kv WHERE plugin = ? AND key = ?").run(plugin, key);
        return { ok: true, version: 0 };
      }
      return { ok: true, version: this.writeRow(db, plugin, key, json, by) };
    });
  }

  /**
   * Must run inside {@link tx}: the counter bump and the row write are one
   * step, or two writers could stamp the same version.
   */
  private writeRow(db: DatabaseSync, plugin: string, key: string, json: string, by: SharedWriter): number {
    // Seeded past any version already stored, so a counter row lost or never
    // written can never hand out a number a reader has seen.
    const { seq } = db
      .prepare(
        "INSERT INTO plugin_shared_seq (plugin, seq) " +
          "VALUES (?, (SELECT COALESCE(MAX(version), 0) + 1 FROM plugin_shared_kv WHERE plugin = ?)) " +
          "ON CONFLICT(plugin) DO UPDATE SET seq = plugin_shared_seq.seq + 1 RETURNING seq",
      )
      .get(plugin, plugin) as { seq: number };
    db.prepare(
      "INSERT INTO plugin_shared_kv (plugin, key, value, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(plugin, key) DO UPDATE SET value = excluded.value, version = excluded.version, " +
        "updated_at = excluded.updated_at, updated_by = excluded.updated_by",
    ).run(plugin, key, json, seq, this.now(), by.instanceId ?? null);
    return Number(seq);
  }

  delete(plugin: string, key: string): boolean {
    const r = this.open().prepare("DELETE FROM plugin_shared_kv WHERE plugin = ? AND key = ?").run(plugin, key);
    return Number(r.changes) > 0;
  }

  list(plugin: string, prefix = ""): string[] {
    // `substr`, not LIKE: `%` and `_` in a prefix are literal to the caller.
    const rows = this.open()
      .prepare("SELECT key FROM plugin_shared_kv WHERE plugin = ? AND substr(key, 1, ?) = ? ORDER BY key")
      .all(plugin, prefix.length, prefix) as Array<{ key: string }>;
    return rows.map((r) => r.key);
  }

  /* ------------------------------------------------------------- locks */

  /**
   * Take `name` if nobody holds it (or the holder's lease ran out). Returns the
   * lease, or who holds it now.
   */
  tryLock(
    plugin: string,
    name: string,
    ttlMs: number,
    by: SharedWriter,
  ): { ok: true; lock: SharedLockRow } | { ok: false; holder: SharedLockRow } {
    return this.tx((db) => {
      const now = this.now();
      const held = this.readLock(db, plugin, name);
      if (held && held.expiresAt > now) return { ok: false, holder: held };
      const lock: SharedLockRow = {
        token: randomUUID(),
        ...(by.instanceId ? { instanceId: by.instanceId } : {}),
        ...(by.role ? { role: by.role } : {}),
        acquiredAt: now,
        expiresAt: now + ttlMs,
      };
      db.prepare(
        "INSERT INTO plugin_shared_lock (plugin, name, token, instance_id, role, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(plugin, name) DO UPDATE SET token = excluded.token, instance_id = excluded.instance_id, " +
          "role = excluded.role, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at",
      ).run(plugin, name, lock.token, by.instanceId ?? null, by.role ?? null, lock.acquiredAt, lock.expiresAt);
      return { ok: true, lock };
    });
  }

  /** Extend a lease this token still holds. The new expiry, or null when it was lost. */
  renew(plugin: string, name: string, token: string, ttlMs: number): number | null {
    return this.tx((db) => {
      const now = this.now();
      const held = this.readLock(db, plugin, name);
      // An expired lease is NOT renewed even if nobody took it: the holder was
      // told nothing, but anyone checking in between saw it free.
      if (!held || held.token !== token || held.expiresAt <= now) return null;
      const expiresAt = now + ttlMs;
      db.prepare("UPDATE plugin_shared_lock SET expires_at = ? WHERE plugin = ? AND name = ? AND token = ?").run(
        expiresAt,
        plugin,
        name,
        token,
      );
      return expiresAt;
    });
  }

  /** Give a lease back. False when this token no longer held it. */
  release(plugin: string, name: string, token: string): boolean {
    const r = this.open()
      .prepare("DELETE FROM plugin_shared_lock WHERE plugin = ? AND name = ? AND token = ?")
      .run(plugin, name, token);
    return Number(r.changes) > 0;
  }

  /** The live lease on `name`, if any. */
  holder(plugin: string, name: string): SharedLockRow | undefined {
    const held = this.readLock(this.open(), plugin, name);
    return held && held.expiresAt > this.now() ? held : undefined;
  }

  private readLock(db: DatabaseSync, plugin: string, name: string): SharedLockRow | undefined {
    const row = db
      .prepare("SELECT token, instance_id, role, acquired_at, expires_at FROM plugin_shared_lock WHERE plugin = ? AND name = ?")
      .get(plugin, name) as
      | { token: string; instance_id: string | null; role: string | null; acquired_at: number; expires_at: number }
      | undefined;
    if (!row) return undefined;
    return {
      token: row.token,
      ...(row.instance_id ? { instanceId: row.instance_id } : {}),
      ...(row.role ? { role: row.role } : {}),
      acquiredAt: Number(row.acquired_at),
      expiresAt: Number(row.expires_at),
    };
  }

  /* ------------------------------------------------------------ admin */

  /**
   * Whether there is anything here at all. The uninstall preview and purge ask
   * first, so looking does not create a database no plugin ever used.
   */
  private present(): boolean {
    return this.db !== null || existsSync(this.file);
  }

  /** How many keys a plugin holds — the uninstall preview. */
  count(plugin: string): number {
    if (!this.present()) return 0;
    const row = this.open().prepare("SELECT COUNT(*) AS n FROM plugin_shared_kv WHERE plugin = ?").get(plugin) as { n: number };
    return Number(row.n);
  }

  /** Everything a plugin keeps here — uninstall with purge. */
  purge(plugin: string): number {
    if (!this.present()) return 0;
    return this.tx((db) => {
      const n = Number(db.prepare("DELETE FROM plugin_shared_kv WHERE plugin = ?").run(plugin).changes);
      db.prepare("DELETE FROM plugin_shared_lock WHERE plugin = ?").run(plugin);
      db.prepare("DELETE FROM plugin_shared_seq WHERE plugin = ?").run(plugin);
      return n;
    });
  }
}

/* --------------------------------------------------- the plugin's view */

/** What the context's teardown needs: release every lease, stop every renewal. */
export interface PluginSharedHandle {
  api: NonNullable<PluginContext["shared"]>;
  /** Release everything this plugin still holds. Idempotent. */
  dispose(): void;
}

/**
 * Build `ctx.shared` for one plugin, bound to its id so it cannot name
 * another's keys or locks. `pollMs` is how often a waiting `lock` retries.
 */
export function buildPluginShared(
  store: PluginSharedStore,
  pluginId: string,
  instance: PluginInstance | undefined,
  opts: { pollMs?: number; now?: () => number } = {},
): PluginSharedHandle {
  const L = PLUGIN_SHARED_LIMITS;
  const now = opts.now ?? (() => Date.now());
  const pollMs = opts.pollMs ?? 250;
  const by: SharedWriter = {
    ...(instance?.id ? { instanceId: instance.id } : {}),
    ...(instance?.role ? { role: instance.role } : {}),
  };
  const held = new Set<{ release(): Promise<void> }>();
  let disposed = false;

  const checkKey = (key: unknown): string => {
    if (typeof key !== "string" || !key || key.length > L.keyLength) {
      throw new Error(`shared: a key is a string of 1–${L.keyLength} characters`);
    }
    return key;
  };
  const checkName = (name: unknown): string => {
    if (typeof name !== "string" || !name || name.length > L.lockNameLength) {
      throw new Error(`shared: a lock name is a string of 1–${L.lockNameLength} characters`);
    }
    return name;
  };
  const encode = (value: unknown): string => {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("shared: the value has no JSON form");
    if (Buffer.byteLength(json) > L.valueBytes) throw new Error(`shared: the value is over ${L.valueBytes} bytes as JSON`);
    return json;
  };
  const ttlOf = (ttl: unknown): number => {
    const t = ttl ?? L.defaultTtlMs;
    if (typeof t !== "number" || !Number.isFinite(t) || t < L.minTtlMs || t > L.maxTtlMs) {
      throw new Error(`shared: ttlMs must be between ${L.minTtlMs} and ${L.maxTtlMs}`);
    }
    return t;
  };
  const entryOf = <T>(row: SharedEntryRow): PluginSharedEntry<T> => ({
    value: row.value as T,
    version: row.version,
    updatedAt: row.updatedAt,
    ...(row.updatedBy ? { updatedBy: row.updatedBy } : {}),
  });
  const holderOf = (row: SharedLockRow): PluginSharedLockHolder => ({
    ...(row.instanceId ? { instanceId: row.instanceId } : {}),
    ...(row.role ? { role: row.role as PluginInstance["role"] } : {}),
    mine: !!row.instanceId && row.instanceId === instance?.id,
    acquiredAt: row.acquiredAt,
    expiresAt: row.expiresAt,
  });

  const leaseOf = (name: string, row: SharedLockRow, o: PluginSharedLockOptions, ttl: number): PluginSharedLock => {
    let expiresAt = row.expiresAt;
    let lost = false;
    let released = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const markLost = (): void => {
      if (lost || released) return;
      lost = true;
      stop();
      try {
        o.onLost?.();
      } catch {
        // The plugin's own callback; nothing for the host to do about it.
      }
    };
    const stop = (): void => {
      if (timer) clearInterval(timer);
      timer = undefined;
      held.delete(lease);
    };
    const lease: PluginSharedLock = {
      name,
      acquiredAt: row.acquiredAt,
      get expiresAt() {
        return expiresAt;
      },
      get lost() {
        return lost;
      },
      renew: async (ms) => {
        if (lost || released) return false;
        const next = store.renew(pluginId, name, row.token, ms === undefined ? ttl : ttlOf(ms));
        if (next === null) {
          markLost();
          return false;
        }
        expiresAt = next;
        return true;
      },
      release: async () => {
        if (released) return;
        released = true;
        stop();
        if (!lost) store.release(pluginId, name, row.token);
      },
    };
    held.add(lease);
    if (o.autoRenew !== false) {
      timer = setInterval(() => {
        void lease.renew().catch(() => markLost());
      }, Math.max(250, Math.floor(ttl / 3)));
      timer.unref?.();
    }
    return lease;
  };

  const api: NonNullable<PluginContext["shared"]> = {
    get: async <T>(key: string) => store.get(pluginId, checkKey(key))?.value as T | undefined,
    entry: async <T>(key: string) => {
      const row = store.get(pluginId, checkKey(key));
      return row ? entryOf<T>(row) : undefined;
    },
    set: async (key, value) => {
      checkKey(key);
      if (value === undefined) {
        store.delete(pluginId, key);
        return 0;
      }
      return store.set(pluginId, key, encode(value), by);
    },
    compareAndSet: async (key, expectedVersion, value) => {
      checkKey(key);
      if (expectedVersion !== null && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) {
        throw new Error("shared: expectedVersion is a version from entry(), or null for 'does not exist'");
      }
      const r = store.compareAndSet(pluginId, key, expectedVersion, value === undefined ? undefined : encode(value), by);
      return r.ok ? r : { ok: false, ...(r.current ? { current: entryOf(r.current) } : {}) };
    },
    delete: async (key) => store.delete(pluginId, checkKey(key)),
    list: async (prefix) => store.list(pluginId, prefix ?? ""),
    lock: async (name, o = {}) => {
      checkName(name);
      const ttl = ttlOf(o.ttlMs);
      const waitMs = o.waitMs ?? 0;
      if (typeof waitMs !== "number" || !Number.isFinite(waitMs) || waitMs < 0 || waitMs > L.maxWaitMs) {
        throw new Error(`shared: waitMs must be between 0 and ${L.maxWaitMs}`);
      }
      const deadline = now() + waitMs;
      for (;;) {
        if (disposed) return undefined;
        if (o.signal?.aborted) return undefined;
        const r = store.tryLock(pluginId, name, ttl, by);
        if (r.ok) return leaseOf(name, r.lock, o, ttl);
        const left = deadline - now();
        if (left <= 0) return undefined;
        await new Promise<void>((resolve) => {
          const t = setTimeout(done, Math.min(pollMs, left));
          function done(): void {
            clearTimeout(t);
            o.signal?.removeEventListener("abort", done);
            resolve();
          }
          o.signal?.addEventListener("abort", done, { once: true });
        });
      }
    },
    holder: async (name) => {
      const row = store.holder(pluginId, checkName(name));
      return row ? holderOf(row) : undefined;
    },
  };

  return {
    api,
    dispose: () => {
      disposed = true;
      for (const lease of [...held]) void lease.release();
    },
  };
}
