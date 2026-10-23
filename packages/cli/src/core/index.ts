/**
 * `@dispatch/cli/core` — the library face of the `dispatch` CLI.
 *
 * Everything the `dispatch mcp …` commands do is exported here so OTHER callers can do
 * exactly the same thing without shelling out. In particular the manager server
 * imports this module to back its `mcp__dispatch-mcp__mcp_add|mcp_list|mcp_remove`
 * tools, which is why the core is fs-only and free of any console/`process.exit`
 * coupling — all of that lives in `../commands/`.
 */
export {
  CmError,
  loadManifest,
  saveManifest,
  configDirFor,
  resolveProjectPaths,
  pathsForConfigDir,
  manifestJs,
  ensureConfigReadme,
  type LoadedManifest,
  type ProjectPaths,
} from "./manifest.js";

export {
  addServer,
  removeServer,
  setServerEnabled,
  listServers,
  getServer,
  importServers,
  describeTransport,
  assertValidServerName,
  mcpJsonEntryToTransport,
  type AddOutcome,
  type AddResult,
  type ImportEntry,
  type McpJsonShape,
} from "./mcp.js";

export {
  pluginsRoot,
  readPluginDir,
  discoverPlugins,
  discoverPluginsAt,
  addPlugin,
  linkPlugin,
  removePlugin,
  setPluginEnabled,
  setPluginSource,
  updatePluginEntry,
  readPluginEntries,
  readPluginToggles,
  consentLines,
  looksLikeGitUrl,
  withoutCredentials,
  type DiscoveredPlugin,
  type InstallResult,
} from "./plugins.js";

export {
  checkPluginUpdates,
  updatePlugins,
  purgePluginData,
  pluginSurface,
  realGitDeps,
  type GitDeps,
  type CliUpdateCheck,
  type CliUpdateOutcome,
  type PurgeResult,
} from "./plugin-lifecycle.js";

export {
  initPlugin,
  scaffoldFiles,
  defaultSdkPath,
  type InitPluginOptions,
  type InitPluginResult,
  type PluginScaffoldKind,
} from "./plugin-init.js";

export {
  parseArgs,
  transportFromArgs,
  parseEnvPairs,
  parseHeaderPairs,
  flag,
  has,
  all,
  type ParsedArgs,
} from "./args.js";

export {
  INTEGRATION_TOKENS_FILE,
  integrationTokensPath,
  generateIntegrationToken,
  hashIntegrationToken,
  isIntegrationTokenShape,
  summarizeIntegrationToken,
  readIntegrationTokenFile,
  writeIntegrationTokenFile,
  withIntegrationTokenLock,
  validateIntegrationTokenRequest,
  mintIntegrationToken,
  listIntegrationTokens,
  revokeIntegrationToken,
  parseExpiry,
  type StoredIntegrationToken,
  type IntegrationTokenFile,
  type MintOptions,
} from "./integration-tokens.js";
