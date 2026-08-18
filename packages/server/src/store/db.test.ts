import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  StateDb,
  SCHEMA_VERSION,
  STATE_DB_FILENAME,
  assertStateMigrated,
  findLegacyState,
} from "./db.js";

let dir: string;
let db: StateDb;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-db-"));
  db = new StateDb(dir);
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("StateDb", () => {
  it("creates the database lazily — constructing a Store must not write", () => {
    expect(db.isOpen).toBe(false);
    expect(existsSync(join(dir, STATE_DB_FILENAME))).toBe(false);
    db.open();
    expect(existsSync(join(dir, STATE_DB_FILENAME))).toBe(true);
  });

  it("opens in WAL at the current schema version, and open() is idempotent", () => {
    const handle = db.open();
    expect(db.open()).toBe(handle); // no second connection
    const mode = handle.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode).toBe("wal");
    const v = handle.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(Number(v.user_version)).toBe(SCHEMA_VERSION);
  });

  it("has FTS5 compiled in — the whole reason the Node floor is 24", () => {
    // Node 22 ships `node:sqlite` WITHOUT FTS5: everything above passes there and
    // only this throws `no such module: fts5`. Asserting it here is what makes
    // the floor self-enforcing — a CI runner pinned back to 22 fails HERE,
    // loudly, instead of shipping a build whose transcript search silently
    // never indexed anything.
    expect(() =>
      db.exec("CREATE VIRTUAL TABLE probe USING fts5(text, content='', contentless_delete=1)"),
    ).not.toThrow();
  });

  it("refuses a database written by a NEWER build rather than guessing", async () => {
    // Downgrading the DATA is never right: the newer build may have added a
    // column this one would silently write NULLs into.
    const raw = new DatabaseSync(join(dir, STATE_DB_FILENAME));
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    raw.close();
    expect(() => db.open()).toThrow(/written by a NEWER Dispatch/i);
    // And it must not leave the half-checked handle behind for the next caller.
    expect(db.isOpen).toBe(false);
  });

  it("applies only the steps a database has not seen", () => {
    db.open();
    db.prepare("INSERT INTO runner (id, body) VALUES (?, ?)").run("a", "{}");
    db.close();
    // The steps are plain CREATE TABLE, so replaying them over an existing
    // database would throw "table already exists" and take the server down on
    // its SECOND boot. `user_version` is the only thing standing between those.
    const again = new StateDb(dir);
    expect(() => again.open()).not.toThrow();
    expect(again.prepare("SELECT COUNT(*) AS n FROM runner").get()).toMatchObject({ n: 1 });
    again.close();
  });

  it("rolls a failed transaction back whole", () => {
    db.open();
    db.prepare("INSERT INTO runner (id, body) VALUES (?, ?)").run("a", "{}");
    expect(() =>
      db.tx(() => {
        db.prepare("INSERT INTO runner (id, body) VALUES (?, ?)").run("b", "{}");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const rows = db.prepare("SELECT id FROM runner").all() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("joins a nested tx to the outer one, so a late failure undoes all of it", () => {
    db.open();
    expect(() =>
      db.tx(() => {
        db.prepare("INSERT INTO runner (id, body) VALUES (?, ?)").run("outer", "{}");
        db.tx(() => {
          db.prepare("INSERT INTO runner (id, body) VALUES (?, ?)").run("inner", "{}");
        });
        throw new Error("after the inner committed");
      }),
    ).toThrow(/after the inner/);
    // The inner "commit" must NOT have been a real one — a partial write here is
    // exactly the torn state transactions exist to prevent.
    expect(db.prepare("SELECT COUNT(*) AS n FROM runner").get()).toMatchObject({ n: 0 });
  });

  it("reopens after close, because shutdown is racy by design", () => {
    db.open();
    db.prepare("INSERT INTO runner (id, body) VALUES (?, ?)").run("a", "{}");
    db.close();
    expect(db.isOpen).toBe(false);
    db.close(); // idempotent
    expect(db.prepare("SELECT COUNT(*) AS n FROM runner").get()).toMatchObject({ n: 1 });
  });
});

describe("the un-migrated-store guard", () => {
  it("says nothing about a fresh root", () => {
    expect(findLegacyState(dir)).toEqual([]);
    expect(() => assertStateMigrated(dir)).not.toThrow();
  });

  it("refuses legacy JSON with no database, and names the script", async () => {
    await writeFile(join(dir, "checkpoints.json"), "{}");
    await writeFile(join(dir, "prs.json"), "[]");
    expect(findLegacyState(dir).sort()).toEqual(["checkpoints.json", "prs.json"]);
    // Both halves matter: WHAT it found, and the command that fixes it.
    expect(() => assertStateMigrated(dir)).toThrow(/checkpoints\.json/);
    expect(() => assertStateMigrated(dir)).toThrow(/app:migrate-store/);
  });

  it("stays quiet once the database exists — the JSON tree IS the rollback path", async () => {
    await writeFile(join(dir, "checkpoints.json"), "{}");
    db.open();
    // Complaining here would make the documented rollback (delete state.db, boot
    // off the JSON again) impossible to walk back INTO.
    expect(() => assertStateMigrated(dir)).not.toThrow();
  });
});
