import { describe, expect, it } from "vitest";
import { isKnownProvider, providerFor, type ProviderDescriptor } from "@dispatch/shared";
import { CLAUDE_PROVIDER } from "@dispatch/plugin-claude/descriptor";
import { HarnessRegistry } from "./index.js";
import type { Harness } from "./types.js";

/** Just enough of a harness for the registry, which only reads kind and runtime. */
function fakeHarness(kind: string, available = true, onDispose?: () => void): Harness {
  return {
    kind,
    capabilities: {} as Harness["capabilities"],
    runtime: () => ({ kind, source: "installed", available }),
    listModels: async () => [],
    ...(onDispose ? { dispose: async () => onDispose() } : {}),
  } as unknown as Harness;
}

/** A registry holding Claude the way its built-in plugin registers it. */
const builtins = () =>
  new HarnessRegistry({ providers: [{ harness: fakeHarness("claude"), descriptor: CLAUDE_PROVIDER }] });

const descriptor = (id: string): ProviderDescriptor => ({
  ...CLAUDE_PROVIDER,
  id,
  label: `${id} label`,
  shortLabel: id,
});

describe("HarnessRegistry", () => {
  // #428: nothing is compiled in, Claude included. A host with every provider
  // plugin switched off has no provider — not a hidden Claude.
  it("compiles in no provider — every one arrives through register()", () => {
    expect(new HarnessRegistry().list()).toEqual([]);
    expect(new HarnessRegistry().resolve("claude")).toMatchObject({
      ok: false,
      unavailable: { provider: "claude", reason: "unregistered" },
    });
  });

  it("adds a runtime provider to the registry AND the shared descriptor catalogue", () => {
    const registry = builtins();
    registry.register(fakeHarness("opencode"), descriptor("opencode"));
    expect(registry.find("opencode")?.kind).toBe("opencode");
    expect(registry.list().map((h) => h.kind)).toEqual(["claude", "opencode"]);
    expect(isKnownProvider("opencode")).toBe(true);
    expect(providerFor("opencode").label).toBe("opencode label");
    expect(registry.resolve("opencode")).toMatchObject({ ok: true, harness: { kind: "opencode" } });
  });

  it("registers the providers it is constructed with, as a plugin would", () => {
    const registry = new HarnessRegistry({
      providers: [{ harness: fakeHarness("ctor-made"), descriptor: descriptor("ctor-made") }],
    });
    expect(registry.find("ctor-made")).toBeDefined();
  });

  it("unregisters a provider, disposes its runtime, and is unavailable afterwards", async () => {
    let disposed = 0;
    const registry = builtins();
    registry.register(fakeHarness("dropme", true, () => (disposed += 1)), descriptor("dropme"));
    await registry.unregister("dropme");
    expect(disposed).toBe(1);
    expect(registry.find("dropme")).toBeUndefined();
    expect(isKnownProvider("dropme")).toBe(false);
    expect(registry.resolve("dropme")).toMatchObject({
      ok: false,
      unavailable: { code: "provider-unavailable", provider: "dropme", reason: "unregistered" },
    });
  });

  it("unregisters Claude like any other provider — it is a plugin, not the floor", async () => {
    const registry = builtins();
    await registry.unregister("claude");
    expect(registry.list()).toEqual([]);
    expect(isKnownProvider("claude")).toBe(false);
  });

  it("refuses to shadow a taken id, so a live harness is never swapped underneath its sessions", () => {
    const registry = builtins();
    expect(() => registry.register(fakeHarness("claude"), descriptor("claude"))).toThrow(/already registered/);
    expect(providerFor("claude").label).toBe("Claude Code");
  });

  it("refuses a descriptor that names a different provider than its harness", () => {
    expect(() => builtins().register(fakeHarness("a"), descriptor("b"))).toThrow(/does not match/);
  });

  // #426: there is no fallback provider. Each of these used to answer Claude.
  it("answers an id nothing registered as unavailable — never as another provider", () => {
    expect(builtins().resolve("gemini")).toEqual({
      ok: false,
      unavailable: expect.objectContaining({ provider: "gemini", reason: "unregistered" }),
    });
  });

  it("answers no provider at all as unset", () => {
    expect(builtins().resolve(undefined)).toEqual({
      ok: false,
      unavailable: expect.objectContaining({ code: "provider-unavailable", reason: "unset" }),
    });
  });

  it("answers a registered provider whose runtime is missing as not installed — Claude included", () => {
    const registry = new HarnessRegistry({
      providers: [{ harness: fakeHarness("claude", false), descriptor: CLAUDE_PROVIDER }],
    });
    expect(registry.resolve("claude")).toEqual({
      ok: false,
      unavailable: expect.objectContaining({ provider: "claude", reason: "not-installed" }),
    });
  });
});
