/**
 * The STATE root's SQLite database — connection, pragmas, schema versioning.
 *
 * Everything the Store keeps per-instance and rewrites constantly lives here.
 * The JSON files it replaces were whole-file read-modify-write maps: adding one
 * checkpoint rewrote all 2.4 MB of `checkpoints.json`, once per turn, forever.
 * A row is a row here, and the write is proportional to the change.
 *
 * WHY `node:sqlite` AND NOT better-sqlite3. No native module to rebuild per
 * Node/ABI version — the payload is a git clone built in place on the user's
 * machine (see tools/app/build-payload.mjs), so a prebuilt binary that doesn't
 * match their Node is a support burden nobody here can debug remotely.
 *
 * WHY THE NODE FLOOR IS 24, AND WHY A SMOKE TEST WON'T CATCH IT. Node 20 has no
 * `node:sqlite` at all, which fails loudly. Node 22 has it UNFLAGGED but built
 * WITHOUT FTS5: `new DatabaseSync()` succeeds, every table below is created, and
 * only `CREATE VIRTUAL TABLE … USING fts5` throws `no such module: fts5`. So a
 * boot check that merely opens a database passes on 22 and silently costs the
 * transcript search this store exists to make cheap. The floor is enforced in
 * `package.json` engines, `tools/install.mjs`, and the CI `node-version`.
 *
 * All access is SYNCHRONOUS (`DatabaseSync`). That reads wrong for a server
 * until you compare it to what it replaced: the old path awaited a multi-
 * megabyte `readFile` and then blocked the loop for the whole `JSON.parse` +
 * zod-validate of every row anyway. A prepared-statement read of 200 rows is
 * ~6 ms and never yields mid-transaction, which is what makes {@link tx}
 * atomic against other in-process callers without a mutex.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** The database file, inside the STATE root. WAL adds `-wal` / `-shm` beside it. */
export const STATE_DB_FILENAME = "state.db";

/** Absolute path to a state root's database file. */
export function stateDbPath(dataDir: string): string {
  return join(dataDir, STATE_DB_FILENAME);
}

/**
 * Schema steps, applied in order and tracked by `PRAGMA user_version`.
 *
 * APPEND ONLY. `user_version` is the count of steps already applied, so
 * inserting or reordering a step re-runs the wrong SQL against a live store.
 * Editing an existing step is equally wrong for anyone who already migrated.
 */
const MIGRATIONS: ReadonlyArray<string> = [
  // 1 — the whole-file maps. Each was one JSON document rewritten in full on
  // every single-key change; each is now one row per record.
  //
  // Every list-shaped table carries a `seq INTEGER PRIMARY KEY` (the rowid,
  // auto-assigned ascending) and its real key as a UNIQUE column. That is not
  // decoration: these replaced JSON ARRAYS, whose readers see insertion order,
  // and an upsert keyed on `seq` leaves it alone — so `ORDER BY seq` reproduces
  // the old order exactly instead of resorting the roster on every save.
  `
  CREATE TABLE runner (
    seq  INTEGER PRIMARY KEY,
    id   TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL
  );

  -- No natural key: the leases are allocated as a SET (pick the lowest free
  -- port across every project), and the store's only mutator hands back a whole
  -- replacement list. Modelled as exactly that — replace the table's contents in
  -- one transaction — rather than inventing a key the allocator doesn't have.
  CREATE TABLE mcp_port_lease (
    seq  INTEGER PRIMARY KEY,
    body TEXT NOT NULL
  );

  -- project_id is a real column, not just JSON: syncWorktreeRecords reconciles
  -- ONE project's rows against git and must not read (or rewrite) the others.
  CREATE TABLE worktree (
    seq        INTEGER PRIMARY KEY,
    path       TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    body       TEXT NOT NULL
  );
  CREATE INDEX worktree_project ON worktree(project_id);

  CREATE TABLE terminal (
    seq    INTEGER PRIMARY KEY,
    id     TEXT NOT NULL UNIQUE,
    log_id TEXT NOT NULL,
    body   TEXT NOT NULL
  );

  -- Columns, not a JSON body: TerminalLineSchema is exactly {stream, chunk, ts},
  -- and every read filters on ts/stream/substring. Storing the row twice to
  -- avoid a three-field rebuild would be the expensive way round.
  --
  -- No foreign key to the terminal table. Lines are appended by logId from the
  -- shell's write-behind flush, which can outlive (or briefly precede) the row;
  -- a constraint here would turn a harmless ordering into a lost transcript.
  -- Roster row and transcript are dropped together in one transaction instead —
  -- see deleteTerminalRecord, which used to do it as two file operations with a
  -- crash window between them that left an orphan JSONL nobody would ever read.
  CREATE TABLE terminal_line (
    seq    INTEGER PRIMARY KEY,
    log_id TEXT NOT NULL,
    ts     INTEGER NOT NULL,
    stream TEXT NOT NULL,
    chunk  TEXT NOT NULL
  );
  CREATE INDEX terminal_line_log ON terminal_line(log_id, seq);

  CREATE TABLE pr (
    seq  INTEGER PRIMARY KEY,
    key  TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL
  );

  -- The 2.4 MB read-modify-write, retired. 6177 checkpoints in one JSON map,
  -- rewritten whole to add one entry per turn.
  CREATE TABLE checkpoint (
    seq        INTEGER PRIMARY KEY,
    chat_id    TEXT NOT NULL,
    message_id TEXT NOT NULL,
    body       TEXT NOT NULL,
    UNIQUE (chat_id, message_id)
  );
  CREATE INDEX checkpoint_chat ON checkpoint(chat_id, seq);
  `,
];

