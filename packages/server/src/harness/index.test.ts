import { describe, expect, it } from "vitest";
import { isKnownProvider, providerFor, type ProviderDescriptor } from "@dispatch/shared";
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

const builtins = () => new HarnessRegistry({ harnesses: { claude: fakeHarness("claude") } });

const descriptor = (id: string): ProviderDescriptor => ({
  ...providerFor("claude"),
  id,
  label: `${id} label`,
  shortLabel: id,
});

describe("HarnessRegistry", () => {
  it("compiles in only Claude — every other provider arrives through register()", () => {
    expect(builtins().list().map((h) => h.kind)).toEqual(["claude"]);
  });

  it("adds a runtime provider to the registry AND the shared descriptor catalogue", () => {
    const registry = builtins();
    registry.register(fakeHarness("opencode"), descriptor("opencode"));
    expect(registry.find("opencode")?.kind).toBe("opencode");
    expect(registry.list().map((h) => h.kind)).toEqual(["claude", "opencode"]);
    expect(isKnownProvider("opencode")).toBe(true);
    expect(providerFor("opencode").label).toBe("opencode label");
    expect(registry.resolve("opencode")).toMatchObject({ fellBack: false });
  });

  it("registers the providers it is constructed with, as a plugin would", () => {
    const registry = new HarnessRegistry({
      harnesses: { claude: fakeHarness("claude") },
      providers: [{ harness: fakeHarness("ctor-made"), descriptor: descriptor("ctor-made") }],
    });
    expect(registry.find("ctor-made")).toBeDefined();
  });

  it("unregisters a provider, disposes its runtime, and falls back afterwards", async () => {
    let disposed = 0;
    const registry = builtins();
    registry.register(fakeHarness("dropme", true, () => (disposed += 1)), descriptor("dropme"));
    await registry.unregister("dropme");
    expect(disposed).toBe(1);
    expect(registry.find("dropme")).toBeUndefined();
    expect(isKnownProvider("dropme")).toBe(false);
    expect(registry.resolve("dropme")).toMatchObject({ fellBack: true });
  });

  it("refuses to unregister the built-in every fallback lands on", async () => {
    await expect(builtins().unregister("claude")).rejects.toThrow(/built-in/);
  });

  it("refuses to shadow a taken id, so nothing can replace the fallback", () => {
    const registry = builtins();
    expect(() => registry.register(fakeHarness("claude"), descriptor("claude"))).toThrow(/already registered/);
    // The live fallback is untouched.
    expect(providerFor("claude").label).toBe("Claude Code");
  });

  it("refuses a descriptor that names a different provider than its harness", () => {
    expect(() => builtins().register(fakeHarness("a"), descriptor("b"))).toThrow(/does not match/);
  });

  it("falls back to the default for an id nothing registered, and says so", () => {
    expect(builtins().resolve("gemini")).toMatchObject({ fellBack: true });
    expect(builtins().resolve("gemini").harness.kind).toBe("claude");
  });
});
