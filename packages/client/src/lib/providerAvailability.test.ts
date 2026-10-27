/**
 * The client half of #426: a chat's "provider unavailable" state is derived
 * from `/api/harnesses`, so what matters here is that the list is read the way
 * the derivation assumes — the server's answer replaces the catalogue (it does
 * not just add to it), and "not asked yet" never reads as "nothing installed".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isKnownProvider,
  providerAvailability,
  registerProvider,
  type ProviderDescriptor,
} from "@dispatch/shared";
import { chatAvailability, refreshHarnesses } from "./providerAvailability.js";
import { useHarnesses } from "../stores/harnesses.js";
import { useModels } from "../stores/models.js";
import type { HarnessInfo } from "./api.js";

/** Claude as its plugin describes it; the bundle has no compiled-in copy (#428). */
const claudeDescriptor: ProviderDescriptor = {
  id: "claude",
  label: "Claude Code",
  shortLabel: "Claude",
  blurb: "Anthropic's agent CLI.",
  fallbackModels: [],
  efforts: [],
  subagents: true,
  skillsDir: ".claude",
  account: { configDirEnv: "CLAUDE_CONFIG_DIR", defaultConfigDir: ".claude", loginFile: ".credentials.json" },
};

const codex: HarnessInfo = {
  kind: "codex",
  runtime: { source: "installed", available: true },
  capabilities: {} as HarnessInfo["capabilities"],
  descriptor: { ...claudeDescriptor, id: "codex", label: "Codex", shortLabel: "Codex" },
};

function serve(list: HarnessInfo[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(list), { headers: { "content-type": "application/json" } })),
  );
}

beforeEach(() => {
  useHarnesses.setState({ harnesses: [], loaded: false });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("refreshHarnesses", () => {
  it("marks the list loaded, so an empty answer can finally mean 'nothing installed'", async () => {
    expect(useHarnesses.getState().loaded).toBe(false);
    serve([]);
    await refreshHarnesses();
    expect(useHarnesses.getState()).toMatchObject({ harnesses: [], loaded: true });
  });

  it("forgets a descriptor the server stopped listing — Claude included", async () => {
    // Learnt from an earlier answer, then the Claude plugin was switched off.
    registerProvider(claudeDescriptor);
    serve([codex]);
    await refreshHarnesses();
    expect(isKnownProvider("codex")).toBe(true);
    expect(isKnownProvider("claude")).toBe(false);
    expect(providerAvailability("claude", useHarnesses.getState().harnesses)).toMatchObject({
      reason: "unregistered",
    });
  });
});

describe("useModels", () => {
  it("starts empty — no Claude aliases offered before any provider answers", () => {
    expect(useModels.getState().models).toEqual([]);
  });

  it("empties for no provider instead of keeping the last chat's catalogue", () => {
    useModels.getState().setModels([{ value: "gpt-5", label: "GPT-5" }], "codex");
    useModels.getState().setModels([], undefined);
    expect(useModels.getState()).toMatchObject({ models: [], activeHarness: undefined });
  });
});

describe("chatAvailability", () => {
  const loggedOut = { checked: true, loggedIn: false };
  const loggedIn = { checked: true, loggedIn: true };
  registerProvider(codex.descriptor!);

  it("judges a chat by its OWN account's login, not the default account's (#440 review)", () => {
    // The default account is logged out; this chat is pinned to a working one.
    const list = [{ ...codex, login: loggedOut }];
    expect(chatAvailability("codex", list)).toMatchObject({ reason: "logged-out" });
    expect(chatAvailability("codex", list, { login: loggedIn })).toBeNull();
    // ...and the reverse: a fine default must not hide a logged-out pin.
    expect(chatAvailability("codex", [{ ...codex, login: loggedIn }], { login: loggedOut })).toMatchObject({
      reason: "logged-out",
    });
  });

  it("never calls an account with no probe yet logged out", () => {
    expect(chatAvailability("codex", [{ ...codex, login: loggedOut }], null)).toBeNull();
    expect(chatAvailability("codex", [{ ...codex, login: loggedOut }], {})).toBeNull();
  });

  it("still reports what has nothing to do with logins", () => {
    expect(chatAvailability("codex", [], { login: loggedIn })).toMatchObject({ reason: "unregistered" });
  });
});