/** Schema version a database must be at for this build to use it. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * A state database handle: lazily opened, statement-cached, transaction-aware.
 *
 * Lazy because `new Store(dir)` is synchronous and ~40 tests construct one for a
 * temp dir they may never write to; creating a WAL database (three files) per
 * construction would be pure waste. The handle opens on first real use.
 */
export class StateDb {
  readonly file: string;
  private db: DatabaseSync | null = null;
  private readonly stmts = new Map<string, StatementSync>();
  private txDepth = 0;

  constructor(private readonly dataDir: string) {
    this.file = stateDbPath(dataDir);
  }

  /** Whether the handle is open. Used by tests and by `close()`'s idempotence. */
  get isOpen(): boolean {
    return this.db !== null;
  }

  /** Open (if needed), apply pragmas, bring the schema up to date. Idempotent. */
  open(): DatabaseSync {
    if (this.db) return this.db;
    mkdirSync(this.dataDir, { recursive: true });
    const db = new DatabaseSync(this.file);
    // WAL is the whole reason two processes can now share a state root at all:
    // a reader gets a consistent snapshot instead of whatever half-written bytes
    // the other instance's rewrite happened to leave. InspectService opens the
    // INSTALLED instance's store from dev (services/container.ts, `makeStore`)
    // and used to read JSON files mid-rename to do it.
    db.exec("PRAGMA journal_mode = WAL");
    // NORMAL, not FULL: a WAL checkpoint still fsyncs, so the loss window is the
    // last commits before an OS-level crash — not a process crash. Paying an
    // fsync per checkpoint/terminal-line write to narrow that is the wrong trade
    // for a local dev tool that writes thousands of rows a minute.
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    // Cross-PROCESS contention is real here (dev, stable, and the migration
    // script can all hold the same file). Without this a writer that finds the
    // lock held fails instantly with SQLITE_BUSY instead of waiting the ~ms it
    // takes the other side to commit.
    db.exec("PRAGMA busy_timeout = 5000");
    this.db = db;
    try {
      this.migrate(db);
    } catch (err) {
      // A half-migrated handle must not be left behind for the next caller to
      // find "already open" and use at the wrong schema version.
      this.close();
      throw err;
    }
    return db;
  }

