/**
 * The update REST surface.
 *
 * The property worth defending here is that `POST /api/update/install` cannot be
 * talked into installing something the server did not itself resolve. It now
 * accepts a tag — that is how the unstable → stable step-back is asked for,
 * since a downgrade is by construction never `available` — but ONLY the head of
 * the subscribed channel, so the trust boundary is unchanged. It also refuses
 * outright on a payload that was not installed from a release. `launchUpdate` is
 * mocked throughout — a test that really spawned it would replace the checkout
 * it is running in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { ReleaseService } from "../services/release.js";

const launchUpdate = vi.hoisted(() => vi.fn(async () => ({ logFile: "", installerSource: "release" as const })));
vi.mock("../services/update-install.js", () => ({ launchUpdate }));

const MANIFEST = {
  version: "2026.08.14.81160",
  tag: "v2026.08.14.81160",
  sha: "cb540e17d2d278b67a90d49ef3c591035ef3d074",
};

let dir: string;
let app: FastifyInstance;
let bus: EventBus;
const roots: string[] = [];

/** A payload dir under the real temp root — never a literal absolute path. */
async function payloadDir(manifest: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cm-update-payload-"));
  roots.push(root);
  const appDir = join(root, "app");
  await mkdir(appDir, { recursive: true });
  if (manifest !== null) {
    await writeFile(join(appDir, "release-manifest.json"), JSON.stringify(manifest), "utf8");
  }
  return appDir;
}

/** Build an app whose ReleaseService sees `manifest` and `latestTag`. */
async function withRelease(manifest: unknown, latestTag: string | null): Promise<ReleaseService> {
  const store = new Store(dir);
  await store.init();
  const release = new ReleaseService({
    bus,
    appDir: await payloadDir(manifest),
    env: {},
    // The same channel wiring `createServices` installs. Built over the real
    // store rather than stubbed, because the property most worth testing here is
    // that the subscription survives a full-replace PUT /api/settings.
    channelStore: {
      read: async () => (await store.getSettings()).updateChannel ?? "stable",
      write: async (updateChannel) => {
        const current = await store.getSettings();
        await store.saveSettings({ ...current, updateChannel });
      },
    },
    fetchImpl: (async () => ({
      ok: latestTag !== null,
      status: latestTag !== null ? 200 : 500,
      headers: new Headers(),
      json: async () => ({
        tag_name: latestTag,
        html_url: `https://github.com/mdennis281/dispatch/releases/tag/${latestTag}`,
      }),
    })) as unknown as typeof fetch,
  });
  app = await buildApp({
    config: { ...loadConfig(), dataDir: dir },
    store,
    bus,
    serviceOverrides: { release },
  });
  await release.check();
  return release;
}

/**
 * Wait out the deferred launch(es) a successful install schedules.
 *
 * The route spawns 150ms AFTER the reply is flushed, so a test that ends at the
 * 200 leaves a timer armed — and it fires during whichever test runs next. The
 * `mockReset` below is not enough on its own: it zeroes the call count, and the
 * late call then increments the FRESH mock, so the next
 * `expect(launchUpdate).not.toHaveBeenCalled()` sees one call it did not make.
 * That is a load-dependent failure (it only shows up when the whole suite runs
 * together), so every test that legitimately launches consumes its own launch
 * here rather than leaving it for a neighbour.
 *
 * Which is why the wait is on a call COUNT and the tag, not on a bare
 * `toHaveBeenCalled()`. A bare one is satisfied by any call, including a
 * neighbour's orphaned timer landing mid-test — it returned on a launch the test
 * had not caused, the test's own timer stayed armed, and it fired two tests
 * later inside `expect(launchUpdate).not.toHaveBeenCalled()`. That is exactly
 * how "refuses a named tag when no head has been resolved at all" came to fail
 * on `v2026.08.14.79778`, a tag it never asks for.
 */
const settleLaunch = (tag: string, times = 1) =>
  vi.waitFor(() => {
    expect(launchUpdate).toHaveBeenCalledTimes(times);
    expect(launchUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ tag }));
  });

beforeEach(async () => {
  // A full reset, not `mockClear`: the install route spawns 150ms AFTER its
  // reply is flushed, so a previous test's launch can land during this one and
  // would otherwise consume a `…Once` queued here — making this file's result
  // depend on test order.
  launchUpdate.mockReset();
  launchUpdate.mockResolvedValue({ logFile: "", installerSource: "release" as const });
  dir = await mkdtemp(join(tmpdir(), "cm-update-"));
  bus = new EventBus();
});

