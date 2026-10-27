/**
 * Test-only: a registry holding just a Claude that reports itself installed.
 *
 * Given a scripted SDK `query`, that Claude is the REAL adapter over it: Claude
 * chats run through `ClaudeHarness` like every other provider (#427), so the
 * fake goes where the real SDK goes and every suite exercises the path
 * production takes. Without one it is a stub whose sessions throw, for suites
 * that never run a turn.
 *
 * Either way `runtime()` is pinned to "installed" and usage is never read, so
 * nothing in a test probes for a `claude` binary or calls Anthropic.
 *
 * Claude is a built-in PLUGIN now (#428), so this imports the plugin's BUILT
 * output (`@dispatch/plugin-claude/harness` resolves to `server/`) — build the
 * plugins before running the server suites, as for Codex and goose. It
 * registers the way the plugin does, descriptor and all, which is also what
 * makes `providerFor("claude")` answer "Claude Code" in these suites.
 *
 * A plain module, not an export from a test file — see `store/db.testkit.ts`
 * for why importing one test file from another double-runs it.
 */
import { CLAUDE_CAPABILITIES, ClaudeHarness, type QueryFn } from "@dispatch/plugin-claude/harness";
import { CLAUDE_PROVIDER } from "@dispatch/plugin-claude/descriptor";
import { HarnessRegistry } from "./index.js";
import type { Harness } from "./types.js";
import type { Store } from "../store/index.js";

export function claudeOnlyRegistry(query?: QueryFn): HarnessRegistry {
  return new HarnessRegistry({ providers: [{ harness: claudeTestHarness(query), descriptor: CLAUDE_PROVIDER }] });
}

/** The Claude {@link claudeOnlyRegistry} holds. */
export function claudeTestHarness(query?: QueryFn): Harness {
  if (query) {
    const harness = new ClaudeHarness({ query });
    harness.runtime = () => ({ kind: "claude", source: "bundled", available: true });
    harness.readLimits = async () => null;
    return harness;
  }
  return {
    kind: "claude",
    capabilities: CLAUDE_CAPABILITIES,
    runtime: () => ({ kind: "claude", source: "bundled", available: true }),
    listModels: async () => [],
    readLimits: async () => null,
    generateText: async () => "",
    createSession: () => {
      throw new Error("this suite runs no turns; pass claudeOnlyRegistry a scripted query");
    },
  } as unknown as Harness;
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
