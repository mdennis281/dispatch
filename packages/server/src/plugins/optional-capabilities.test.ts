/**
 * `optionalCapabilities` reach every gate the way `capabilities` do. A site
 * that read `capabilities` alone would deny what the consent screen showed as
 * granted.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PluginManifestSchema } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { buildPluginContext, newOwnedResources, type PluginContextDeps } from "./context.js";
import { inspectPluginDir } from "./inspect/inspect.js";

function ctxFor(manifest: Record<string, unknown>) {
  const m = PluginManifestSchema.parse({ id: "remote-host", name: "R", version: "0.1.0", dispatch: ">=1", ...manifest });
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
    approvals: {} as never,
  };
  return buildPluginContext(m, "/plugins/remote-host", deps, newOwnedResources());
}

describe("optionalCapabilities at the context gate", () => {
  it("grants a known optional capability exactly like a required one", () => {
    expect(ctxFor({ optionalCapabilities: ["approvals"] }).approvals).toBeDefined();
    expect(ctxFor({ capabilities: ["approvals"] }).approvals).toBeDefined();
    expect(ctxFor({}).approvals).toBeUndefined();
  });

  it("ignores an unknown one rather than failing the plugin", () => {
    const ctx = ctxFor({ capabilities: ["kv"], optionalCapabilities: ["teleport"] });
    expect(ctx.kv).toBeDefined();
    expect("teleport" in ctx).toBe(false);
  });
});

describe("optionalCapabilities on the consent card", () => {
  it("marks the optional ones, and notes the ignored ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-optcap-"));
    await writeFile(
      join(dir, "plugin.yaml"),
      "id: r\nname: R\nversion: 1.0.0\ndispatch: '>=1'\ncapabilities: [routes]\noptionalCapabilities: [approvals, teleport]\n",
    );
    const r = await inspectPluginDir(dir, {
      source: { url: "x", host: "github", repo: "o/r", cloneUrl: "x", ref: "main", sha: "a".repeat(40), subdir: "" },
      fetched: { files: 0, bytes: 0, skipped: [] },
    });
    expect(r.valid).toBe(true);
    expect(r.capabilities.map((c) => [c.name, c.optional ?? false])).toEqual([
      ["routes", false],
      ["approvals", true],
    ]);
    expect(r.warnings.join("\n")).toMatch(/"teleport" is not known to this Dispatch and was ignored/);
  });
});
