import { describe, it, expect } from "vitest";
import { HarnessKindSchema } from "./common.js";
import {
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

/** Claude's shape, as its plugin registers it — shared no longer has a copy (#428). */
const claude: ProviderDescriptor = {
  ...opencode,
  id: "claude",
  label: "Claude Code",
  shortLabel: "Claude",
  defaultModel: "default",
  fallbackModels: [{ value: "default", label: "Default" }],
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

describe("providerAvailability — logged out (#428)", () => {
  const withLogin = (login: { checked: boolean; loggedIn: boolean; notRequired?: boolean }) => [
    { kind: "claude", runtime: { available: true }, login },
  ];

  it("refuses only a probe that ran and said no, naming the login command", () => {
    registerProvider({ ...claude, account: { ...claude.account, loginCommand: "claude auth login" } });
    expect(providerAvailability("claude", withLogin({ checked: true, loggedIn: false }))).toMatchObject({
      provider: "claude",
      reason: "logged-out",
      message: expect.stringContaining("claude auth login"),
    });
    unregisterProvider("claude");
  });

  it("never refuses on a probe that could not run, nothing to log into, or no probe yet", () => {
    expect(providerAvailability("claude", withLogin({ checked: false, loggedIn: false }))).toBeNull();
    expect(providerAvailability("claude", withLogin({ checked: true, loggedIn: false, notRequired: true }))).toBeNull();
    expect(providerAvailability("claude", [{ kind: "claude", runtime: { available: true } }])).toBeNull();
    expect(providerAvailability("claude", withLogin({ checked: true, loggedIn: true }))).toBeNull();
  });

  it("reports not-installed ahead of logged-out — installing comes first", () => {
    expect(
      providerAvailability("claude", [
        { kind: "claude", runtime: { available: false }, login: { checked: true, loggedIn: false } },
      ]),
    ).toMatchObject({ reason: "not-installed" });
  });
});

describe("provider registry", () => {
  // #428: Claude's descriptor was compiled in here, so every picker of an
  // install without Claude still offered "Claude Code".
  it("starts empty — every provider, Claude included, is registered by its plugin", () => {
    expect(providerIds()).toEqual([]);
    expect(isKnownProvider("claude")).toBe(false);
    expect(providerFor("claude")).toMatchObject({ id: "claude", label: "claude", unregistered: true });
  });

  it("answers NO provider with a placeholder, never Claude and never undefined (#426)", () => {
    // It used to answer `registry.get("claude")!` — undefined, and a crash in
    // every sender label, the moment Claude was not registered.
    for (const none of [undefined, null, ""]) {
      expect(providerFor(none)).toMatchObject({ id: "", label: "No provider", unregistered: true });
    }
  });

  it("drops a descriptor — a client must forget what the server stopped listing", () => {
    registerProvider(claude);
    expect(providerFor("claude").label).toBe("Claude Code");
    unregisterProvider("claude");
    expect(isKnownProvider("claude")).toBe(false);
    expect(providerFor("claude")).toMatchObject({ id: "claude", unregistered: true });
  });

  it("names an unregistered id after itself instead of passing it off as Claude", () => {
    // A row from a provider that has since been uninstalled.
    const ghost = providerFor("gemini");
    expect(ghost).toMatchObject({ id: "gemini", label: "gemini", unregistered: true });
    expect(isKnownProvider("gemini")).toBe(false);
  });

  it("registers a runtime provider into every list, after those already there", () => {
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
    registerProvider(claude);
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
