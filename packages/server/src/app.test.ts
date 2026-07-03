import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { EventBus } from "./bus.js";

describe("buildApp", () => {
  it("registers plugins and serves GET /api/health", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cm-app-"));
    const config = { ...loadConfig(), dataDir: dir };
    const app = await buildApp({ config, bus: new EventBus() });
    try {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      // The wired context is exposed to downstream registrars.
      expect(app.cm.config.dataDir).toBe(dir);
      expect(app.cm.store).toBeDefined();
      expect(app.cm.bus).toBeInstanceOf(EventBus);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