  /**
   * Apply pending schema steps. `user_version` counts the steps already run, so
   * an existing database only pays for what's new.
   */
  private migrate(db: DatabaseSync): void {
    const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
    const at = Number(row.user_version ?? 0);
    if (at > MIGRATIONS.length) {
      throw new Error(
        `${this.file} is at schema version ${at}, but this build only knows ${MIGRATIONS.length}.\n` +
          `  It was written by a NEWER Dispatch. Update this checkout rather than downgrading the data.`,
      );
    }
    for (let v = at; v < MIGRATIONS.length; v++) {
      // Each step is one transaction: an interrupted upgrade leaves the database
      // at the last version that fully landed, never half-way through one.
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(MIGRATIONS[v]!);
        // Interpolated, not bound: PRAGMA does not accept parameters. `v` is a
        // loop counter over a literal array, never user input.
        db.exec(`PRAGMA user_version = ${v + 1}`);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  /** A cached prepared statement. Re-preparing per call is the dominant cost. */
  prepare(sql: string): StatementSync {
    const hit = this.stmts.get(sql);
    if (hit) return hit;
    const stmt = this.open().prepare(sql);
    this.stmts.set(sql, stmt);
    return stmt;
  }

  exec(sql: string): void {
    this.open().exec(sql);
  }

  /**
   * Run `fn` inside a write transaction, nesting-safe.
   *
   * IMMEDIATE rather than the default deferred: a transaction that starts as a
   * reader and only later wants the write lock can deadlock against another
   * process doing the same, and SQLite resolves that by failing one of them with
   * SQLITE_BUSY that no busy_timeout will clear.
   *
   * `fn` must be SYNCHRONOUS. That's not a limitation to work around — it's what
   * makes read-modify-write callers (upsertPrRecord, syncWorktreeRecords) atomic
   * against other in-process callers with no mutex at all: there is no await
   * point for anyone else's turn to interleave at.
   */
  tx<T>(fn: () => T): T {
    const db = this.open();
    if (this.txDepth > 0) {
      // Already inside one. Joining it (rather than nesting a SAVEPOINT) keeps
      // the whole thing one atomic unit, which is what every caller here wants.
      this.txDepth++;
      try {
        return fn();
      } finally {
        this.txDepth--;
      }
    }
    db.exec("BEGIN IMMEDIATE");
    this.txDepth = 1;
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // A failed ROLLBACK means the transaction is already gone (SQLite rolled
        // it back itself on a fatal error). Reporting THAT would bury the real
        // error the caller needs to see.
      }
      throw err;
    } finally {
      this.txDepth = 0;
    }
  }

  /**
   * Close the handle. Idempotent, and NOT terminal — the next call reopens.
   *
   * Load-bearing on Windows, where `rm(dir, { recursive: true })` fails EPERM
   * while any file under it is open: SQLite opens without FILE_SHARE_DELETE, so
   * an unclosed handle turns every store test's teardown into a failure, and the
   * installed app's `data/` into a directory the updater can't move aside.
   *
   * Reopening rather than throwing afterwards is deliberate. Shutdown is racy by
   * nature — a fire-and-forget `patchChat` can land after `dispose()` — and a
   * store that throws "closed" would turn those stragglers into unhandled
   * rejections that kill the process on the way out. Reopening costs one file
   * handle nobody will use again; the alternative costs a clean exit.
   */
  close(): void {
    if (!this.db) return;
    // Statements hold references into the connection; dropping them first keeps
    // close() from failing on a still-live statement.
    this.stmts.clear();
    try {
      this.db.close();
    } finally {
      this.db = null;
      this.txDepth = 0;
    }
  }
}

/* ------------------------------------------------------- the legacy tree */

/**
 * The JSON/JSONL state the SQLite tables replaced.
 *
 * MIRROR: `LEGACY_STATE_ENTRIES` in tools/app/paths.mjs, which the migration
 * script reads. Two lists because one is TypeScript the server bundles and the
 * other is a standalone `.mjs` tool — the same reason `paths.mjs` already
 * mirrors `launch.py`. Keep them in step; both are intentionally tiny.
 */
export const LEGACY_STATE_ENTRIES = [
  "runners.json",
  "mcp-ports.json",
  "worktrees.json",
  "terminals.json",
  "terminals",
  "prs.json",
  "checkpoints.json",
] as const;

/**
 * Legacy state files still present in `dataDir` — the signal that a store has
 * data the database doesn't.
 *
 * Deliberately NOT wired to an auto-migration. A 73-second silent pause during
 * boot, on data nobody has a second copy of, is the wrong way to learn that
 * something ran: the caller ({@link assertStateMigrated}) refuses to start and
 * names the script instead.
 */
export function findLegacyState(dataDir: string): string[] {
  return LEGACY_STATE_ENTRIES.filter((name) => existsSync(join(dataDir, name)));
}

/**
 * Refuse to start on a state root that still holds un-migrated JSON.
 *
 * Only when the database is ABSENT. Once `state.db` exists the migration has run
 * (or there was nothing to run), and the JSONL tree deliberately stays on disk
 * as the rollback path — see the `--prune` flag on the script. Complaining about
 * it then would make the documented rollback path unbootable.
 */
export function assertStateMigrated(dataDir: string): void {
  if (existsSync(stateDbPath(dataDir))) return;
  const legacy = findLegacyState(dataDir);
  if (legacy.length === 0) return; // fresh install, or already pruned
  throw new Error(
    `This state root predates the SQLite store and has not been migrated:\n` +
      `  ${dataDir}\n` +
      `  found: ${legacy.join(", ")}\n\n` +
      `Migrate it (the source is COPIED, never modified):\n` +
      `  pnpm app:migrate-store -- --source "${dataDir}" --dry-run\n` +
      `  pnpm app:migrate-store -- --source "${dataDir}"\n`,
  );
}
