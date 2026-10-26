/**
 * The client half of #426: a chat's "provider unavailable" state is derived
 * from `/api/harnesses`, so what matters here is that the list is read the way
 * the derivation assumes — the server's answer replaces the catalogue (it does
 * not just add to it), and "not asked yet" never reads as "nothing installed".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_PROVIDERS,
  isKnownProvider,
  providerAvailability,
  registerProvider,
} from "@dispatch/shared";
import { refreshHarnesses } from "./providerAvailability.js";
import { useHarnesses } from "../stores/harnesses.js";
import { useModels } from "../stores/models.js";
import type { HarnessInfo } from "./api.js";

const codex: HarnessInfo = {
  kind: "codex",
  runtime: { source: "installed", available: true },
  capabilities: {} as HarnessInfo["capabilities"],
  descriptor: { ...BUILTIN_PROVIDERS.claude, id: "codex", label: "Codex", shortLabel: "Codex" },
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
  // Module-level catalogue: put back what other suites expect to find.
  registerProvider(BUILTIN_PROVIDERS.claude);
});

describe("refreshHarnesses", () => {
  it("marks the list loaded, so an empty answer can finally mean 'nothing installed'", async () => {
    expect(useHarnesses.getState().loaded).toBe(false);
    serve([]);
    await refreshHarnesses();
    expect(useHarnesses.getState()).toMatchObject({ harnesses: [], loaded: true });
  });

  it("forgets a descriptor the server stopped listing — the compiled-in Claude included", async () => {
    serve([codex]);
    await refreshHarnesses();
    expect(isKnownProvider("codex")).toBe(true);
    // Claude is compiled into this bundle, but this server does not offer it.
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
