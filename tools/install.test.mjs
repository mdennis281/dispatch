import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { desktopRoot, renameWithRetry } from "./install.mjs";

test("relative targets keep the bootstrap caller's working directory", () => {
  const before = process.env.DISPATCH_INSTALL_CWD;
  const caller = join(tmpdir(), "dispatch-installer-caller");
  try {
    process.env.DISPATCH_INSTALL_CWD = caller;
    assert.equal(desktopRoot("relative-target"), resolve(caller, "relative-target"));
  } finally {
    if (before === undefined) delete process.env.DISPATCH_INSTALL_CWD;
    else process.env.DISPATCH_INSTALL_CWD = before;
  }
});

test("the installed supervisor enables LAN host mode while keeping its local probe URL", async () => {
  // build-payload.mjs copies this launcher into every staging payload, and the
  // upgrader deliberately drives the freshly-swapped payload's copy.
  const launcher = await readFile(new URL("./app/launch.py", import.meta.url), "utf8");
  assert.match(launcher, /"DISPATCH_HOST": "0\.0\.0\.0"/);
  assert.match(launcher, /url = f"http:\/\/127\.0\.0\.1:\{port\}"/);
});

test("renameWithRetry waits out transient Windows file locks", async () => {
  let calls = 0;
  const waits = [];
  await renameWithRetry("app", "backup", {
    attempts: 4,
    delayMs: 25,
    rename() {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("locked"), { code: "EPERM" });
    },
    wait(ms) {
      waits.push(ms);
    },
  });

  assert.equal(calls, 3);
  assert.deepEqual(waits, [25, 25]);
});

test("renameWithRetry does not hide non-locking filesystem errors", async () => {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  await assert.rejects(
    renameWithRetry("app", "backup", {
      attempts: 4,
      rename() {
        throw missing;
      },
    }),
    (error) => error === missing,
  );
});

test("renameWithRetry gives an actionable error after a persistent lock", async () => {
  await assert.rejects(
    renameWithRetry("app", "backup", {
      attempts: 2,
      delayMs: 0,
      rename() {
        throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
      },
      wait() {},
    }),
    /Close terminals whose current directory is inside app/,
  );
});

test(
  "the Windows package-manager shim avoids Node's deprecated shell argv path",
  { skip: process.platform !== "win32" },
  () => {
    const installerUrl = new URL("./install.mjs", import.meta.url).href;
    const script = `import { run } from ${JSON.stringify(installerUrl)}; run("pnpm", ["--version"], { quiet: true });`;
    const result = spawnSync(
      process.execPath,
      ["--trace-deprecation", "--input-type=module", "--eval", script],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stderr, /DEP0190/);
  },
);
