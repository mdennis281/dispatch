/**
 * mcp-config-editor — bind the `cm` CLI's config core to one project's repo.
 *
 * The manager's `mcp__manager__mcp_add|mcp_list|mcp_remove` tools and the `cm mcp`
 * terminal commands MUST produce identical config, so both go through the same
 * `@cm/cli/core` functions; this module is only the adapter that fixes the "which
 * project" argument and narrows the result to the shape the MCP tools consume.
 *
 * No reload plumbing is needed on this side: `ProjectConfigService` already
 * watches `.claude-manager/` and debounce-reloads on change, so a write here is
 * picked up for the next turn exactly like a hand edit or a `cm mcp add` would be.
 */
import { addServer, listServers, removeServer } from "@cm/cli/core";
import type { ManifestMcpServer } from "@cm/shared";
import type { ManagerMcpConfig } from "./manager-mcp.js";

/**
 * Build the per-session MCP-config binding for a project rooted at `repoPath`.
 *
 * `repoPath` should be the project's MAIN working copy rather than a session's
 * worktree: `.claude-manager/` is committed config, and an edit made in a
 * throwaway worktree would be discarded with it. The core still walks up from
 * whatever it's given, so a nested path resolves to the same manifest.
 */
export function createMcpConfigEditor(repoPath: string): ManagerMcpConfig {
  return {
    async list(): Promise<ManifestMcpServer[]> {
      const { servers } = await listServers(repoPath);
      return servers;
    },
    async add(server, opts) {
      const result = await addServer(repoPath, server, opts);
      return { outcome: result.outcome, manifestPath: result.paths.manifestPath };
    },
    async remove(name) {
      const { removed } = await removeServer(repoPath, name);
      return removed;
    },
  };
}
