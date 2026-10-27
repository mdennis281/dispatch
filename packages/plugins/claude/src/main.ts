/**
 * The Claude plugin's server entry: register the provider. Everything
 * Claude-specific lives beside it — the Agent SDK is a dependency of this
 * package and of nothing else in Dispatch — so the host learns about Claude
 * only through what `register` hands over (#428).
 */
import type { PluginModule } from "@dispatch/shared";
import { ClaudeHarness } from "./index.js";
import { CLAUDE_PROVIDER } from "./descriptor.js";
import { makeFakeQuery } from "./fake-sdk.js";

const plugin: PluginModule = {
  activate(ctx) {
    if (!ctx.providers) throw new Error('the "providers" capability is missing from plugin.yaml');
    ctx.providers.register(createClaudeHarness(), CLAUDE_PROVIDER);
  },
};

/**
 * `DISPATCH_FAKE_SDK=1` (E2E and screenshot instances only) puts a
 * deterministic in-process echo behind the adapter: no `claude` subprocess, no
 * auth, no network. It lived in the server's container while Claude was
 * compiled in; the host cannot construct a `ClaudeHarness` any more, so the
 * switch moved to the one place that does. Usage is never polled under it —
 * the E2E instance must not reach Anthropic.
 */
export function createClaudeHarness(env: Readonly<Record<string, string | undefined>> = process.env): ClaudeHarness {
  if (env.DISPATCH_FAKE_SDK !== "1") return new ClaudeHarness();
  const harness = new ClaudeHarness({ query: makeFakeQuery() });
  harness.readLimits = async () => null;
  return harness;
}

export const { activate } = plugin;
