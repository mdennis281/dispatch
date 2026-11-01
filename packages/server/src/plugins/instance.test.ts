/**
 * `ctx.instance` end to end: the identity a plugin's server half reads is the
 * one `GET /api/plugins/instance` hands its browser half, and two instances
 * sharing `config/` get two ids even when one's data dir began as a copy of
 * the other's: dev seeded from stable, the case E25 exists for.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cpSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { PluginInstance } from "@dispatch/shared";
import { buildApp } from "../app.js";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close().catch(() => {})));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function configRoot(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "dispatch-plugin-instance-"));
  dirs.push(base);
  const configDir = join(base, "config");
  const dir = join(configDir, "plugins", "whoami");
  await mkdir(join(dir, "server"), { recursive: true });
  await writeFile(
    join(dir, "plugin.yaml"),
    "id: whoami\nname: Who am I\nversion: 1.0.0\ndispatch: '>=1'\nserver: ./server/index.js\ncapabilities: [routes]\n",
  );
  await writeFile(
    join(dir, "server", "index.js"),
    "export function activate(ctx) { ctx.routes((r) => r.get('/me', async () => ({ instance: ctx.instance ?? null }))); }\n",
  );
  return configDir;
}

async function instance(configDir: string, dataDir: string) {
  const app = await buildApp({
    store: new Store(dataDir, configDir),
    bus: new EventBus(),
    config: { port: 0, host: "127.0.0.1", dataDir, configDir, maxActiveSessions: 1, idleSessionMinutes: 30 },
  });
  apps.push(app);
  await app.services.plugins.activateAll();
  const get = async <T>(url: string) => (await app.inject({ method: "GET", url })).json() as T;
  return {
    app,
    seen: async () => (await get<{ instance: PluginInstance | null }>("/api/plugins/whoami/me")).instance,
    served: () => get<PluginInstance>("/api/plugins/instance"),
  };
}

describe("ctx.instance", () => {
  it("is what the plugin sees and what the client is served, and copied data does not share it", async () => {
    const configDir = await configRoot();
    const stableData = await mkdtemp(join(tmpdir(), "dispatch-plugin-instance-stable-"));
    dirs.push(stableData);
    const stable = await instance(configDir, stableData);
    const mine = await stable.seen();
    expect(mine).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), role: "other", dataDirFingerprint: expect.any(String) });
    expect(await stable.served()).toEqual(mine);

    // Dev's data seeded from stable's, instance.json and all, while stable runs.
    const devData = `${stableData}-dev`;
    dirs.push(devData);
    cpSync(stableData, devData, { recursive: true });
    const dev = await instance(configDir, devData);
    const theirs = await dev.seen();
    expect(theirs?.id).not.toBe(mine!.id);
    expect(theirs?.previousId).toBe(mine!.id);
    expect(theirs?.reminted?.reason).toBe("copied");
    expect(await dev.served()).toEqual(theirs);
  });
});
