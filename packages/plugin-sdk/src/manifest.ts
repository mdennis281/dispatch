/**
 * `@dispatch/plugin-sdk/manifest` — the manifest schema and the host's plugin
 * constants, for TOOLING: a test that validates a generated plugin.yaml, a
 * script that checks a `dispatch:` range against `PLUGIN_API_VERSION`.
 *
 * Kept off the root entry on purpose: these are runtime values that carry
 * zod and the whole of @dispatch/shared with them, and the root entry is what
 * a plugin's bundled source imports (see index.ts).
 */
export {
  PLUGIN_API_VERSION,
  PLUGIN_MANIFEST_FILE,
  PLUGINS_DIR_NAME,
  PLUGIN_CAPABILITIES,
  PLUGIN_ID_PATTERN,
  PLUGIN_OAUTH_CLIENT_NAME_PATTERN,
  PLUGIN_PROCESS_ID_PATTERN,
  RESERVED_PLUGIN_ID_PREFIX,
  PluginManifestSchema,
  PluginIdSchema,
  PluginCapabilitySchema,
  PluginOAuthClientSchema,
  PluginProcessSchema,
  PluginProcessesFileSchema,
  PluginMcpServersFileSchema,
  PluginInfoSchema,
  PluginStatusSchema,
  pluginRangeAccepts,
  manifestPathDir,
} from "@dispatch/shared";
