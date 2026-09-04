/**
 * mcp-config-editor — bind the `dispatch` CLI's config core to one project's repo.
 *
 * The manager's `mcp__dispatch-mcp__mcp_add|mcp_list|mcp_remove` tools and the `dispatch mcp`
 * terminal commands MUST produce identical config, so both go through the same
 * `@dispatch/cli/core` functions; this module is only the adapter that fixes the "which
 * project" argument and narrows the result to the shape the MCP tools consume.
 *
 * No reload plumbing is needed on this side: `ProjectConfigService` already
 * watches `.dispatch/` and debounce-reloads on change, so a write here is
 * picked up for the next turn exactly like a hand edit or a `dispatch mcp add` would be.
 */
import { addServer, listServers, removeServer } from "@dispatch/cli/core";
import type { ManifestMcpServer } from "@dispatch/shared";
import type { ProjectPaths } from "@dispatch/cli/core";
import type { ManagerMcpConfig } from "./manager-mcp.js";

/**
 * Build the per-session MCP-config binding for a project's config dir.
 *
 * `configPaths` is resolved by the caller because only it knows whether this
 * project keeps its config in the repo or in the install's own config root — the
 * walk-up the core does for a bare path can only ever find the former, so an
 * external project handed a repo path would get a `.dispatch/` created in its
 * working tree instead of an edit to the manifest it actually uses.
 *
 * When the config IS in the repo it must be the MAIN working copy's rather than
 * a session worktree's: committed config edited in a throwaway worktree is
 * discarded with it.
 */
export function createMcpConfigEditor(configPaths: ProjectPaths): ManagerMcpConfig {
  return {
    async list(): Promise<ManifestMcpServer[]> {
      const { servers } = await listServers(configPaths);
      return servers;
    },
    async add(server, opts) {
      const result = await addServer(configPaths, server, opts);
      return { outcome: result.outcome, manifestPath: result.paths.manifestPath };
    },
    async remove(name) {
      const { removed } = await removeServer(configPaths, name);
      return removed;
    },
  };
}
