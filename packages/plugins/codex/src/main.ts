/**
 * The Codex plugin's server entry: register the provider, release the shared
 * app-server connection on the way out. Everything Codex-specific lives beside
 * it; the host learns about Codex only through what `register` hands over.
 */
import type { PluginModule } from "@dispatch/shared";
import { CodexHarness } from "./index.js";
import { CODEX_PROVIDER } from "./descriptor.js";

const plugin: PluginModule = {
  activate(ctx) {
    if (!ctx.providers) throw new Error('the "providers" capability is missing from plugin.yaml');
    ctx.providers.register(new CodexHarness(), CODEX_PROVIDER);
  },
};

export const { activate } = plugin;
