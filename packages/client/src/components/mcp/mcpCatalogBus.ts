/**
 * Decoupling seam for the MCP catalog overlay — mirrors `projectPrsBus`. The
 * command palette and the top-bar affordance fire `cm:open-mcp-catalog`;
 * <McpCatalogView> (mounted once in App) listens and opens itself. Trigger sites
 * never import the overlay, and the overlay owns its own open/close state.
 */
export const OPEN_MCP_CATALOG_EVENT = "cm:open-mcp-catalog";

/** Ask the app-wide MCP catalog overlay to open. */
export function requestOpenMcpCatalog(): void {
  window.dispatchEvent(new CustomEvent(OPEN_MCP_CATALOG_EVENT));
}
