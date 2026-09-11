import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  FAILED_PAYLOAD_MAX_AGE_MS,
  failedAtFromName,
  pruneFailedPayloads,
} from "./failed-retention.mjs";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-09-11T12:00:00.000Z");

/** A failed payload named the way upgrade.mjs names one, `days` before NOW. */
function payload(dir, sha, daysAgo) {
  const at = new Date(NOW - daysAgo * DAY).toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `app-${sha}-${at}`);
  mkdirSync(join(path, "node_modules"), { recursive: true });
  writeFileSync(join(path, "package.json"), "{}");
  return path;
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "cm-failed-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("reads the failure time out of upgrade.mjs's payload name", () => {
  assert.equal(
    failedAtFromName("app-0123456789ab-2026-08-09T14-03-11-220Z"),
    Date.parse("2026-08-09T14:03:11.220Z"),
  );
  assert.equal(failedAtFromName("app-incomplete-2026-08-08T01-02-03-004Z"), Date.parse("2026-08-08T01:02:03.004Z"));
  assert.equal(failedAtFromName("hand-moved"), null);
});

test("keeps only the newest payload while it is younger than the window", () => {
  withDir((dir) => {
    const old1 = payload(dir, "aaaaaaaaaaaa", 33);
    const old2 = payload(dir, "bbbbbbbbbbbb", 20);
    const newest = payload(dir, "cccccccccccc", 3);
    const removed = pruneFailedPayloads(dir, { now: NOW });
    assert.deepEqual(removed.sort(), [old1, old2].sort());
    assert.ok(existsSync(newest));
    assert.ok(!existsSync(old1) && !existsSync(old2));
  });
});

test("deletes the newest too once it is past the window", () => {
  withDir((dir) => {
    const newest = payload(dir, "cccccccccccc", FAILED_PAYLOAD_MAX_AGE_MS / DAY + 1);
    assert.deepEqual(pruneFailedPayloads(dir, { now: NOW }), [newest]);
    assert.ok(!existsSync(newest));
  });
});

test("keeps the newest just inside the window", () => {
  withDir((dir) => {
    const newest = payload(dir, "cccccccccccc", FAILED_PAYLOAD_MAX_AGE_MS / DAY - 1);
    assert.deepEqual(pruneFailedPayloads(dir, { now: NOW }), []);
    assert.ok(existsSync(newest));
  });
});

test("a missing failed/ is nothing to do, not an error", () => {
  assert.deepEqual(pruneFailedPayloads(join(tmpdir(), "cm-failed-does-not-exist")), []);
});

test("leaves stray files alone — only payload directories are pruned", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "notes.txt"), "why it failed");
    payload(dir, "aaaaaaaaaaaa", 40);
    pruneFailedPayloads(dir, { now: NOW });
    assert.ok(existsSync(join(dir, "notes.txt")));
  });
});
