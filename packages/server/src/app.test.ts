import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { EventBus } from "./bus.js";

/** A temp dir holding a built-SPA-shaped `index.html`, for the healthy case. */
async function fakeClientDist(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cm-spa-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.html"), "<!doctype html><title>spa</title>");
  return dir;
}

describe("buildApp", () => {
  it("registers plugins and serves a green GET /api/health", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cm-app-"));
    const clientDist = await fakeClientDist();
    const config = { ...loadConfig(), dataDir: dir };
    const app = await buildApp({ config, bus: new EventBus(), clientDist });
    try {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.status).toBe("ok");
      expect(body.problems).toEqual([]);
      // The fields the upgrade tool uses to prove WHICH process answered.
      expect(body.pid).toBe(process.pid);
      expect(body.store).toBe(true);
      expect(body.spa).toBe(true);
      expect(body.dataDir).toBe(dir);
      expect(typeof body.startedAt).toBe("number");
      // The wired context is exposed to downstream registrars.
      expect(app.cm.config.dataDir).toBe(dir);
      expect(app.cm.store).toBeDefined();
      expect(app.cm.bus).toBeInstanceOf(EventBus);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
      await rm(clientDist, { recursive: true, force: true });
    }
  });

  it("reports 503 + degraded when the SPA shell is missing", async () => {
    // The exact failure `publish.mjs`'s verifyPayload guards against: a build
    // that exits 0 having emitted no client dist. The API answers; every
    // browser tab would 404. An upgrade must roll this back, not keep it.
    const dir = await mkdtemp(join(tmpdir(), "cm-app-"));
    const config = { ...loadConfig(), dataDir: dir };
    const app = await buildApp({
      config,
      bus: new EventBus(),
      clientDist: join(dir, "nonexistent-dist"),
    });
    try {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.ok).toBe(false);
      expect(body.status).toBe("degraded");
      expect(body.spa).toBe(false);
      expect(body.problems.join(" ")).toMatch(/SPA shell missing/);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats dev mode as SPA-present (Vite serves it in-process)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cm-app-"));
    const config = { ...loadConfig(), dataDir: dir };
    // `dev: true` on buildApp would mount Vite middleware, which needs the real
    // client package — so the health module's own dev branch is exercised
    // directly instead.
    const { healthReport } = await import("./health.js");
    const { Store } = await import("./store/index.js");
    const store = new Store(dir);
    await store.init();
    try {
      const report = await healthReport({
        store,
        dataDir: dir,
        dev: true,
        clientDist: join(dir, "nonexistent-dist"),
      });
      expect(report.spa).toBe(true);
      expect(report.ok).toBe(true);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
