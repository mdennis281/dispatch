/**
 * `ctx.terminals.runs` / `onRun` as a plugin receives them: every run is
 * COUNTED, but a run's command is shown only when it runs on one of this
 * plugin's own backends — `terminals` is consent to see commands run there.
 */
import { describe, expect, it } from "vitest";
import { PluginManifestSchema, type TerminalRunEvent, type TerminalRunInFlight } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { buildPluginContext, newOwnedResources, type PluginContextDeps } from "./context.js";

const run = (over: Partial<TerminalRunInFlight>): TerminalRunInFlight => ({
  runId: "r",
  chatId: "c1",
  terminal: "main",
  backend: "local",
  cwd: "/repo",
  command: "secret --token abc",
  background: false,
  startedAt: 1,
  ...over,
});

function context(withRuns = true) {
  const manifest = PluginManifestSchema.parse({
    id: "remote-host",
    name: "Remote hosts",
    version: "0.1.0",
    dispatch: ">=1",
    capabilities: ["terminals"],
  });
  const listeners = new Set<(e: TerminalRunEvent) => void>();
  const inFlight = [
    run({ runId: "mine", backend: "remote-host/cvx-mac", command: "xcodebuild test" }),
    run({ runId: "local", backend: "local", command: "pnpm install" }),
    run({ runId: "theirs", backend: "proxmox-terminal/box", command: "make" }),
  ];
  const registered = new Set<string>();
  const deps: PluginContextDeps = {
    store: {} as never,
    bus: new EventBus(),
    secrets: {} as never,
    inspect: {} as never,
    memory: {} as never,
    attention: {} as never,
    messenger: {} as never,
    broker: { answerQuestion: () => false, declineQuestion: () => false },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    settings: () => ({}),
    terminals: {
      register: (b) => void registered.add(b.id),
      unregister: async (id) => void registered.delete(id),
      has: (id) => registered.has(id),
      publishPort: () => () => {},
      ports: () => [],
      setStatus: () => {},
      update: () => {},
    },
    ...(withRuns
      ? {
          terminalRuns: {
            runs: (f) => inFlight.filter((r) => !f?.backend || r.backend === f.backend),
            onRun: (fn) => {
              listeners.add(fn);
              return () => listeners.delete(fn);
            },
          },
        }
      : {}),
  };
  const owned = newOwnedResources();
  const ctx = buildPluginContext(manifest, "/plugins/remote-host", deps, owned);
  ctx.terminals!.registerBackend({
    id: "remote-host/cvx-mac",
    label: "CVX Mac",
    shell: "bash",
    spawn: async () => {
      throw new Error("not in this test");
    },
  });
  return { ctx, listeners, owned };
}

describe("ctx.terminals.runs / onRun", () => {
  it("counts every run, but shows the command only for this plugin's own backends", () => {
    const { ctx } = context();
    const runs = ctx.terminals!.runs!();
    expect(runs.map((r) => r.runId)).toEqual(["mine", "local", "theirs"]);
    expect(runs[0]!.command).toBe("xcodebuild test");
    expect(runs[1]).not.toHaveProperty("command");
    expect(runs[2]).not.toHaveProperty("command");
    // Everything a lock needs is still there.
    expect(runs[1]).toMatchObject({ chatId: "c1", terminal: "main", backend: "local", cwd: "/repo" });
    expect(ctx.terminals!.runs!({ backend: "local" }).map((r) => r.runId)).toEqual(["local"]);
  });

  it("applies the same rule to events, and unsubscribes on teardown", () => {
    const { ctx, listeners, owned } = context();
    const seen: TerminalRunEvent[] = [];
    ctx.terminals!.onRun!((e) => seen.push(e));
    expect(listeners.size).toBe(1);
    for (const fn of listeners) {
      fn({ kind: "started", run: run({ runId: "x", backend: "local" }), at: 5 });
      fn({ kind: "ended", run: run({ runId: "y", backend: "remote-host/cvx-mac", command: "ls" }), at: 6 });
    }
    expect(seen[0]!.run).not.toHaveProperty("command");
    expect(seen[1]!.run.command).toBe("ls");
    for (const off of owned.offs) off();
    expect(listeners.size).toBe(0);
  });

  it("is absent on a host built without run tracking", () => {
    const { ctx } = context(false);
    expect(ctx.terminals!.runs).toBeUndefined();
    expect(ctx.terminals!.onRun).toBeUndefined();
  });
});
