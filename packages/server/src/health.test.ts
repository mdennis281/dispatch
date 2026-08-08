/**
 * Unit tests for the readiness probe.
 *
 * These are written from the caller's side: every case here is a state
 * `tools/app/upgrade.mjs` has to be able to tell apart while deciding, with no
 * human watching and the old payload already moved aside, whether to keep a
 * freshly swapped-in build or roll it back.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { healthReport, type HealthDeps } from "./health.js";
import { Store } from "./store/index.js";

/** A temp dir shaped like a built SPA: what `spa: true` actually requires. */
async function spaDist(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cm-health-spa-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>spa</title>");
  return dir;
}

/** An initialised store over a fresh temp root. */
async function tempStore(): Promise<{ dir: string; store: Store }> {
  const dir = await mkdtemp(join(tmpdir(), "cm-health-"));
  const store = new Store(dir);
  await store.init();
  return { dir, store };
}

describe("healthReport", () => {
  it("is green when both roots read and the SPA shell is on disk", async () => {
    const { dir, store } = await tempStore();
    const clientDist = await spaDist();
    try {
      const r = await healthReport({ store, dataDir: dir, clientDist });
      expect(r.ok).toBe(true);
      expect(r.status).toBe("ok");
      expect(r.problems).toEqual([]);
      expect(r.spa).toBe(true);
      expect(r.store).toBe(true);
      expect(r.dataDir).toBe(dir);
      // configDir defaults to dataDir — the single-root layout every test uses.
      expect(r.configDir).toBe(dir);
      // The identity fields that let a caller prove WHICH process answered.
      expect(r.pid).toBe(process.pid);
      expect(r.startedAt).toBeLessThanOrEqual(Date.now());
      expect(r.uptimeMs).toBeGreaterThanOrEqual(0);
      // Best effort: a payload without git is unusual, not unhealthy.
      if (r.sha !== undefined) expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(clientDist, { recursive: true, force: true });
    }
  });

  it("is degraded when the SPA never got built", async () => {
    // The API answers, the store reads, and every browser tab would 404. This
    // is the failure `publish.mjs`'s verifyPayload exists to catch, and the one
    // a liveness probe calls green.
    const { dir, store } = await tempStore();
    try {
      const r = await healthReport({
        store,
        dataDir: dir,
        clientDist: join(dir, "no-such-dist"),
      });
      expect(r.ok).toBe(false);
      expect(r.status).toBe("degraded");
      expect(r.spa).toBe(false);
      expect(r.store).toBe(true);
      expect(r.problems.join(" ")).toMatch(/SPA shell missing/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is degraded when the data root cannot be read", async () => {
    // The regression this guards: `Store.getSettings()` reads config.json via
    // readJson, which returns undefined for a missing FILE and a missing
    // DIRECTORY alike — so it hands back DEFAULT_SETTINGS and reports healthy
    // for a root that isn't there at all.
    const missing = join(tmpdir(), `cm-health-absent-${process.pid}-${Date.now()}`);
    const clientDist = await spaDist();
    try {
      const r = await healthReport({
        store: new Store(missing),
        dataDir: missing,
        clientDist,
      });
      expect(r.ok).toBe(false);
      expect(r.store).toBe(false);
      expect(r.spa).toBe(true);
      expect(r.problems.join(" ")).toMatch(/data dir unreadable/);
      // One root, one complaint — not the same directory reported twice.
      expect(r.problems).toHaveLength(1);
    } finally {
      await rm(clientDist, { recursive: true, force: true });
    }
  });

  it("is degraded when the config root is gone in the split-root layout", async () => {
    // `getSettings()` only ever touches configDir, so dataDir has to be probed
    // on its own — and this is the layout the desktop install actually runs.
    const { dir, store } = await tempStore();
    const clientDist = await spaDist();
    const missingConfig = join(tmpdir(), `cm-health-cfg-${process.pid}-${Date.now()}`);
    try {
      const r = await healthReport({
        store,
        dataDir: dir,
        configDir: missingConfig,
        clientDist,
      });
      expect(r.ok).toBe(false);
      expect(r.store).toBe(false);
      expect(r.configDir).toBe(missingConfig);
      expect(r.problems.join(" ")).toMatch(/config dir unreadable/);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(clientDist, { recursive: true, force: true });
    }
  });

  it("is degraded when the store's contents fail this build's schemas", async () => {
    // The second failure mode: the roots are fine, but the data in them is not
    // something this payload can parse. That is an upgrade to roll back, and it
    // is invisible to any check that only stats the directory.
    const { dir, store } = await tempStore();
    const clientDist = await spaDist();
    try {
      await writeFile(join(dir, "config.json"), JSON.stringify({ theme: "chartreuse" }));
      const r = await healthReport({ store, dataDir: dir, clientDist });
      expect(r.ok).toBe(false);
      expect(r.store).toBe(false);
      expect(r.problems.join(" ")).toMatch(/store unreadable/);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(clientDist, { recursive: true, force: true });
    }
  });

  it("treats dev mode as SPA-present (Vite serves it in-process)", async () => {
    const { dir, store } = await tempStore();
    try {
      const r = await healthReport({
        store,
        dataDir: dir,
        dev: true,
        clientDist: join(dir, "no-such-dist"),
      });
      expect(r.spa).toBe(true);
      expect(r.ok).toBe(true);
      expect(r.problems).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves rather than throwing when the store blows up", async () => {
    // A probe that 500s tells the upgrade gate nothing: it reads as "degraded,
    // no reason given" and burns the whole health timeout before rolling back.
    const { dir } = await tempStore();
    const clientDist = await spaDist();
    const exploding = {
      getSettings: () => Promise.reject(new Error("boom")),
    } as unknown as HealthDeps["store"];
    try {
      const r = await healthReport({ store: exploding, dataDir: dir, clientDist });
      expect(r.ok).toBe(false);
      expect(r.store).toBe(false);
      expect(r.problems.join(" ")).toMatch(/store unreadable: boom/);
      // Still reports identity — the caller needs it even on the sad path.
      expect(r.pid).toBe(process.pid);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(clientDist, { recursive: true, force: true });
    }
  });

  it("resolves the same sha on every call (git is not re-run per poll)", async () => {
    // The gate polls this endpoint every 750ms for up to two minutes; forking a
    // `git` per poll — or per call, on a payload with no sha to give — is the
    // failure the three-state cache prevents.
    const { dir, store } = await tempStore();
    const clientDist = await spaDist();
    try {
      const a = await healthReport({ store, dataDir: dir, clientDist });
      const b = await healthReport({ store, dataDir: dir, clientDist });
      expect(a.sha).toBe(b.sha);
      // Never the empty string: it is neither a sha nor a "no answer" sentinel.
      expect(a.sha).not.toBe("");
      expect(b.startedAt).toBe(a.startedAt);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(clientDist, { recursive: true, force: true });
    }
  });
});