afterEach(async () => {
  await app?.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("GET /api/update", () => {
  it("reports supported:false for a payload built from source", async () => {
    await withRelease(null, "v2026.08.14.85068");
    const res = await app.inject({ method: "GET", url: "/api/update" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ supported: false, available: false, installed: null });
  });

  it("reports the installed and latest builds when an update exists", async () => {
    await withRelease(MANIFEST, "v2026.08.14.85068");
    const res = await app.inject({ method: "GET", url: "/api/update" });
    expect(res.json()).toMatchObject({
      supported: true,
      available: true,
      installed: { version: "2026.08.14.81160" },
      latest: { version: "2026.08.14.85068" },
    });
  });
});

describe("POST /api/update/check", () => {
  it("returns a fresh status", async () => {
    await withRelease(MANIFEST, "v2026.08.14.85068");
    const res = await app.inject({ method: "POST", url: "/api/update/check" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: true });
  });
});

describe("POST /api/update/install", () => {
  it("refuses on a payload that was not installed from a release", async () => {
    await withRelease(null, "v2026.08.14.85068");
    const res = await app.inject({ method: "POST", url: "/api/update/install" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("not installed from a release");
    expect(launchUpdate).not.toHaveBeenCalled();
  });

  it("refuses when the installed build is already the latest", async () => {
    await withRelease(MANIFEST, "v2026.08.14.81160");
    const res = await app.inject({ method: "POST", url: "/api/update/install" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("no newer release");
    expect(launchUpdate).not.toHaveBeenCalled();
  });

  it("accepts and answers with the tag it will install", async () => {
    await withRelease(MANIFEST, "v2026.08.14.85068");
    const res = await app.inject({ method: "POST", url: "/api/update/install" });
    // Answering before the installer stops this server is the whole ordering
    // contract; a caller that gets a dropped socket cannot tell start from fail.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, tag: "v2026.08.14.85068" });
    await settleLaunch("v2026.08.14.85068");
  });

  it("un-latches when the installer never actually launches", async () => {
    const release = await withRelease(MANIFEST, "v2026.08.14.85068");
    launchUpdate.mockRejectedValue(new Error("node is not on PATH"));

    const res = await app.inject({ method: "POST", url: "/api/update/install" });
    expect(res.statusCode).toBe(200);

    // The reply is flushed before the spawn is even attempted, so the failure
    // lands after it. Without the un-latch this server reports installing:true
    // forever and the UI waits for a restart that is never coming.
    await vi.waitFor(() => expect(release.status().installing).toBeUndefined());
    const retry = await app.inject({ method: "POST", url: "/api/update/install" });
    expect(retry.statusCode).toBe(200);
    // The retry arms a launch of its own, and that one is this file's actual
    // escapee: nothing above waits for it, so it fired during a later test.
    await settleLaunch("v2026.08.14.85068", 2);
  });

  it("refuses a second install once one is already running", async () => {
    const release = await withRelease(MANIFEST, "v2026.08.14.85068");
    // Latched synchronously by the first request, before its reply is flushed —
    // two clicks that land together must not race two installers at one rename.
    release.markInstalling();
    const res = await app.inject({ method: "POST", url: "/api/update/install" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("already running");
  });

  it("installs an explicitly named tag when it is the channel head", async () => {
    // The step-back: the head is OLDER than what is installed, so `available` is
    // false and the tag-less form would be refused. Naming it is the ask.
    await withRelease(MANIFEST, "v2026.08.14.79778");
    const res = await app.inject({
      method: "POST",
      url: "/api/update/install",
      payload: { tag: "v2026.08.14.79778" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, tag: "v2026.08.14.79778" });
    await settleLaunch("v2026.08.14.79778");
  });

  it("refuses any tag that is not the channel head", async () => {
    await withRelease(MANIFEST, "v2026.08.14.85068");
    const res = await app.inject({
      method: "POST",
      url: "/api/update/install",
      payload: { tag: "v2026.08.16.63367" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("only the head");
    expect(launchUpdate).not.toHaveBeenCalled();
  });

  it("refuses a named tag when no head has been resolved at all", async () => {
    await withRelease(MANIFEST, null);
    const res = await app.inject({
      method: "POST",
      url: "/api/update/install",
      payload: { tag: "v2026.08.14.85068" },
    });
    expect(res.statusCode).toBe(409);
    expect(launchUpdate).not.toHaveBeenCalled();
  });
});

describe("PUT /api/update/channel", () => {
  it("switches, persists to settings, and answers with the new channel", async () => {
    await withRelease(MANIFEST, "v2026.08.14.85068");
    const res = await app.inject({
      method: "PUT",
      url: "/api/update/channel",
      payload: { channel: "unstable" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ channel: "unstable" });

    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    expect(settings.json().updateChannel).toBe("unstable");
  });

  it("survives a full-replace settings save that knows nothing about channels", async () => {
    // The exact hazard: PUT /api/settings is a deliberate full replace, so an
    // older client picking a theme would otherwise silently unsubscribe you.
    await withRelease(MANIFEST, "v2026.08.14.85068");
    await app.inject({
      method: "PUT",
      url: "/api/update/channel",
      payload: { channel: "unstable" },
    });
    await app.inject({ method: "PUT", url: "/api/settings", payload: { theme: "light" } });

    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    expect(settings.json()).toMatchObject({ theme: "light", updateChannel: "unstable" });
  });

  it("rejects a channel that does not exist", async () => {
    await withRelease(MANIFEST, "v2026.08.14.85068");
    const res = await app.inject({
      method: "PUT",
      url: "/api/update/channel",
      payload: { channel: "nightly" },
    });
    expect(res.statusCode).toBe(400);
  });
});
