/**
 * `ctx.runner` (E10/E26): who holds which local port, and what a plugin must
 * never bind or expose. The deny-list is about what is RESERVED, not only what
 * is bound — a port free only because its owner is down is still its owner's.
 */
import { describe, expect, it } from "vitest";
import { PluginManifestSchema, type PluginProcess, type RunnerInstance } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { buildPluginContext, newOwnedResources, type PluginContextDeps } from "./context.js";
import { createRunnerView, dispatchPorts, DEV_DEFAULT_PORT, DEV_HMR_PORT, STABLE_DEFAULT_PORT } from "./runner-view.js";

const row = (over: Partial<RunnerInstance>): RunnerInstance => ({
  id: "r1",
  worktreePath: "/wt",
  subAppId: "web",
  kind: "process",
  status: "running",
  ...over,
});

function view(rows: RunnerInstance[], declared: Array<{ pluginId: string; processes: PluginProcess[] }> = []) {
  return createRunnerView({
    runner: { list: async () => rows },
    declared: () => declared,
    dispatchPorts: async () => dispatchPorts({ ownPort: 4391, stablePort: 4320 }),
  });
}

describe("ctx.runner.list", () => {
  it("lists live sub-apps and plugin processes with their owners and ports, and leaves stopped ones out", async () => {
    const v = view([
      row({ id: "a", projectId: "p1", chatId: "c1", branch: "feat/x", subAppId: "web", port: 5173, ports: [5173, 5174], url: "http://localhost:5173" }),
      row({ id: "b", owner: "plugin:voice", subAppId: "whisper", port: 8765, adopted: true }),
      row({ id: "c", projectId: "p1", subAppId: "api", port: 3000, status: "stopped" }),
      row({ id: "d", projectId: "p2", subAppId: "worker", status: "starting" }),
    ]);
    expect(await v.list()).toEqual([
      {
        id: "a",
        owner: { kind: "sub-app", projectId: "p1", chatId: "c1", branch: "feat/x", subAppId: "web" },
        status: "running",
        ports: [5173, 5174],
        url: "http://localhost:5173",
      },
      { id: "b", owner: { kind: "plugin", pluginId: "voice", processId: "whisper" }, status: "running", ports: [8765], adopted: true },
      { id: "d", owner: { kind: "sub-app", projectId: "p2", subAppId: "worker" }, status: "starting", ports: [] },
    ]);
  });
});

describe("ctx.runner.reservedPorts", () => {
  it("reserves Dispatch's own ports even while nothing holds them, and every plugin's declared and held ports", async () => {
    const v = view(
      [
        // Its declared 8765 was busy, so the allocator gave it 8766.
        row({ id: "b", owner: "plugin:voice", subAppId: "whisper", port: 8766, ports: [8766] }),
        // A stopped plugin process holds nothing.
        row({ id: "x", owner: "plugin:voice", subAppId: "old", port: 9999, status: "stopped" }),
        // A sub-app is not a reservation: it is in list(), and its port may move.
        row({ id: "a", projectId: "p1", subAppId: "web", port: 5173 }),
      ],
      [
        { pluginId: "voice", processes: [{ id: "whisper", command: "x", ports: [8765] }] },
        // A plugin claiming a Dispatch port does not make it the plugin's.
        { pluginId: "rogue", processes: [{ id: "srv", command: "x", ports: [4319, 7000] }] },
      ],
    );
    const reserved = await v.reservedPorts();
    expect(reserved.map((r) => [r.port, r.owner])).toEqual([
      [STABLE_DEFAULT_PORT, "dispatch"],
      [DEV_DEFAULT_PORT, "dispatch"],
      [4320, "dispatch"],
      [4391, "dispatch"],
      [7000, "plugin:rogue"],
      [8765, "plugin:voice"],
      [8766, "plugin:voice"],
      [DEV_HMR_PORT, "dispatch"],
    ]);
    expect(reserved.find((r) => r.port === 4320)?.reason).toBe("the installed (stable) Dispatch instance");
    expect(reserved.find((r) => r.port === 4391)?.reason).toBe("this Dispatch instance");
    expect(reserved.find((r) => r.port === 8766)?.reason).toBe(`held by plugin "voice"'s process "whisper"`);
  });

  it("still reserves the defaults with nothing else known", () => {
    expect(dispatchPorts({}).map((p) => p.port)).toEqual([STABLE_DEFAULT_PORT, DEV_DEFAULT_PORT, DEV_HMR_PORT]);
  });
});

describe("ctx.runner gating", () => {
  function ctxWith(capabilities: string[]) {
    const manifest = PluginManifestSchema.parse({ id: "remote-host", name: "R", version: "0.1.0", dispatch: ">=1", capabilities });
    const deps: PluginContextDeps = {
      store: {} as never,
      bus: new EventBus(),
      secrets: {} as never,
      inspect: {} as never,
      memory: {} as never,
      attention: {} as never,
      messenger: {} as never,
      broker: {} as never,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      settings: () => ({}),
      runner: view([]),
    };
    return buildPluginContext(manifest, "/plugins/remote-host", deps, newOwnedResources());
  }

  it("is present only for a plugin that declares `runner`", async () => {
    expect(ctxWith([]).runner).toBeUndefined();
    const ctx = ctxWith(["runner"]);
    expect(await ctx.runner!.list()).toEqual([]);
    expect((await ctx.runner!.reservedPorts()).length).toBeGreaterThan(0);
  });
});
