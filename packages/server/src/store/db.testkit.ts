/**
 * Test-only helpers for the state database. Used by `db.test.ts` and
 * `routes/auth.test.ts`.
 *
 * A plain module rather than an export from `db.test.ts`, because importing one
 * test file from another RE-REGISTERS its `describe` blocks inside the importing
 * file — the borrowed suite runs twice and its `beforeEach` fires during the
 * other file's cases. Vitest only collects `*.test.ts` (see vitest.config.ts),
 * so this name is invisible to the runner.
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { MIGRATION_COMPLETE_UNIT, MIGRATION_TABLE_DDL, STATE_DB_FILENAME } from "./db.js";

/**
 * Stand in for `tools/app/migrate-store.mjs` — one unit copied, and optionally
 * the marker it writes after verifying the whole run.
 *
 * Uses the exported DDL and marker rather than restating them, which is what the
 * script itself does: the guard that reads this table and the tool that writes
 * it must not be able to drift apart.
 */
export function markMigration(dataDir: string, opts: { complete: boolean }): void {
  const db = new DatabaseSync(join(dataDir, STATE_DB_FILENAME));
  try {
    db.exec(MIGRATION_TABLE_DDL);
    const ins = db.prepare(
      "INSERT INTO _migration (unit, rows, sha256, done_at) VALUES (?, ?, ?, ?)",
    );
    ins.run("checkpoints", 0, "sha", 1);
    if (opts.complete) ins.run(MIGRATION_COMPLETE_UNIT, 0, "sha", 1);
  } finally {
    db.close();
  }
}
