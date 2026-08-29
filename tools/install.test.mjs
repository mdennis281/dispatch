import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  compareStamps,
  desktopRoot,
  parseArgs,
  pruneBackups,
  renameWithRetry,
  resolveRelease,
} from "./install.mjs";

/** A release as the GitHub API returns it, with the two assets the installer requires. */
function release(tag, extra = {}) {
  return {
    tag_name: tag,
    assets: [{ name: `dispatch-${tag}.tar.gz` }, { name: "SHA256SUMS" }],
    ...extra,
  };
}

/**
 * Stub `fetch` for one call and record the URLs asked for.
 *
 * `resolveRelease` reaches GitHub through the module-level `fetchOk`, so there
 * is nothing to inject; replacing the global is the seam. Restored in a finally
 * so one failing assertion cannot leave the rest of the file offline.
 */
async function withFetch(routes, fn) {
  const original = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    for (const [fragment, body] of Object.entries(routes)) {
      if (String(url).includes(fragment)) {
        return { ok: true, status: 200, json: async () => body };
      }
    }
    return { ok: false, status: 404, text: async () => "no route" };
  };
  try {
    return await fn(asked);
  } finally {
    globalThis.fetch = original;
  }
}

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

test("--channel defaults to stable and rejects anything but the two channels", () => {
  assert.equal(parseArgs([]).channel, "stable");
  assert.equal(parseArgs(["--channel", "unstable"]).channel, "unstable");
  assert.throws(() => parseArgs(["--channel", "nightly"]), /--channel must be stable or unstable/);
});

test("the browser opens by default, and DISPATCH_INSTALL_NO_OPEN suppresses it like --no-open", () => {
  assert.equal(parseArgs([]).open, true);
  assert.equal(parseArgs(["--no-open"]).open, false);

  const previous = process.env.DISPATCH_INSTALL_NO_OPEN;
  process.env.DISPATCH_INSTALL_NO_OPEN = "1";
  try {
    // The env var is how a self-update asks for silence: unlike a flag, an
    // installer from an older release ignores it instead of failing the update.
    assert.equal(parseArgs([]).open, false);
  } finally {
    if (previous === undefined) delete process.env.DISPATCH_INSTALL_NO_OPEN;
    else process.env.DISPATCH_INSTALL_NO_OPEN = previous;
  }
});

test("compareStamps orders build stamps and refuses to order anything else", () => {
  assert.equal(compareStamps("v2026.08.14.81160", "v2026.08.14.85068"), -1);
  assert.equal(compareStamps("2026.08.16.63367", "v2026.08.15.10000"), 1);
  assert.equal(compareStamps("v2026.08.14.81160", "2026.08.14.81160"), 0);
  // The whole point of the zero padding: a naive string compare gets this wrong.
  assert.equal(compareStamps("v2026.08.14.09999", "v2026.08.14.10000"), -1);
  assert.equal(compareStamps("v0.1.0", "v2026.08.14.81160"), null);
});

test("the stable channel resolves releases/latest and refuses a prerelease there", async () => {
  await withFetch({ "/releases/latest": release("v2026.08.14.85068") }, async (asked) => {
    const { release: picked } = await resolveRelease("o/r", undefined, "stable");
    assert.equal(picked.tag_name, "v2026.08.14.85068");
    assert.match(asked[0], /\/releases\/latest$/);
  });

  await withFetch(
    { "/releases/latest": release("v2026.08.14.85068", { prerelease: true }) },
    async () => {
      await assert.rejects(
        resolveRelease("o/r", undefined, "stable"),
        /refusing prerelease .* on the stable channel/,
      );
    },
  );
});

test("the unstable channel takes the highest build stamp, not the first listed", async () => {
  const page = [
    release("v2026.08.14.79778"),
    release("v2026.08.16.63367", { prerelease: true }),
    release("v2026.08.15.10000", { prerelease: true }),
  ];
  await withFetch({ "/releases?per_page=": page }, async (asked) => {
    const { release: picked } = await resolveRelease("o/r", undefined, "unstable");
    assert.equal(picked.tag_name, "v2026.08.16.63367");
    assert.match(asked[0], /\/releases\?per_page=\d+$/);
  });
});

test("an unstable resolve skips drafts and unorderable tags", async () => {
  const page = [
    release("v9.9.9", { prerelease: true }),
    release("v2026.08.17.00001", { prerelease: true, draft: true }),
    release("v2026.08.15.10000", { prerelease: true }),
  ];
  await withFetch({ "/releases?per_page=": page }, async () => {
    const { release: picked } = await resolveRelease("o/r", undefined, "unstable");
    assert.equal(picked.tag_name, "v2026.08.15.10000");
  });
});

test("an explicitly named tag may be a prerelease — that is how the app updates", async () => {
  // The in-app updater always passes `--version <tag>`, and on unstable that tag
  // is always a prerelease. Refusing it here would break the whole channel.
  const tagged = release("v2026.08.16.63367", { prerelease: true });
  await withFetch({ "/releases/tags/": tagged }, async (asked) => {
    const { release: picked } = await resolveRelease("o/r", "v2026.08.16.63367", "stable");
    assert.equal(picked.tag_name, "v2026.08.16.63367");
    assert.match(asked[0], /\/releases\/tags\/v2026\.08\.16\.63367$/);
  });
});

