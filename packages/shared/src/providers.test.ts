import { describe, it, expect } from "vitest";
import { BUILTIN_HARNESS_KINDS, HarnessKindSchema } from "./common.js";
import {
  BUILTIN_PROVIDERS,
  defaultModelFor,
  fallbackModels,
  isKnownProvider,
  listProviders,
  providerAvailability,
  providerFor,
  providerIds,
  registerProvider,
  unregisterProvider,
  type ProviderDescriptor,
} from "./providers.js";
import { SubscriptionSchema, resolveSubscriptions } from "./subscriptions.js";
import { HarnessSettingsSchema, providerDefaults } from "./runtime-config.js";

const opencode: ProviderDescriptor = {
  id: "opencode",
  label: "OpenCode",
  shortLabel: "OpenCode",
  blurb: "A provider registered at runtime.",
  fallbackModels: [],
  efforts: [],
  subagents: false,
  skillsDir: ".agents",
  account: { configDirEnv: "OPENCODE_HOME", defaultConfigDir: ".opencode", loginFile: "auth.json" },
};

describe("providerAvailability", () => {
  const live = [{ kind: "claude", runtime: { available: true } }];

  it("is null exactly when the provider is registered and its runtime is present", () => {
    expect(providerAvailability("claude", live)).toBeNull();
  });

  it("names why it cannot run: unset, unregistered, not installed", () => {
    expect(providerAvailability(undefined, live)).toMatchObject({
      code: "provider-unavailable",
      reason: "unset",
    });
    expect(providerAvailability("codex", live)).toMatchObject({
      code: "provider-unavailable",
      provider: "codex",
      reason: "unregistered",
    });
    expect(
      providerAvailability("claude", [{ kind: "claude", runtime: { available: false } }]),
    ).toMatchObject({ provider: "claude", reason: "not-installed" });
  });
});

describe("provider registry", () => {
  it("starts with exactly the built-ins, each keyed by its own id", () => {
    expect(providerIds().slice(0, BUILTIN_HARNESS_KINDS.length)).toEqual([...BUILTIN_HARNESS_KINDS]);
    for (const id of BUILTIN_HARNESS_KINDS) expect(BUILTIN_PROVIDERS[id].id).toBe(id);
  });

  it("answers NO provider with a placeholder, never Claude and never undefined (#426)", () => {
    // It used to answer `registry.get("claude")!` — undefined, and a crash in
    // every sender label, the moment Claude was not registered.
    for (const none of [undefined, null, ""]) {
      expect(providerFor(none)).toMatchObject({ id: "", label: "No provider", unregistered: true });
    }
  });

  it("lets a built-in descriptor be dropped — a client must forget what the server stopped listing", () => {
    unregisterProvider("claude");
    try {
      expect(isKnownProvider("claude")).toBe(false);
      expect(providerFor("claude")).toMatchObject({ id: "claude", unregistered: true });
    } finally {
      registerProvider(BUILTIN_PROVIDERS.claude);
    }
  });

  it("names an unregistered id after itself instead of passing it off as Claude", () => {
    // A row from a provider that has since been uninstalled.
    const ghost = providerFor("gemini");
    expect(ghost).toMatchObject({ id: "gemini", label: "gemini", unregistered: true });
    expect(isKnownProvider("gemini")).toBe(false);
  });

  it("registers a runtime provider into every list after the built-ins", () => {
    registerProvider(opencode);
    expect(isKnownProvider("opencode")).toBe(true);
    expect(providerFor("opencode").label).toBe("OpenCode");
    expect(providerIds().at(-1)).toBe("opencode");
    expect(listProviders().map((p) => p.id)).toEqual(providerIds());
    // ...and gets an implicit account like any built-in.
    expect(resolveSubscriptions(null).some((s) => s.provider === "opencode" && s.implicit)).toBe(true);
  });

  it("refuses an id the schema would not persist, and a placeholder", () => {
    expect(() => registerProvider({ ...opencode, id: "Open Code" })).toThrow(/invalid provider id/);
    expect(() => registerProvider(providerFor("gemini"))).toThrow(/placeholder/);
  });

  it("still parses stored rows that name a provider nothing registers", () => {
    // The closed enum this replaced failed these parses, and with them the
    // whole settings file — uninstalling a provider bricked every chat on it.
    expect(HarnessKindSchema.parse("gemini")).toBe("gemini");
    expect(SubscriptionSchema.parse({ id: "g", name: "G", provider: "gemini" }).provider).toBe("gemini");
    const settings = HarnessSettingsSchema.parse({
      defaultHarness: "gemini",
      defaults: { gemini: { model: "x" } },
    });
    expect(providerDefaults(settings, "gemini").model).toBe("x");
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
