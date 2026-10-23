/**
 * Plugin discovery lives in the CLI core (`@dispatch/cli/core`), the same way
 * MCP config editing does, so `dispatch plugin add` validates a candidate with the
 * exact code the loader runs on it afterwards. Re-exported here so the rest of
 * the plugin host has one local import for it.
 */
export {
  discoverPlugins,
  discoverPluginsAt,
  readPluginDir,
  pluginsRoot,
  removePlugin,
  withoutCredentials,
  type DiscoveredPlugin,
} from "@dispatch/cli/core";
