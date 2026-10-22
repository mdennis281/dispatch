import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  isStaleShortcut,
  main,
  parseArgs,
  payloadKind,
  resolveRoots,
  rewriteRootPaths,
} from "./migrate-home.mjs";
import { desktopRoot } from "./paths.mjs";

let local;
beforeEach(() => {
  local = mkdtempSync(join(tmpdir(), "migrate-home-"));
});
afterEach(() => {
  rmSync(local, { recursive: true, force: true });
});

/** A pre-rename release install, small enough to build per test. */
function seedLegacyInstall() {
  const old = join(local, "claude-manager");
  for (const dir of ["app/tools/app", "data/chats/c1", "config", "backups/app-v1-1", "staging", "failed/x"]) {
    mkdirSync(join(old, dir), { recursive: true });
  }
  writeFileSync(join(old, "data/chats/c1/messages.jsonl"), `{"cwd":"C:\\\\repo"}\n`);
  writeFileSync(join(old, "backups/app-v1-1/blob"), Buffer.alloc(4096));
  writeFileSync(
    join(old, "current.json"),
    JSON.stringify({
      tag: "v2026.10.22.1",
      sha: "abc",
      autostart: true,
      source: "https://github.com/mdennis281/dispatch/releases/tag/v2026.10.22.1",
      previous: join(old, "backups", "app-v1-1"),
    }),
  );
  writeFileSync(join(old, "update.json"), JSON.stringify({ phase: "launched", tag: "v2026.10.22.1" }));
  return old;
}

/** Every file under `dir`, relative — the "nothing changed" oracle. */
function snapshot(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else out.push(`${r}:${readFileSync(join(d, e.name), "utf8").length}`);
    }
  };
  walk(dir, "");
  return out.sort();
}

test("desktopRoot prefers dispatch, falls back to an existing claude-manager, else dispatch", () => {
  const env = { LOCALAPPDATA: local };
  assert.equal(desktopRoot(env), join(local, "dispatch"), "neither exists: the new name");
  mkdirSync(join(local, "claude-manager"));
  assert.equal(desktopRoot(env), join(local, "claude-manager"), "only the old one exists");
  mkdirSync(join(local, "dispatch"));
  assert.equal(desktopRoot(env), join(local, "dispatch"), "both exist: the new one wins");
  assert.equal(desktopRoot({ ...env, DISPATCH_HOME: join(local, "x") }), join(local, "x"));
  assert.equal(desktopRoot({ ...env, CM_HOME: join(local, "x") }), join(local, "dispatch"), "CM_HOME is gone");
});

test("resolveRoots defaults to the two names under the local data dir", () => {
  assert.deepEqual(resolveRoots(parseArgs([]), { LOCALAPPDATA: local }), {
    from: join(local, "claude-manager"),
    to: join(local, "dispatch"),
  });
  assert.deepEqual(parseArgs(["--", "--dry-run", "--no-start"]), { dryRun: true, start: false });
  assert.throws(() => parseArgs(["--to"]), /requires a value/);
});

test("rewriteRootPaths rewrites only paths under the old root", () => {
  const from = join(local, "claude-manager");
  const to = join(local, "dispatch");
  const { value, changed } = rewriteRootPaths(
    {
      appDir: join(from, "app"),
      nested: { list: [from, `${from}-old`, "https://github.com/x/claude-manager"] },
      port: 4318,
    },
    from,
    to,
  );
  assert.equal(value.appDir, join(to, "app"));
  assert.deepEqual(value.nested.list, [to, `${from}-old`, "https://github.com/x/claude-manager"]);
  assert.deepEqual(changed, ["appDir", "nested.list[0]"]);
});

test("payloadKind tells a release install from a checkout build", () => {
  const old = seedLegacyInstall();
  assert.deepEqual(payloadKind(old), {
    kind: "release",
    tag: "v2026.10.22.1",
    repo: "mdennis281/dispatch",
    autostart: true,
  });
  assert.equal(payloadKind(old, "v9").tag, "v9");
  mkdirSync(join(old, "app", ".git"));
  assert.deepEqual(payloadKind(old), { kind: "checkout", sha: "abc", autostart: true });
});

