#!/usr/bin/env node
/**
 * Migrate a state root's JSON/JSONL maps into its SQLite database (`state.db`).
 *
 * Safety is the whole point of this script, so it is deliberately paranoid — the
 * same posture as `migrate-data.mjs`, for the same reason:
 *   - COPIES. The source JSON is never modified, moved or deleted. If anything
 *     here is wrong you still have the original, and the server still boots off
 *     it once you delete `state.db`. Removing the old tree is a SEPARATE,
 *     opt-in `--prune` that only runs after a verified pass.
 *   - VERIFIES every migrated record by reading it back OUT of the database and
 *     comparing bytes, then hashes both sides. Exits non-zero on any mismatch.
 *   - REFUSES a database that already holds rows this run didn't put there,
 *     unless `--force` — so pointing it at a live store can't quietly double up.
 *   - RESUMES. Each unit is one transaction plus a `_migration` row, so an
 *     interrupted run picks up where it stopped instead of starting over.
 *   - Entries it doesn't recognise are REPORTED, never silently skipped.
 *
 * WHAT IT DOES NOT TOUCH. `chats/` stays exactly where it is — transcripts are
 * still JSONL and assets are still files on purpose (see the Store docblock).
 * `auth-sessions.json` belongs to AuthService and is still a file.
 *
 * WHY NO ZOD HERE. Records are copied VERBATIM: the bytes read out of the JSON
 * go into the row unchanged, which is what makes the byte-for-byte verify below
 * meaningful. Validation stays where it has always been — on the Store's read
 * path — so a legacy record that no longer parses surfaces there, loudly, with
 * the original file still on disk to fix it from.
 *
 * Usage:
 *   node tools/app/migrate-store.mjs [--source <stateRoot>] [--target <stateRoot>]
 *                                    [--dry-run] [--force] [--prune] [--quiet]
 *
 *   --source  state root holding the legacy JSON. Default: this checkout's `.data`.
 *             The installed instance's is `%LOCALAPPDATA%\claude-manager\data`.
 *   --target  state root to write `state.db` into. Default: the same as --source
 *             (migrating in place). Point it elsewhere to rehearse against a copy.
 */
import { readdir, readFile, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LEGACY_STATE_ENTRIES } from "./paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

/* ------------------------------------------------------------------ args */

/**
 * A flag that takes a value must actually get one — the same guard
 * `backsync.mjs` carries, and for the same reason: `--source` with nothing after
 * it used to fall through to the default and migrate a store you never named.
 */
