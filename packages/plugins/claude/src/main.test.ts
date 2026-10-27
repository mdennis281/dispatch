import { describe, expect, it } from "vitest";
import type { Harness, PluginContext, ProviderDescriptor } from "@dispatch/shared";
import { activate, createClaudeHarness } from "./main.js";
import { CLAUDE_PROVIDER } from "./descriptor.js";
import { ClaudeHarness } from "./index.js";

describe("claude plugin activate", () => {
  it("registers its harness under its own descriptor", async () => {
    const registered: Array<{ harness: Harness; descriptor: ProviderDescriptor }> = [];
    const ctx = {
      providers: { register: (harness: Harness, descriptor: ProviderDescriptor) => registered.push({ harness, descriptor }) },
    } as unknown as PluginContext;
    await activate(ctx);
    expect(registered).toHaveLength(1);
    expect(registered[0]!.descriptor).toBe(CLAUDE_PROVIDER);
    expect(registered[0]!.harness).toBeInstanceOf(ClaudeHarness);
    // The host refuses a mismatch; say so here, where it is cheap to see.
    expect(registered[0]!.harness.kind).toBe(CLAUDE_PROVIDER.id);
  });

  it("names the missing capability instead of failing on an undefined", async () => {
    await expect(Promise.resolve().then(() => activate({} as PluginContext))).rejects.toThrow(/providers/);
  });
});

describe("createClaudeHarness", () => {
  it("puts the E2E echo behind the adapter under DISPATCH_FAKE_SDK, and never reads usage", async () => {
    // The E2E and screenshot instances run on this; they must spawn no
    // `claude` and send nothing to Anthropic.
    const harness = createClaudeHarness({ DISPATCH_FAKE_SDK: "1" });
    expect(await harness.generateText({ prompt: "hi", purpose: "title" })).toBe("Echo: hi");
    expect(await harness.readLimits()).toBeNull();
  });
});
