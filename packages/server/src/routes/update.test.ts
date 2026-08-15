/**
 * The update REST surface.
 *
 * The property worth defending here is that `POST /api/update/install` cannot be
 * talked into installing something the server did not itself resolve as newer:
 * it takes no tag from the caller, and it refuses outright on a payload that was
 * not installed from a release. `launchUpdate` is mocked throughout — a test that
 * really spawned it would replace the checkout it is running in.
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
  const release = new ReleaseService({
    bus,
    appDir: await payloadDir(manifest),
    env: {},
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
    store: await (async () => {
      const s = new Store(dir);
      await s.init();
      return s;
    })(),
    bus,
    serviceOverrides: { release },
  });
  await release.check();
  return release;
}

beforeEach(async () => {
  launchUpdate.mockClear();
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
});
