import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateChannel } from "@dispatch/shared";
import {
  ReleaseService,
  readInstalledRelease,
  payloadAppDir,
  type ReleaseChannelStore,
} from "./release.js";
import { EventBus } from "../bus.js";

/**
 * Every fixture path is created under the real temp dir rather than written as a
 * literal, so nothing here depends on drive letters — a hardcoded "C:/root" is
 * not absolute on the Linux CI runner and `path.join` would quietly prefix cwd.
 */
const OMIT = Symbol("omit");

async function makeInstall(manifest: unknown, stamp?: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dispatch-release-test-"));
  const appDir = join(root, "app");
  await mkdir(appDir, { recursive: true });
  if (manifest !== OMIT) {
    await writeFile(join(appDir, "release-manifest.json"), JSON.stringify(manifest), "utf8");
  }
  if (stamp !== undefined) {
    await writeFile(join(root, "current.json"), JSON.stringify(stamp), "utf8");
  }
  return appDir;
}

const MANIFEST = {
  version: "2026.08.14.81160",
  tag: "v2026.08.14.81160",
  sha: "cb540e17d2d278b67a90d49ef3c591035ef3d074",
  builtAt: "2026-08-14T22:34:41.590Z",
};

function releaseJson(tag: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    html_url: `https://github.com/mdennis281/dispatch/releases/tag/${tag}`,
    published_at: "2026-08-14T23:39:56Z",
    ...extra,
  };
}

function jsonResponse(body: unknown, init: { status?: number; etag?: string } = {}): Response {
  const headers = new Headers();
  if (init.etag) headers.set("etag", init.etag);
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers,
    json: async () => body,
  } as unknown as Response;
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(join(d, ".."), { recursive: true, force: true })));
});

async function fixture(manifest: unknown = MANIFEST, stamp?: unknown): Promise<string> {
  const appDir = await makeInstall(manifest, stamp);
  dirs.push(appDir);
  return appDir;
}

describe("payloadAppDir", () => {
  it("does not point at a directory the manifest could never be in", () => {
    // A regression guard for an off-by-one that is invisible in every unit test
    // that passes appDir explicitly: this module compiles one level deeper than
    // its sibling `health.ts`, so a hardcoded level count lands on
    // `packages/` and reports every real install as a source checkout. In this
    // checkout there IS no manifest, so the honest answer is only that the
    // result is a directory that could hold one.
    const dir = payloadAppDir();
    expect(dir).toBeTruthy();
    expect(dir.endsWith("packages")).toBe(false);
    expect(dir.includes("dist")).toBe(false);
  });
});

describe("readInstalledRelease", () => {
  it("reads version, tag and sha from the payload manifest", async () => {
    expect(readInstalledRelease(await fixture())).toMatchObject({
      version: "2026.08.14.81160",
      tag: "v2026.08.14.81160",
      sha: MANIFEST.sha,
    });
  });

  it("returns null when there is no manifest — the dev-checkout case", async () => {
    expect(readInstalledRelease(await fixture(OMIT))).toBeNull();
  });

  it("returns null for a manifest missing the fields that identify a release", async () => {
    expect(readInstalledRelease(await fixture({ builtAt: "whenever" }))).toBeNull();
  });

  it("takes installedAt from current.json when it describes this payload", async () => {
    const appDir = await fixture(MANIFEST, {
      version: "2026.08.14.81160",
      installedAt: "2026-08-14T23:05:54.737Z",
    });
    expect(readInstalledRelease(appDir)?.installedAt).toBe("2026-08-14T23:05:54.737Z");
  });

  it("ignores a current.json describing a DIFFERENT build than the one running", async () => {
    // What a rollback leaves behind: the installer recorded the build it put
    // down, then restored the previous payload underneath it.
    const appDir = await fixture(MANIFEST, {
      version: "2026.08.14.85068",
      installedAt: "2026-08-15T00:00:00.000Z",
    });
    expect(readInstalledRelease(appDir)?.installedAt).toBeUndefined();
  });

  it("reads a manifest that picked up a UTF-8 BOM", async () => {
    // A BOM'd manifest fails JSON.parse and is indistinguishable from having no
    // manifest at all, which would silently disable updates for good.
    const appDir = await fixture(MANIFEST);
    await writeFile(join(appDir, "release-manifest.json"), `﻿${JSON.stringify(MANIFEST)}`, "utf8");
    expect(readInstalledRelease(appDir)?.version).toBe("2026.08.14.81160");
  });

  it("survives a corrupt manifest rather than throwing at construction", async () => {
    const appDir = await fixture(MANIFEST);
    await writeFile(join(appDir, "release-manifest.json"), "{not json", "utf8");
    expect(readInstalledRelease(appDir)).toBeNull();
  });
});