test("a draft is refused however it was reached", async () => {
  const drafted = release("v2026.08.16.63367", { draft: true });
  await withFetch({ "/releases/tags/": drafted }, async () => {
    await assert.rejects(
      resolveRelease("o/r", "v2026.08.16.63367", "unstable"),
      /refusing draft/,
    );
  });
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

test("the installer runs when it is invoked through a symlinked temp directory", () => {
  // The macOS bootstrap failure: `install.sh` stages the installer under
  // `$TMPDIR` (`/var/folders/…`), `/var` is a symlink to `/private/var`, and the
  // entry-point guard compared the typed `process.argv[1]` against the
  // realpath-resolved `import.meta.url`. It never matched, so `main()` never
  // ran and `curl … | sh` installed nothing while exiting 0. Reproduced here
  // with a symlinked directory — a junction on Windows, which needs no
  // elevation — and `--help`, the one path that returns before any network.
  const scratch = mkdtempSync(join(tmpdir(), "dispatch-entrypoint-"));
  try {
    const real = join(scratch, "real");
    mkdirSync(real);
    copyFileSync(new URL("./install.mjs", import.meta.url), join(real, "install.mjs"));
    const link = join(scratch, "link");
    symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");

    const result = spawnSync(process.execPath, [join(link, "install.mjs"), "--help"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: node install\.mjs/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

/** An install root with `backups/<name>/payload` for each name given. */
function rootWithBackups(...names) {
  const root = mkdtempSync(join(tmpdir(), "dispatch-backups-"));
  for (const name of names) {
    mkdirSync(join(root, "backups", name, "packages"), { recursive: true });
    writeFileSync(join(root, "backups", name, "packages", "payload"), name);
  }
  return root;
}

/** The `backups/` entries left behind, sorted for a stable comparison. */
function remaining(root) {
  return readdirSync(join(root, "backups")).sort();
}

test("pruneBackups keeps the newest payload and deletes the ones behind it", () => {
  // The 22 GB: `app/` is renamed into `backups/` on every update and nothing
  // deleted the previous ones, so a daily-updated install accumulated 63
  // payloads against 1.2 GB of actual chat history.
  const root = rootWithBackups(
    "app-v2026.08.13.77999-1786661069930",
    "app-v2026.08.20.77894-1787262331961",
    "app-v2026.08.27.54499-1787844289035",
  );
  try {
    const result = pruneBackups(root);
    assert.deepEqual(remaining(root), ["app-v2026.08.27.54499-1787844289035"]);
    assert.equal(result.removed.length, 2);
    assert.deepEqual(result.failed, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneBackups keeps a protected payload without keeping an extra one", () => {
  // `current.json` records exactly one `previous`, so the rollback target must
  // survive — and protecting it must not leave TWO payloads behind, which would
  // halve the reclaim on every update and quietly restore the original bug.
  const target = "app-v2026.08.20.77894-1787262331961";
  const root = rootWithBackups(
    "app-v2026.08.13.77999-1786661069930",
    target,
    "app-v2026.08.27.54499-1787844289035",
  );
  try {
    pruneBackups(root, { protect: [join(root, "backups", target)] });
    assert.deepEqual(remaining(root), [target]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneBackups orders by the trailing epoch, not by the name", () => {
  // The tag sits in the middle and its length varies, so whole-name lexical
  // order puts `…08.9.…` after `…08.10.…` and would delete the NEWEST payload —
  // the one thing a rollback needs.
  // The two orders must genuinely DISAGREE here or the test proves nothing:
  // the newest payload (epoch …8442…) is the lexically SMALLER name, because
  // "10" sorts below "9". Sorting by name keeps `…9.1…` and deletes the very
  // payload a rollback needs.
  const root = rootWithBackups(
    "app-v2026.08.10.1-1787844289035",
    "app-v2026.08.9.1-1787262331961",
  );
  try {
    pruneBackups(root);
    assert.deepEqual(remaining(root), ["app-v2026.08.10.1-1787844289035"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneBackups sweeps failed payloads alongside the superseded ones", () => {
  // A failed swap parks the new payload as `backups/failed-<tag>-<ts>`. It is
  // the same several hundred megabytes and nothing else ever reads it.
  const root = rootWithBackups(
    "failed-v2026.08.20.10897-1787320854909",
    "app-v2026.08.27.54499-1787844289035",
  );
  try {
    pruneBackups(root);
    assert.deepEqual(remaining(root), ["app-v2026.08.27.54499-1787844289035"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneBackups leaves directories it cannot positively identify", () => {
  // This deletes hundreds of megabytes at a time. Anything not matching the
  // shape the swap writes — a human's copy, a half-finished restore — is not
  // ours to remove, however old it looks.
  const root = rootWithBackups(
    "app-v2026.08.13.77999-1786661069930",
    "app-v2026.08.27.54499-1787844289035",
    "my-notes",
    "app-without-a-stamp",
  );
  try {
    pruneBackups(root);
    assert.deepEqual(remaining(root), [
      "app-v2026.08.27.54499-1787844289035",
      "app-without-a-stamp",
      "my-notes",
    ].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneBackups is a no-op on a first install, which has no backups dir", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-backups-"));
  try {
    assert.deepEqual(pruneBackups(root), { removed: [], failed: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneBackups honours a wider keep, for a caller that wants more history", () => {
  const root = rootWithBackups(
    "app-v2026.08.13.77999-1786661069930",
    "app-v2026.08.20.77894-1787262331961",
    "app-v2026.08.27.54499-1787844289035",
  );
  try {
    pruneBackups(root, { keep: 2 });
    assert.deepEqual(remaining(root), [
      "app-v2026.08.20.77894-1787262331961",
      "app-v2026.08.27.54499-1787844289035",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
