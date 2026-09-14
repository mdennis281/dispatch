import { describe, it, expect } from "vitest";
import { DEFAULT_HARNESS, HarnessKindSchema } from "./common.js";
import {
  PROVIDERS,
  PROVIDER_IDS,
  defaultModelFor,
  fallbackModels,
  listProviders,
  providerFor,
} from "./providers.js";
import { HarnessSettingsSchema, providerDefaults } from "./runtime-config.js";

describe("provider registry", () => {
  it("has exactly one descriptor per provider id, keyed by its own id", () => {
    expect([...PROVIDER_IDS]).toEqual(HarnessKindSchema.options);
    for (const id of PROVIDER_IDS) expect(PROVIDERS[id].id).toBe(id);
    expect(listProviders().map((p) => p.id)).toEqual([...PROVIDER_IDS]);
  });

  it("resolves a legacy or unknown id to the default provider instead of throwing", () => {
    // A row written before `harness` existed, and one naming a provider since removed.
    expect(providerFor(undefined).id).toBe(DEFAULT_HARNESS);
    expect(providerFor("gemini").id).toBe(DEFAULT_HARNESS);
  });

  it("keeps each provider's default model and seed catalogue its own", () => {
    expect(defaultModelFor("claude")).toBe("default");
    // Codex has no alias; an unpinned chat sends no model at all.
    expect(defaultModelFor("codex")).toBeUndefined();
    expect(fallbackModels("codex").some((m) => m.value === "default")).toBe(false);
  });
});

describe("harness defaults", () => {
  it("still parses the per-field shape written before the registry", () => {
    const parsed = HarnessSettingsSchema.parse({
      defaultHarness: "codex",
      defaults: { claude: { model: "opus" }, codex: { effort: "high" } },
    });
    expect(providerDefaults(parsed, "claude").model).toBe("opus");
    expect(providerDefaults(parsed, "codex").effort).toBe("high");
  });

  it("carries per-provider reviewer defaults and answers {} for an unset provider", () => {
    const parsed = HarnessSettingsSchema.parse({
      defaults: { codex: { reviewer: { model: "gpt-6-astra", effort: "xhigh" } } },
    });
    expect(providerDefaults(parsed, "codex").reviewer).toEqual({
      model: "gpt-6-astra",
      effort: "xhigh",
    });
    expect(providerDefaults(parsed, "claude")).toEqual({});
    expect(providerDefaults(undefined, "claude")).toEqual({});
  });
});
