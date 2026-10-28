/**
 * POST /api/shutdown — the in-app Stop button's endpoint.
 *
 * The two properties that matter are the ones a careless implementation gets
 * wrong: it must REFUSE on a server with no shutdown wiring rather than 200-ing
 * on a stop that will never happen, and it must answer BEFORE tearing anything
 * down, or the caller sees a dropped connection instead of its confirmation.
 *
 * `installShutdown` is given a fake `exit` so the test process survives.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { installShutdown, RESTART_EXIT_CODE } from "../shutdown.js";

let dir: string;
let app: FastifyInstance;
let bus: EventBus;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-shutdown-"));
  const store = new Store(dir);
  await store.init();
  const config = { ...loadConfig(), dataDir: dir };
  bus = new EventBus();
  app = await buildApp({ config, store, bus });
});

afterEach(async () => {
  await app.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

describe("POST /api/shutdown", () => {
  it("refuses when the server has no shutdown wiring", async () => {
    const res = await app.inject({ method: "POST", url: "/api/shutdown" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("pnpm app:stop");
  });

  it("accepts once shutdown is wired, and answers before tearing down", async () => {
    const exit = vi.fn();
    installShutdown(app, { exit });

    const res = await app.inject({ method: "POST", url: "/api/shutdown" });

    // The reply is the point: teardown must not race it.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("announces the stop on the bus so clients can tell it was deliberate", async () => {
    const seen: string[] = [];
    bus.subscribe((evt) => {
      if (evt.type === "server-shutdown") seen.push(evt.reason ?? "");
    });

    const closer = installShutdown(app, { exit: vi.fn() });
    await closer();

    expect(seen).toHaveLength(1);
  });

  it("is idempotent — a second stop rides the first teardown", async () => {
    const exit = vi.fn();
    const closer = installShutdown(app, { exit });

    await Promise.all([closer(), closer()]);

    // One teardown, one exit — not two.
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe("/api/restart", () => {
  it("is unsupported unless the launcher will start the server again", async () => {
    installShutdown(app, { exit: vi.fn(), restartable: false });

    const status = await app.inject({ method: "GET", url: "/api/restart" });
    expect(status.json().supported).toBe(false);

    // A restart nobody would complete is a stop. Refuse it.
    const res = await app.inject({ method: "POST", url: "/api/restart", payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("pnpm dev");
  });

  it("answers, announces a restart, and exits with the code the launcher relaunches on", async () => {
    const seen: Array<{ reason?: string; restarting?: boolean }> = [];
    bus.subscribe((evt) => {
      if (evt.type === "server-shutdown") seen.push({ reason: evt.reason, restarting: evt.restarting });
    });
    const exited = new Promise<number>((resolve) => {
      installShutdown(app, { exit: resolve, restartable: true });
    });

    expect((await app.inject({ method: "GET", url: "/api/restart" })).json()).toEqual({
      supported: true,
    });
    const res = await app.inject({ method: "POST", url: "/api/restart", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    expect(await exited).toBe(RESTART_EXIT_CODE);
    expect(seen).toEqual([{ reason: "restart requested", restarting: true }]);
  });

  it("skips the resume capture when resumeAgents is false", async () => {
    const skip = vi.spyOn(app.services.restartResume, "skipNextCapture");
    installShutdown(app, { exit: vi.fn(), restartable: true });

    await app.inject({ method: "POST", url: "/api/restart", payload: { resumeAgents: false } });

    expect(skip).toHaveBeenCalledTimes(1);
  });

  it("resumes by default: a body without the field doesn't skip anything", async () => {
    const skip = vi.spyOn(app.services.restartResume, "skipNextCapture");
    installShutdown(app, { exit: vi.fn(), restartable: true });

    await app.inject({ method: "POST", url: "/api/restart", payload: {} });

    expect(skip).not.toHaveBeenCalled();
  });
});
