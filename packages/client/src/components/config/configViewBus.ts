/**
 * Decoupling seam for the Project config overlay — mirrors `mcpCatalogBus`. The
 * command palette and the top-bar affordance fire `cm:open-project-config`;
 * <ProjectConfigView> (mounted once in App) listens and opens itself. Trigger
 * sites never import the overlay, and the overlay owns its own open/close state.
 */
export const OPEN_PROJECT_CONFIG_EVENT = "cm:open-project-config";

/** Ask the app-wide Project config overlay to open. */
export function requestOpenProjectConfig(): void {
  window.dispatchEvent(new CustomEvent(OPEN_PROJECT_CONFIG_EVENT));
}
