/** `ctx.tools` on the context: gated by the capability, stamped with the manifest's id, taken back on teardown. */
import { describe, expect, it } from "vitest";
import { PluginManifestSchema } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { buildPluginContext, newOwnedResources, type PluginContextDeps } from "./context.js";
import { PluginToolRegistry } from "./tools.js";

function context(capabilities: string[], registry = new PluginToolRegistry()) {
  const manifest = PluginManifestSchema.parse({
    id: "remote-host",
    name: "Remote hosts",
    version: "0.1.0",
    dispatch: ">=1",
    capabilities,
  });
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
    tools: registry,
  };
  const owned = newOwnedResources();
  return { ctx: buildPluginContext(manifest, "/p", deps, owned), owned, registry };
}

const tool = { name: "machine_status", description: "Report the machine's status.", handler: () => "up" };

describe("ctx.tools", () => {
  it("is absent without the `tools` capability", () => {
    expect(context(["kv"]).ctx.tools).toBeUndefined();
  });

  it("registers under the manifest's id, so it is served as dispatch-plugin-<that id>", () => {
    const { ctx, registry } = context(["tools"]);
    ctx.tools!.register(tool);
    expect(registry.list("remote-host")).toEqual(["machine_status"]);
    expect(Object.keys(registry.bind({ chatId: "c1" }).servers())).toEqual(["dispatch-plugin-remote-host"]);
  });

  it("the returned unregister drops just that tool", () => {
    const { ctx, registry } = context(["tools"]);
    const off = ctx.tools!.register(tool);
    ctx.tools!.register({ ...tool, name: "remote_fetch" });
    off();
    expect(registry.list("remote-host")).toEqual(["remote_fetch"]);
  });

  it("teardown takes every tool back", () => {
    const { ctx, owned, registry } = context(["tools"]);
    ctx.tools!.register(tool);
    ctx.tools!.register({ ...tool, name: "remote_fetch" });
    for (const off of owned.offs) off();
    expect(registry.list("remote-host")).toEqual([]);
    expect(registry.bind({ chatId: "c1" }).servers()).toEqual({});
  });
});
