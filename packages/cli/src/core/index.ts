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
  parseArgs,
  transportFromArgs,
  parseEnvPairs,
  parseHeaderPairs,
  flag,
  has,
  all,
  type ParsedArgs,
} from "./args.js";