function need(value, flag) {
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

function parseArgs(argv) {
  const args = { dryRun: false, force: false, prune: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // `pnpm run app:migrate-store -- --dry-run` forwards the separator itself.
    if (a === "--") continue;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--force") args.force = true;
    else if (a === "--prune") args.prune = true;
    else if (a === "--quiet") args.quiet = true;
    else if (a === "--source") args.source = need(argv[++i], a);
    else if (a === "--target") args.target = need(argv[++i], a);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (args.prune && args.dryRun) {
    // --prune deletes; --dry-run promises not to. Rather than pick a winner,
    // refuse: whichever one the user meant, the other was a mistake.
    throw new Error("--prune and --dry-run contradict each other; pass one");
  }
  return args;
}

/* ------------------------------------------------------------------ util */

function human(bytes) {
  const u = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/** Read + parse a JSON file, or `undefined` when it isn't there. */
async function readJson(path) {
  if (!existsSync(path)) return undefined;
  const raw = await readFile(path, "utf8");
  if (raw.trim() === "") return undefined;
  return JSON.parse(raw);
}

/** Parse a JSONL file into rows, tolerating a blank/torn trailing line. */
async function readJsonl(path) {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      out.push(JSON.parse(lines[i]));
    } catch (err) {
      // A malformed FINAL line can be a torn append — the same tolerance
      // `fsq.readJsonl` has. Anything earlier is real corruption and must stop
      // the migration rather than be quietly dropped.
      if (i === lines.length - 1) break;
      throw new Error(`malformed JSONL at ${path}:${i + 1}: ${err.message}`);
    }
  }
  return out;
}

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * Stable digest over an ORDERED list of strings.
 *
 * Length-prefixed rather than joined by a delimiter: any delimiter you pick can
 * in principle occur inside a JSON body, and then two different row lists hash
 * the same by running into each other across the join. A byte count can't.
 */
function digest(parts) {
  const h = createHash("sha256");
  for (const p of parts) h.update(`${Buffer.byteLength(p)}:`).update(p);
  return h.digest("hex");
}

/* ---------------------------------------------------------------- units */

/**
 * One migratable unit: where it reads from, what it writes, and how to read the
 * result back for verification.
 *
 * `rows(dir)` yields `{ params, body }` — `params` are the INSERT's bind values
 * and `body` is the comparison string for that record. For a `body TEXT` table
 * they are the same VERBATIM JSON, which is what makes the verify byte-exact.
 * A table stored as typed columns (terminal_line) supplies a `project()` that
 * rebuilds the same string from the row, so both sides compare identically.
 */
const UNITS = [
  {
    name: "runners",
    file: "runners.json",
    table: "runner",
    async rows(dir) {
      const list = (await readJson(join(dir, "runners.json"))) ?? [];
      return list.map((r) => ({ params: [r.id, JSON.stringify(r)], body: JSON.stringify(r) }));
    },
    insert: "INSERT INTO runner (id, body) VALUES (?, ?)",
    read: "SELECT body FROM runner ORDER BY seq",
  },
  {
    name: "mcp-ports",
    file: "mcp-ports.json",
    table: "mcp_port_lease",
    async rows(dir) {
      const list = (await readJson(join(dir, "mcp-ports.json"))) ?? [];
      return list.map((r) => ({ params: [JSON.stringify(r)], body: JSON.stringify(r) }));
    },
    insert: "INSERT INTO mcp_port_lease (body) VALUES (?)",
    read: "SELECT body FROM mcp_port_lease ORDER BY seq",
  },
  {
    name: "worktrees",
    file: "worktrees.json",
    table: "worktree",
    async rows(dir) {
      const list = (await readJson(join(dir, "worktrees.json"))) ?? [];
      return list.map((r) => ({
        params: [r.path, r.projectId, JSON.stringify(r)],
        body: JSON.stringify(r),
      }));
    },
    insert: "INSERT INTO worktree (path, project_id, body) VALUES (?, ?, ?)",
    read: "SELECT body FROM worktree ORDER BY seq",
  },
  {
    name: "prs",
    file: "prs.json",
    table: "pr",
    async rows(dir) {
      const list = (await readJson(join(dir, "prs.json"))) ?? [];
      return list.map((r) => ({ params: [r.key, JSON.stringify(r)], body: JSON.stringify(r) }));
    },
    insert: "INSERT INTO pr (key, body) VALUES (?, ?)",
    read: "SELECT body FROM pr ORDER BY seq",
  },
  {
    name: "terminals",
    file: "terminals.json",
    table: "terminal",
    async rows(dir) {
      const list = (await readJson(join(dir, "terminals.json"))) ?? [];
      return list.map((r) => ({
        params: [r.id, r.logId, JSON.stringify(r)],
        body: JSON.stringify(r),
      }));
    },
    insert: "INSERT INTO terminal (id, log_id, body) VALUES (?, ?, ?)",
    read: "SELECT body FROM terminal ORDER BY seq",
  },
  {
    name: "checkpoints",
    file: "checkpoints.json",
    table: "checkpoint",
    async rows(dir) {
      // `{ [chatId]: { [messageId]: Checkpoint } }` flattened to rows. Insertion
      // order follows Object.keys, which is the order the old `Object.values()`
      // read handed back — so `getCheckpoints` still sees them in that order.
      const map = (await readJson(join(dir, "checkpoints.json"))) ?? {};
      const out = [];
      for (const [chatId, byMessage] of Object.entries(map)) {
        for (const [messageId, cp] of Object.entries(byMessage ?? {})) {
          out.push({
            params: [chatId, messageId, JSON.stringify(cp)],
            body: JSON.stringify(cp),
          });
        }
      }
      return out;
    },
    insert: "INSERT INTO checkpoint (chat_id, message_id, body) VALUES (?, ?, ?)",
    read: "SELECT body FROM checkpoint ORDER BY seq",
  },
  {
    name: "terminal-logs",
    file: "terminals",
    table: "terminal_line",
    async rows(dir) {
      const logs = join(dir, "terminals");
      if (!existsSync(logs)) return [];
      const files = (await readdir(logs, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => e.name)
        .sort(); // deterministic: the verify below compares ordered lists
      const out = [];
      for (const f of files) {
        const logId = f.slice(0, -".jsonl".length);
        for (const line of await readJsonl(join(logs, f))) {
          out.push({
            params: [logId, line.ts, line.stream, line.chunk],
            // Not a `body` column — these are three typed columns, so the
            // verify compares the same projection on both sides.
            body: JSON.stringify([logId, line.ts, line.stream, line.chunk]),
          });
        }
      }
      return out;
    },
    insert: "INSERT INTO terminal_line (log_id, ts, stream, chunk) VALUES (?, ?, ?, ?)",
    read: "SELECT log_id, ts, stream, chunk FROM terminal_line ORDER BY seq",
    project: (row) => JSON.stringify([row.log_id, row.ts, row.stream, row.chunk]),
  },
];

/**
 * State-root entries this script knows about. Anything else is reported so a
 * file nobody remembered can't be quietly left behind by a `--prune`.
 */
const KNOWN_ENTRIES = new Set([
  ...LEGACY_STATE_ENTRIES,
  "chats",
  "state.db",
  "state.db-wal",
  "state.db-shm",
  "auth-sessions.json",
  "auth-recovery.lock",
]);

/* ------------------------------------------------------------------- db */

/**
 * Open the target database THROUGH THE SERVER'S OWN `StateDb`.
 *
 * Not a second copy of the schema. A migration's CREATE TABLE is the one nobody
 * re-runs, so a drifted duplicate would be discovered months later by a store
 * that reads wrong — importing the compiled module means there is exactly one
 * definition of these tables, one set of pragmas, and one version check.
 *
 * The cost is that the server must be BUILT first. That is already true of the
 * installed payload (built in place) and is step one of RUNNING.md for a
 * checkout, so it is a clear precondition rather than a hidden one.
 */
async function openStateDb(dataDir) {
  const dist = join(repoRoot, "packages/server/dist/store/db.js");
  if (!existsSync(dist)) {
    throw new Error(
      `the server isn't built, so the schema this migration writes doesn't exist yet:\n` +
        `  missing ${dist}\n\n` +
        `  Build it first:  pnpm build`,
    );
  }
  const { StateDb } = await import(pathToFileURL(dist).href);
  const db = new StateDb(dataDir);
  db.open(); // pragmas + schema + version check, identical to a server boot
  return db;
}

function ensureBookkeeping(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migration (
      unit    TEXT PRIMARY KEY,
      rows    INTEGER NOT NULL,
      sha256  TEXT NOT NULL,
      done_at INTEGER NOT NULL
    )
  `);
}

/* ------------------------------------------------------------------- main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = resolve(args.source ?? join(repoRoot, ".data"));
  const target = resolve(args.target ?? source);
  const dbFile = join(target, "state.db");

  console.log(`source : ${source}`);
  console.log(`target : ${dbFile}\n`);

  if (!existsSync(source)) throw new Error(`source state root does not exist: ${source}`);

  // `runtime.json` sits next to the data dir and exists only while the app is up
  // (the supervisor owns it — see paths.mjs). Migrating a LIVE store IN PLACE is
  // the one way to lose data here: the app keeps appending to the JSON, and the
  // database it would then boot from is a snapshot that silently forgot
  // everything written after this run started. Rehearsing into a DIFFERENT root
  // only reads the source, so that stays allowed with a warning about drift.
  const live = existsSync(join(dirname(source), "runtime.json"));
  const inPlace = source === target;
  if (live && inPlace) {
    throw new Error(
      [
        `that instance is RUNNING (${join(dirname(source), "runtime.json")} exists).`,
        `  Migrating its store in place would snapshot a store still being written to,`,
        `  and every row it appends after now would be lost on the next boot.`,
        ``,
        `  Stop it first:   pnpm app:stop`,
        `  Or rehearse:     --target <a scratch dir>   (reads only; writes elsewhere)`,
      ].join("\n"),
    );
  }
  if (live) {
    console.log(
      [
        `note: the source instance is running, so its rows may drift under this read.`,
        `  Fine for a rehearsal; the real migration needs it stopped.`,
        ``,
      ].join("\n"),
    );
  }

  // ---- what's there, and what we don't recognise.
  const entries = await readdir(source, { withFileTypes: true });
  const unknown = entries
    .map((e) => e.name)
    .filter((n) => !KNOWN_ENTRIES.has(n) && !n.endsWith(".tmp"));
  if (unknown.length) {
    console.log("note: entries this script does not migrate (left exactly as they are):");
    for (const n of unknown) console.log(`  - ${n}`);
    console.log("");
  }

  // ---- plan.
  let totalRows = 0;
  let totalBytes = 0;
  const plan = [];
  for (const unit of UNITS) {
    const rows = await unit.rows(source);
    const path = join(source, unit.file);
    const bytes = existsSync(path)
      ? (await stat(path)).isDirectory()
        ? (await Promise.all(
            (await readdir(path)).map((f) => sizeOf(join(path, f))),
          )).reduce((a, b) => a + b, 0)
        : await sizeOf(path)
      : 0;
    totalRows += rows.length;
    totalBytes += bytes;
    plan.push({ unit, rows, bytes });
  }
  for (const p of plan) {
    console.log(`  ${p.unit.name.padEnd(14)} ${String(p.rows.length).padStart(7)} rows  ${human(p.bytes)}`);
  }
  console.log(`\n${totalRows} rows, ${human(totalBytes)} of JSON\n`);

  if (args.dryRun) {
    console.log("--dry-run: nothing written.");
    return;
  }

  await mkdir(target, { recursive: true });
  const db = await openStateDb(target);
  try {
    ensureBookkeeping(db);

    // ---- refuse a destination that already holds somebody else's rows.
    const done = new Map(
      db.prepare("SELECT unit, rows, sha256 FROM _migration").all().map((r) => [r.unit, r]),
    );
    const occupied = [];
    for (const p of plan) {
      if (done.has(p.unit.name)) continue; // ours, from an earlier run — resumable
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${p.unit.table}`).get();
      if (Number(n) > 0) occupied.push(`${p.unit.table} (${n} rows)`);
    }
    if (occupied.length && !args.force) {
      throw new Error(
        `${dbFile} already holds rows this migration did not write:\n` +
          occupied.map((o) => `  ${o}`).join("\n") +
          `\n\n  That is a store the app has already been using. Re-run with --force ONLY if\n` +
          `  you mean to add the JSON on top of it. The source at ${source} is never\n` +
          `  touched either way.`,
      );
    }

    // ---- migrate, one unit per transaction.
    const results = [];
    for (const { unit, rows } of plan) {
      const prev = done.get(unit.name);
      if (prev && !args.force) {
        console.log(`  ${unit.name.padEnd(14)} already migrated (${prev.rows} rows) — skipping`);
        results.push({ unit, rows, skipped: true });
        continue;
      }
      const started = Date.now();
      process.stdout.write(`  ${unit.name.padEnd(14)} ${rows.length} rows ... `);
      const sha = digest(rows.map((r) => r.body));
      // One unit, one transaction, and the `_migration` row lands INSIDE it —
      // so a kill mid-unit rolls the whole unit back and the next run redoes it
      // rather than resuming into a half-copied table.
      try {
        db.tx(() => {
          if (args.force) db.exec(`DELETE FROM ${unit.table}`);
          const ins = db.prepare(unit.insert);
          for (const r of rows) ins.run(...r.params);
          db.prepare(
            "INSERT INTO _migration (unit, rows, sha256, done_at) VALUES (?, ?, ?, ?)" +
              " ON CONFLICT(unit) DO UPDATE SET rows = excluded.rows," +
              " sha256 = excluded.sha256, done_at = excluded.done_at",
          ).run(unit.name, rows.length, sha, Date.now());
        });
      } catch (err) {
        throw new Error(`${unit.name}: ${err.message}`);
      }
      console.log(`done (${Date.now() - started}ms)`);
      results.push({ unit, rows, sha });
    }

    // ---- verify: read every row back OUT and compare to the source, in order.
    console.log("\nverifying (read-back + sha256)...");
    const problems = [];
    for (const { unit, rows } of results) {
      const back = db.prepare(unit.read).all();
      const project = unit.project ?? ((row) => row.body);
      const got = back.map(project);
      const want = rows.map((r) => r.body);
      if (got.length !== want.length) {
        problems.push(`${unit.name}: ${want.length} source rows vs ${got.length} in the database`);
        continue;
      }
      for (let i = 0; i < want.length; i++) {
        if (got[i] !== want[i]) {
          problems.push(`${unit.name}: row ${i} differs\n    source: ${want[i].slice(0, 160)}\n    stored: ${got[i].slice(0, 160)}`);
          break;
        }
      }
      if (digest(got) !== digest(want)) problems.push(`${unit.name}: digest mismatch`);
    }

    if (problems.length) {
      console.error(`\nFAILED — ${problems.length} problem(s):`);
      for (const p of problems.slice(0, 20)) console.error(`  ${p}`);
      if (problems.length > 20) console.error(`  ... and ${problems.length - 20} more`);
      console.error(`\nYour original JSON at ${source} is untouched. Delete ${dbFile} to go back.`);
      process.exitCode = 1;
      return;
    }
    console.log(`OK — ${totalRows} rows verified byte-identical.`);

    // ---- prune: opt-in, and only ever after the verify above passed.
    if (args.prune) {
      if (source !== target) {
        throw new Error(
          `--prune refuses to delete ${source} after migrating into a DIFFERENT root\n` +
            `  (${target}). That combination is a rehearsal, and deleting the original\n` +
            `  would leave the root you actually boot from with no state at all.`,
        );
      }
      console.log("\n--prune: removing the migrated JSON tree...");
      for (const name of LEGACY_STATE_ENTRIES) {
        const path = join(source, name);
        if (!existsSync(path)) continue;
        await rm(path, { recursive: true, force: true });
        if (!args.quiet) console.log(`  removed ${name}`);
      }
    } else if (inPlace) {
      console.log(
        `\nThe JSON tree is left in place at ${source} — it is the rollback path.\n` +
          `  Delete ${dbFile} and the server boots off it again, unchanged.\n` +
          `  Once you're happy: pnpm app:migrate-store -- --source "${source}" --prune`,
      );
    } else {
      console.log(
        `\nRehearsal only: ${source} was read, never written, and still holds every\n` +
          `  record. Nothing boots off ${dbFile} — delete it when you're done looking.`,
      );
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(`\nmigrate-store failed: ${err.message}`);
  process.exitCode = 1;
});
