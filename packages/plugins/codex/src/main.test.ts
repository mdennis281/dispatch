import { describe, expect, it } from "vitest";
import type { Harness, PluginContext, ProviderDescriptor } from "@dispatch/shared";
import { activate } from "./main.js";
import { CODEX_PROVIDER } from "./descriptor.js";
import { CodexHarness } from "./index.js";

describe("codex plugin activate", () => {
  it("registers its harness under its own descriptor", async () => {
    const registered: Array<{ harness: Harness; descriptor: ProviderDescriptor }> = [];
    const ctx = {
      providers: { register: (harness: Harness, descriptor: ProviderDescriptor) => registered.push({ harness, descriptor }) },
    } as unknown as PluginContext;
    await activate(ctx);
    expect(registered).toHaveLength(1);
    expect(registered[0]!.descriptor).toBe(CODEX_PROVIDER);
    expect(registered[0]!.harness).toBeInstanceOf(CodexHarness);
    // The host refuses a mismatch; say so here, where it is cheap to see.
    expect(registered[0]!.harness.kind).toBe(CODEX_PROVIDER.id);
  });

  it("names the missing capability instead of failing on an undefined", async () => {
    await expect(Promise.resolve().then(() => activate({} as PluginContext))).rejects.toThrow(/providers/);
  });
});
