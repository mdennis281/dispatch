/** `ctx.shared` on the context: gated by the capability, and released on teardown. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManifestSchema } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { buildPluginContext, newOwnedResources, type PluginContextDeps } from "./context.js";
import { PluginSharedStore, pluginSharedDbPath } from "./shared-state.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function context(capabilities: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-ctx-shared-"));
  const store = new PluginSharedStore(pluginSharedDbPath(dir));
  cleanup.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }), () => store.close());
  const manifest = PluginManifestSchema.parse({ id: "remote-host", name: "Remote hosts", version: "0.1.0", dispatch: ">=1", capabilities });
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
    instance: () => ({ id: "inst-a", role: "dev", dataDirFingerprint: "x" }),
    sharedState: store,
  };
  const owned = newOwnedResources();
  return { ctx: buildPluginContext(manifest, "/p", deps, owned), owned, store };
}

describe("ctx.shared", () => {
  it("is absent without the `shared` capability", async () => {
    expect((await context(["kv"])).ctx.shared).toBeUndefined();
  });

  it("writes under the plugin's own id and the instance's, and teardown releases its locks", async () => {
    const { ctx, owned, store } = await context(["shared"]);
    await ctx.shared!.set("k", 1);
    expect(store.get("remote-host", "k")).toMatchObject({ value: 1, updatedBy: "inst-a" });
    await ctx.shared!.lock("upgrade");
    expect(store.holder("remote-host", "upgrade")).toMatchObject({ instanceId: "inst-a", role: "dev" });
    for (const off of owned.offs) off();
    expect(store.holder("remote-host", "upgrade")).toBeUndefined();
  });
});
