/**
 * The goose plugin's server entry: register the provider. Everything
 * goose-specific lives beside it; the host learns about goose only through
 * what `register` hands over.
 */
import type { PluginModule } from "@dispatch/shared";
import { AcpHarness } from "./index.js";
import { GOOSE_PROVIDER } from "./descriptor.js";

const plugin: PluginModule = {
  activate(ctx) {
    if (!ctx.providers) throw new Error('the "providers" capability is missing from plugin.yaml');
    ctx.providers.register(new AcpHarness(), GOOSE_PROVIDER);
  },
};

export const { activate } = plugin;
