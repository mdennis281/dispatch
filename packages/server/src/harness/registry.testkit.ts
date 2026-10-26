/**
 * Test-only: a registry holding just a Claude that reports itself installed.
 *
 * The broker suites drive Claude through an injected SDK `query`, and for years
 * built their broker with no registry at all — Claude was the fallback, so its
 * availability was never asked. It is asked now, for every provider (#426), so
 * those suites need a registry that answers "Claude is here". A stub rather
 * than the real `ClaudeHarness` so nothing in a test probes the SDK binary,
 * lists models or copies a session file the old registry-less broker never
 * touched.
 *
 * A plain module, not an export from a test file — see `store/db.testkit.ts`
 * for why importing one test file from another double-runs it.
 */
import { CLAUDE_CAPABILITIES } from "./claude/index.js";
import { HarnessRegistry } from "./index.js";
import type { Harness } from "./types.js";
import type { Store } from "../store/index.js";

export function claudeOnlyRegistry(): HarnessRegistry {
  const claude = {
    kind: "claude",
    capabilities: CLAUDE_CAPABILITIES,
    runtime: () => ({ kind: "claude", source: "bundled", available: true }),
    listModels: async () => [],
    readLimits: async () => null,
    generateText: async () => "",
    createSession: () => {
      throw new Error("the Claude path runs through the injected SDK query in tests");
    },
  } as unknown as Harness;
  return new HarnessRegistry({ harnesses: { claude } });
}

/**
 * Give an install an app-default provider, the way finishing setup does.
 *
 * Suites that create chats through `createChat` without naming a provider got
 * Claude for free when it was the default. There is no default now (#426), so
 * a bare store refuses those chats as "no provider is chosen" — which is the
 * right answer for a real install and the wrong thing for a suite to be about.
 */
export async function seedDefaultProvider(store: Store, provider = "claude"): Promise<void> {
  const current = await store.getSettings();
  await store.saveSettings({
    ...current,
    harness: { ...current.harness, defaults: current.harness?.defaults ?? {}, defaultHarness: provider },
  });
}