test("--dry-run narrates the whole plan and changes nothing", async () => {
  const old = seedLegacyInstall();
  const before = snapshot(old);
  const lines = [];
  const code = await main(["--dry-run", "--no-start"], {
    env: { LOCALAPPDATA: local },
    log: (l) => lines.push(l),
  });
  const out = lines.join("\n");
  assert.equal(code, 0, out);
  assert.deepEqual(snapshot(old), before);
  assert.equal(existsSync(join(local, "dispatch")), false);
  for (const step of [1, 2, 3, 4, 5, 6]) assert.match(out, new RegExp(`\\[${step}/6\\]`));
  assert.match(out, /rename .*claude-manager/);
  assert.match(out, /current\.json: rewrite previous/);
  assert.match(out, /install\.mjs --version v2026\.10\.22\.1 --repo mdennis281\/dispatch --target .*dispatch/);
  assert.match(out, /delete .*backups .*4\.0 KB/);
  assert.match(out, /Dry run complete/);
});

test("refuses, changing nothing, when the old root is missing or the new one is in use", async () => {
  const quiet = { env: { LOCALAPPDATA: local }, log: () => {} };
  assert.equal(await main([], quiet), 1, "no old install");
  const old = seedLegacyInstall();
  mkdirSync(join(local, "dispatch"));
  writeFileSync(join(local, "dispatch", "something"), "x");
  const before = snapshot(old);
  assert.equal(await main([], quiet), 1, "non-empty target");
  assert.deepEqual(snapshot(old), before);
});

test("isStaleShortcut matches the old root and the dead Electron shell, not the new install", () => {
  const from = "C:\\Users\\a\\AppData\\Local\\claude-manager";
  const lnk = (name, target, args = "") => ({ name, target, args, workdir: "" });
  assert.ok(isStaleShortcut(lnk("Dispatch.lnk", "pythonw.exe", `${from}\\app\\tools\\app\\launch.py --target ${from}`), from));
  assert.ok(isStaleShortcut(lnk("claude-manager.lnk", `${from}\\shell\\claude-manager.exe`), from));
  assert.ok(!isStaleShortcut(lnk("Dispatch.lnk", "pythonw.exe", "C:\\Users\\a\\AppData\\Local\\dispatch\\app\\tools\\app\\launch.py"), from));
  assert.ok(!isStaleShortcut(lnk("Dispatch.lnk", "chrome_proxy.exe", "--app-id=abc"), from));
});

test("a failed rebuild puts app/ and the state files back, so renaming the root back is a full undo", async () => {
  const old = seedLegacyInstall();
  // A checkout build whose sha this repo does not have: publish.mjs fails fast, offline.
  mkdirSync(join(old, "app", ".git"));
  const stamp = JSON.parse(readFileSync(join(old, "current.json"), "utf8"));
  writeFileSync(join(old, "current.json"), JSON.stringify({ ...stamp, sha: "0".repeat(40) }));
  const before = readFileSync(join(old, "current.json"), "utf8");
  const lines = [];
  const code = await main(["--no-start"], { env: { LOCALAPPDATA: local }, log: (l) => lines.push(l) });
  const out = lines.join("\n");
  const moved = join(local, "dispatch");
  assert.equal(code, 1, out);
  assert.match(out, /FAILED at step 3/);
  assert.match(out, /To roll back/);
  assert.equal(existsSync(join(moved, "app", ".git")), true, "the original app/ is back");
  assert.equal(existsSync(join(moved, "app.pre-migrate")), false);
  assert.equal(readFileSync(join(moved, "current.json"), "utf8"), before, "current.json is restored verbatim");
  assert.equal(existsSync(join(moved, "backups", "app-v1-1", "blob")), true, "nothing was deleted");
});
