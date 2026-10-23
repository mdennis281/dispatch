import { describe, expect, it } from "vitest";
import type { Harness, PluginContext, ProviderDescriptor } from "@dispatch/shared";
import { activate } from "./main.js";
import { GOOSE_PROVIDER } from "./descriptor.js";
import { AcpHarness } from "./index.js";

describe("goose plugin activate", () => {
  it("registers its harness under its own descriptor", async () => {
    const registered: Array<{ harness: Harness; descriptor: ProviderDescriptor }> = [];
    const ctx = {
      providers: { register: (harness: Harness, descriptor: ProviderDescriptor) => registered.push({ harness, descriptor }) },
    } as unknown as PluginContext;
    await activate(ctx);
    expect(registered).toHaveLength(1);
    expect(registered[0]!.descriptor).toBe(GOOSE_PROVIDER);
    expect(registered[0]!.harness).toBeInstanceOf(AcpHarness);
    // The host refuses a mismatch; say so here, where it is cheap to see.
    expect(registered[0]!.harness.kind).toBe(GOOSE_PROVIDER.id);
  });

  it("names the missing capability instead of failing on an undefined", async () => {
    await expect(Promise.resolve().then(() => activate({} as PluginContext))).rejects.toThrow(/providers/);
  });
});

describe("AcpHarness.probeLogin", () => {
  it("has nothing to log into, and says so instead of shelling out", async () => {
    expect(await new AcpHarness().probeLogin()).toEqual({
      checked: true,
      loggedIn: true,
      notRequired: true,
      method: "local model",
    });
  });
});
