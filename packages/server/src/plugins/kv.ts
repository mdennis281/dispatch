/**
 * `ctx.kv` — a plugin's slice of the `plugin_kv` table in the state database.
 *
 * Values are JSON. The host never reads them; it only stores and returns them
 * for the plugin that wrote them. Keyed by plugin id so two plugins cannot see
 * each other's rows, and the id is bound at construction so a plugin cannot
 * name another one's.
 */
import type { StateDb } from "../store/db.js";

export class PluginKv {
  constructor(
    private readonly db: StateDb,
    private readonly plugin: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const row = this.db
      .prepare("SELECT value FROM plugin_kv WHERE plugin = ? AND key = ?")
      .get(this.plugin, key) as { value: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.value) as T;
  }

  async set(key: string, value: unknown): Promise<void> {
    // `undefined` has no JSON form — storing it would persist the string
    // "undefined" and read back as a parse error. A set to nothing is a delete.
    if (value === undefined) {
      await this.delete(key);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO plugin_kv (plugin, key, value, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(plugin, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(this.plugin, key, JSON.stringify(value), this.now());
  }

  async delete(key: string): Promise<void> {
    this.db.prepare("DELETE FROM plugin_kv WHERE plugin = ? AND key = ?").run(this.plugin, key);
  }

  async list(prefix = ""): Promise<string[]> {
    // `substr` rather than LIKE: a prefix holding `%` or `_` is a literal prefix
    // to the caller, not a pattern.
    const rows = this.db
      .prepare(
        "SELECT key FROM plugin_kv WHERE plugin = ? AND substr(key, 1, ?) = ? ORDER BY key",
      )
      .all(this.plugin, prefix.length, prefix) as Array<{ key: string }>;
    return rows.map((r) => r.key);
  }
}
