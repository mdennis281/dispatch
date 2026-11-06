/**
 * Where ONE MCP server runs for one chat — the precedence rule, kept pure so
 * the server (which acts on it) and the SPA (which will show it) agree.
 *
 *   chat `mcpLocations[name]` → the server's configured location → its default
 *
 * then `terminal` is replaced by the chat's default terminal location. What it
 * does NOT decide is whether that location can host the server right now: a
 * followed terminal location that cannot host processes keeps the server
 * local (the caller checks), and an explicitly named one never does.
 */
import { MCP_LOCATION_LOCAL, MCP_LOCATION_TERMINAL } from "./common.js";

export interface McpPlacementInput {
  /** The server's name in the session (`playwright`). */
  server: string;
  /** The chat's override map (`Chat.mcpLocations`). */
  chatOverrides?: Readonly<Record<string, string>>;
  /** The server's own setting: `mcpServers.<name>.location`, or `browser.location` for the bundled pair. */
  configured?: string;
  /** Used when neither says anything: `terminal` for the browser servers, `local` for the rest. */
  defaultLocation: string;
  /** The chat's default terminal location (`local`, or a backend id) — what `terminal` means. */
  terminalDefault: string;
}

export interface McpPlacement {
  /** `local`, or the terminal backend id to host the server on. */
  location: string;
  /**
   * True when the location was reached through `terminal` rather than named.
   * Such a placement quietly stays local when the backend cannot host a
   * process; a NAMED backend fails loudly instead.
   */
  followsTerminal: boolean;
}

export function resolveMcpPlacement(input: McpPlacementInput): McpPlacement {
  const asked =
    input.chatOverrides?.[input.server] ?? input.configured ?? input.defaultLocation;
  if (asked === MCP_LOCATION_TERMINAL) {
    return { location: input.terminalDefault || MCP_LOCATION_LOCAL, followsTerminal: true };
  }
  return { location: asked, followsTerminal: false };
}
