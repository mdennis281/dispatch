/**
 * `@cm/cli/core` — the library face of the `cm` CLI.
 *
 * Everything the `cm mcp …` commands do is exported here so OTHER callers can do
 * exactly the same thing without shelling out. In particular the manager server
 * imports this module to back its `mcp__manager__mcp_add|mcp_list|mcp_remove`
 * tools, which is why the core is fs-only and free of any console/`process.exit`
 * coupling — all of that lives in `../commands/`.
 */
export {
  CmError,
  loadManifest,
  saveManifest,
  resolveProjectPaths,
  manifestJs,
  ensureConfigReadme,
  type LoadedManifest,
  type ProjectPaths,
} from "./manifest.js";

export {
  addServer,
  removeServer,
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
