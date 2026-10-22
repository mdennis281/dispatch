import { describe, expect, it } from "vitest";
import { isKnownProvider, providerFor, type ProviderDescriptor } from "@dispatch/shared";
import { HarnessRegistry } from "./index.js";
import type { Harness } from "./types.js";

/** Just enough of a harness for the registry, which only reads kind and runtime. */
function fakeHarness(kind: string, available = true): Harness {
  return {
    kind,
    capabilities: {} as Harness["capabilities"],
    runtime: () => ({ kind, source: "installed", available }),
    listModels: async () => [],
  } as unknown as Harness;
}

const builtins = () =>
  new HarnessRegistry({
    harnesses: { claude: fakeHarness("claude"), codex: fakeHarness("codex"), goose: fakeHarness("goose") },
  });

const descriptor = (id: string): ProviderDescriptor => ({
  ...providerFor("codex"),
  id,
  label: `${id} label`,
  shortLabel: id,
});

describe("HarnessRegistry.register", () => {
  it("adds a runtime provider to the registry AND the shared descriptor catalogue", () => {
    const registry = builtins();
    registry.register(fakeHarness("opencode"), descriptor("opencode"));
    expect(registry.find("opencode")?.kind).toBe("opencode");
    expect(registry.list().map((h) => h.kind)).toEqual(["claude", "codex", "goose", "opencode"]);
    expect(isKnownProvider("opencode")).toBe(true);
    expect(providerFor("opencode").label).toBe("opencode label");
    expect(registry.resolve("opencode")).toMatchObject({ fellBack: false });
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
