import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  compareStamps,
  desktopRoot,
  parseArgs,
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