describe("ReleaseService", () => {
  let bus: EventBus;
  beforeEach(() => {
    bus = new EventBus();
  });

  async function svc(opts: {
    manifest?: unknown;
    fetchImpl?: typeof fetch;
    execImpl?: (file: string, args: readonly string[]) => Promise<{ stdout: string }>;
    now?: () => number;
    channel?: UpdateChannel;
    channelStore?: ReleaseChannelStore;
  } = {}) {
    const appDir = await fixture(opts.manifest === undefined ? MANIFEST : opts.manifest);
    return new ReleaseService({
      bus,
      appDir,
      env: {},
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.execImpl ? { execImpl: opts.execImpl } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.channel ? { channel: opts.channel } : {}),
      ...(opts.channelStore ? { channelStore: opts.channelStore } : {}),
    });
  }

  it("reports unsupported and never calls out on a source checkout", async () => {
    const fetchImpl = vi.fn();
    const service = await svc({ manifest: null, fetchImpl: fetchImpl as unknown as typeof fetch });
    service.start();
    await service.check(true);

    expect(service.supported).toBe(false);
    expect(service.status()).toMatchObject({ supported: false, installed: null, available: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("finds a newer release and publishes update-available once", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(releaseJson("v2026.08.14.85068")));
    const service = await svc({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const events: unknown[] = [];
    bus.subscribe((e) => events.push(e));

    const status = await service.check();
    expect(status.available).toBe(true);
    expect(status.latest).toMatchObject({ version: "2026.08.14.85068", tag: "v2026.08.14.85068" });
    expect(events).toHaveLength(1);

    // A second check of the same release must not re-nudge.
    await service.check();
    expect(events).toHaveLength(1);
  });

  it("reports no update when the latest release is the installed one", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(releaseJson("v2026.08.14.81160")));
    const service = await svc({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const events: unknown[] = [];
    bus.subscribe((e) => events.push(e));

    expect((await service.check()).available).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("never offers an OLDER release", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(releaseJson("v2026.08.14.79778")));
    const service = await svc({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await service.check()).available).toBe(false);
  });

  it("treats an unorderable semver tag as no update", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(releaseJson("v0.1.0")));
    const service = await svc({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const status = await service.check();
    expect(status.latest?.tag).toBe("v0.1.0");
    expect(status.available).toBe(false);
  });

  it("ignores a draft or prerelease the installer would refuse anyway", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(releaseJson("v2026.08.14.85068", { prerelease: true })),
    );
    const service = await svc({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const status = await service.check();
    expect(status.latest).toBeNull();
    expect(status.available).toBe(false);
  });

  it("sends If-None-Match and keeps the last result on a 304", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(releaseJson("v2026.08.14.85068"), { etag: 'W/"abc"' }))
      .mockResolvedValueOnce(jsonResponse(null, { status: 304 }));
    const service = await svc({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await service.check();
    await service.check();

    const secondCall = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    const secondHeaders = (secondCall[1].headers ?? {}) as Record<string, string>;
    expect(secondHeaders["If-None-Match"]).toBe('W/"abc"');
    expect(service.status()).toMatchObject({
      available: true,
      latest: { tag: "v2026.08.14.85068" },
    });
    expect(service.status().error).toBeUndefined();
  });

  it("keeps the last good answer when the network dies, and records why", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(releaseJson("v2026.08.14.85068")))
      .mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND"));
    const service = await svc({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await service.check();
    const status = await service.check();

    expect(status.available).toBe(true);
    expect(status.latest?.tag).toBe("v2026.08.14.85068");
    expect(status.error).toMatch(/could not reach GitHub/);
  });

  it("records an error without a result when the very first check fails", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "boom" }, { status: 500 }));
    const service = await svc({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const status = await service.check();
    expect(status.available).toBe(false);
    expect(status.latest).toBeNull();
    expect(status.error).toMatch(/500/);
  });

  it("falls back to the gh CLI when the repo is private to this process", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Not Found" }, { status: 404 }));
    const execImpl = vi.fn(async () => ({ stdout: JSON.stringify(releaseJson("v2026.08.14.85068")) }));
    const service = await svc({ fetchImpl: fetchImpl as unknown as typeof fetch, execImpl });

    const status = await service.check();
    expect(execImpl).toHaveBeenCalledWith("gh", expect.arrayContaining(["api"]));
    expect(status.available).toBe(true);
  });

  it("explains how to authenticate when both the API and gh fail", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Bad credentials" }, { status: 401 }));
    const execImpl = vi.fn(async () => {
      throw new Error("gh: command not found");
    });
    const service = await svc({ fetchImpl: fetchImpl as unknown as typeof fetch, execImpl });

    const status = await service.check();
    expect(status.error).toMatch(/GITHUB_TOKEN/);
    expect(status.available).toBe(false);
  });

  it("coalesces concurrent checks onto one request", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(releaseJson("v2026.08.14.85068")));
    const service = await svc({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await Promise.all([service.check(), service.check(), service.check()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("floor-spaces forced checks so the button cannot be leaned on", async () => {
    let clock = 1_000_000;
    const fetchImpl = vi.fn(async () => jsonResponse(releaseJson("v2026.08.14.85068")));
    const service = await svc({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock });

    await service.check(true);
    await service.check(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock += 60_000;
    await service.check(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops advertising the button once an install has been launched", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(releaseJson("v2026.08.14.85068")));
    const service = await svc({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await service.check();
    service.markInstalling();
    expect(service.status().installing).toBe(true);
  });
});

/**
 * Channels. The rule that has to hold in every one of these: what the STABLE
 * channel offers must be exactly what it offered before channels existed, or
 * this change quietly starts shipping unreviewed merges to stable subscribers.
 */
describe("ReleaseService channels", () => {
  let bus: EventBus;
  beforeEach(() => {
    bus = new EventBus();
  });

  async function svc(opts: {
    fetchImpl?: typeof fetch;
    execImpl?: (file: string, args: readonly string[]) => Promise<{ stdout: string }>;
    channel?: UpdateChannel;
    channelStore?: ReleaseChannelStore;
    manifest?: unknown;
  }) {
    const appDir = await fixture(opts.manifest === undefined ? MANIFEST : opts.manifest);
    return new ReleaseService({
      bus,
      appDir,
      env: {},
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.execImpl ? { execImpl: opts.execImpl } : {}),
      ...(opts.channel ? { channel: opts.channel } : {}),
      ...(opts.channelStore ? { channelStore: opts.channelStore } : {}),
    });
  }

  /** A `gh release list`-shaped page, newest last so nothing can pass by luck of order. */
  const PAGE = [
    releaseJson("v2026.08.14.79778"),
    releaseJson("v2026.08.16.63367", { prerelease: true }),
    releaseJson("v2026.08.15.10000", { prerelease: true }),
  ];

  it("defaults to stable and asks releases/latest", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(releaseJson("v2026.08.14.85068")));
    const service = await svc({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const status = await service.check();
    expect(status.channel).toBe("stable");
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toContain("/releases/latest");
  });

  it("takes the highest build stamp on unstable, not the first in the list", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(PAGE));
    const service = await svc({
      channel: "unstable",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const status = await service.check();
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toContain("/releases?per_page=");
    expect(status.latest?.tag).toBe("v2026.08.16.63367");
    expect(status.available).toBe(true);
    expect(status.channel).toBe("unstable");
  });

  it("still sees a promoted build on unstable — promotion is not a regression", async () => {
    // The newest release has been flipped to stable. An unstable subscriber must
    // be offered it, not held on an older prerelease because it stopped being one.
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        releaseJson("v2026.08.15.10000", { prerelease: true }),
        releaseJson("v2026.08.16.63367"),
      ]),
    );
    const service = await svc({
      channel: "unstable",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect((await service.check()).latest?.tag).toBe("v2026.08.16.63367");
  });

  it("refuses a draft on unstable — its assets may not exist", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        releaseJson("v2026.08.15.10000", { prerelease: true }),
        releaseJson("v2026.08.16.63367", { prerelease: true, draft: true }),
      ]),
    );
    const service = await svc({
      channel: "unstable",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect((await service.check()).latest?.tag).toBe("v2026.08.15.10000");
  });

  it("skips an unorderable tag on unstable rather than ranking it", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        releaseJson("v0.1.0", { prerelease: true }),
        releaseJson("v2026.08.15.10000", { prerelease: true }),
      ]),
    );
    const service = await svc({
      channel: "unstable",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect((await service.check()).latest?.tag).toBe("v2026.08.15.10000");
  });

  it("reports ahead — not available — when the install outruns the channel head", async () => {
    // Switched to stable while running a newer unstable build. This is the case
    // that must NOT read as a plain "up to date": there is a step-back to offer.
    const fetchImpl = vi.fn(async () => jsonResponse(releaseJson("v2026.08.14.79778")));
    const service = await svc({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const events: unknown[] = [];
    bus.subscribe((e) => events.push(e));

    const status = await service.check();
    expect(status.ahead).toBe(true);
    expect(status.available).toBe(false);
    // And it must never nudge: a downgrade is asked for by name, never pushed.
    expect(events).toHaveLength(0);
  });

  it("does not claim ahead when the head is unknown", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "boom" }, { status: 500 }));
    const service = await svc({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await service.check()).ahead).toBeUndefined();
  });

  it("persists a switch and re-checks against the new channel", async () => {
    let stored: UpdateChannel = "stable";
    const fetchImpl = vi.fn(async (url: unknown) =>
      String(url).includes("/releases/latest")
        ? jsonResponse(releaseJson("v2026.08.14.79778"))
        : jsonResponse(PAGE),
    );
    const service = await svc({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      channelStore: {
        read: async () => stored,
        write: async (next) => {
          stored = next;
        },
      },
    });

    await service.check();
    const status = await service.setChannel("unstable");

    expect(stored).toBe("unstable");
    expect(status.channel).toBe("unstable");
    expect(status.latest?.tag).toBe("v2026.08.16.63367");
    expect(status.available).toBe(true);
  });

  it("drops the etag on a switch so a 304 cannot strand the old channel's answer", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(releaseJson("v2026.08.14.85068"), { etag: 'W/"stable"' }),
      )
      .mockResolvedValueOnce(jsonResponse(PAGE));
    const service = await svc({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await service.check();
    await service.setChannel("unstable");

    const second = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect((second[1].headers as Record<string, string>)["If-None-Match"]).toBeUndefined();
  });

  it("hydrates the persisted channel before the first check", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(PAGE));
    const service = await svc({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      channelStore: { read: async () => "unstable", write: async () => {} },
    });

    expect(service.status().channel).toBe("stable");
    await service.hydrate();
    expect(service.status().channel).toBe("unstable");
    expect((await service.check()).latest?.tag).toBe("v2026.08.16.63367");
  });

  it("still switches when persistence fails, and says so", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(PAGE));
    const service = await svc({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      channelStore: {
        read: async () => "stable",
        write: async () => {
          throw new Error("EACCES config.json");
        },
      },
    });

    const status = await service.setChannel("unstable");
    expect(status.channel).toBe("unstable");
    expect(status.error).toMatch(/this session only/);
  });

  it("exposes only the channel head as an installable tag", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(PAGE));
    const service = await svc({
      channel: "unstable",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(service.headTag()).toBeNull();
    await service.check();
    expect(service.headTag()).toBe("v2026.08.16.63367");
  });

  it("asks gh for the same channel path on the CLI fallback", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Not Found" }, { status: 404 }));
    const execImpl = vi.fn(async () => ({ stdout: JSON.stringify(PAGE) }));
    const service = await svc({
      channel: "unstable",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      execImpl,
    });

    const status = await service.check();
    expect(execImpl).toHaveBeenCalledWith("gh", expect.arrayContaining([expect.stringContaining("/releases?per_page=")]));
    expect(status.latest?.tag).toBe("v2026.08.16.63367");
  });
});
