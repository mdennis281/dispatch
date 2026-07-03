/**
 * Decoupling seam for the GLOBAL (project-wide) PRs overlay — mirrors the
 * window-event pattern panelBus uses for `requestFocusPanel`. The command palette
 * and the top-bar affordance fire `cm:open-project-prs`; <ProjectPRsView> (mounted
 * once in App) listens and opens itself. Trigger sites thus never import the
 * overlay, and the overlay owns its own open/close state.
 */
export const OPEN_PROJECT_PRS_EVENT = "cm:open-project-prs";

/** Ask the app-wide ProjectPRsView overlay to open. */
export function requestOpenProjectPrs(): void {
  window.dispatchEvent(new CustomEvent(OPEN_PROJECT_PRS_EVENT));
}
