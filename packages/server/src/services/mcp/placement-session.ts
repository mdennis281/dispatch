/**
 * Which of a session's MCP servers run on ANOTHER machine, and the stdio
 * entries the runtime gets for them instead. Called once per session build,
 * after the servers are merged and resolved and before the runtime sees them.
 * Every runtime (Claude, Codex, goose) is handed the same relay shim, because
 * stdio is the one transport all three treat alike.
 *
 * The rule itself is `resolveMcpPlacement` (shared). What this adds is the one
 * judgement that needs the live registry: a server FOLLOWING the terminal to a
 * backend that cannot host processes stays local, quietly. That is a plugin
 * that predates `spawnProcess`, not a fault. A server NAMING a backend is
 * relayed whatever its state, so every call says why it cannot run there
 * instead of a browser silently opening on the wrong machine.
 */
import {
  MCP_LOCATION_LOCAL,
  resolveMcpPlacement,
  type BrowserMcpConfig,
  type McpServerConfig,
} from "@dispatch/shared";
import { bundledProcessFor, isBrowserMcpServer, relayMcpServer } from "./browser-mcp.js";
import type { PlacedServerSpec } from "./placement.js";

export interface PlaceSessionMcpInput {
  chatId: string;
  projectId?: string;
  /** The session's working directory (its worktree, else the project checkout). */
  cwd: string;
  worktreePath?: string;
  /** The session's servers as the runtime would get them: merged, enabled, resolved. */
  servers: Record<string, McpServerConfig>;
  /** The same servers BEFORE resolution, which strips `location`. */
  declared: Record<string, McpServerConfig>;
  /** Names whose entry is still the bundled browser server, not a project's own of that name. */
  bundled: ReadonlySet<string>;
  browserConfig?: BrowserMcpConfig;
  /** `Chat.mcpLocations`. */
  chatOverrides?: Readonly<Record<string, string>>;
  /** The chat's default terminal location: `local` or a backend id. */
  terminalDefault: string;
  canHostProcesses(backendId: string): boolean;
  /** `McpPlacementService.place`. */
  place(backendId: string, spec: PlacedServerSpec): { token: string };
  socketPath: string;
  labelOf(backendId: string): string | undefined;
  /** A bundled server that could not be placed (its package is missing here). */
  onUnplaceable?: (name: string, reason: string) => void;
}

export interface PlacedMcpServer {
  name: string;
  backendId: string;
  label: string;
}

export function placeSessionMcpServers(input: PlaceSessionMcpInput): {
  servers: Record<string, McpServerConfig>;
  placed: PlacedMcpServer[];
} {
  const servers: Record<string, McpServerConfig> = {};
  const placed: PlacedMcpServer[] = [];
  for (const [name, resolved] of Object.entries(input.servers)) {
    servers[name] = resolved;
    // Only a stdio server is a process to host. A URL server is wherever its
    // URL says, and a `location` on one means nothing.
    if (!resolved.command) continue;
    const bundled = input.bundled.has(name) && isBrowserMcpServer(name);
    const { location, followsTerminal } = resolveMcpPlacement({
      server: name,
      chatOverrides: input.chatOverrides,
      configured: bundled ? input.browserConfig?.location : input.declared[name]?.location,
      defaultLocation: bundled ? "terminal" : MCP_LOCATION_LOCAL,
      terminalDefault: input.terminalDefault,
    });
    if (location === MCP_LOCATION_LOCAL) continue;
    if (followsTerminal && !input.canHostProcesses(location)) continue;

    const base = {
      chatId: input.chatId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      name,
      cwd: input.cwd,
      ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
    };
    let spec: PlacedServerSpec;
    if (bundled) {
      const proc = bundledProcessFor(name, input.browserConfig);
      if (!proc) {
        input.onUnplaceable?.(name, "its package is not installed on the Dispatch host");
        continue;
      }
      spec = { ...base, bundled: proc };
    } else {
      // A configured server runs over there exactly as written. Its `cwd` is
      // dropped: resolution stamped THIS machine's directory on it, and the
      // backend maps the chat's `cwd` itself.
      spec = {
        ...base,
        command: resolved.command,
        ...(resolved.args ? { args: [...resolved.args] } : {}),
        ...(resolved.env ? { env: { ...resolved.env } } : {}),
      };
    }
    const { token } = input.place(location, spec);
    servers[name] = {
      ...relayMcpServer({
        socketPath: input.socketPath,
        token,
        chatId: input.chatId,
        ...(spec.bundled ? { bundled: { backendId: location, process: spec.bundled } } : {}),
      }),
      cwd: input.cwd,
    };
    placed.push({ name, backendId: location, label: input.labelOf(location) ?? location });
  }
  return { servers, placed };
}

/**
 * The prompt section for a chat with servers on another machine. Without it
 * the agent opens `localhost:5173` in a browser that is not on the machine
 * its Bash and run_subapp work on, and reads "connection refused" as a broken
 * app.
 */
export function placedMcpNote(placed: readonly PlacedMcpServer[]): string | undefined {
  if (placed.length === 0) return undefined;
  const byHost = new Map<string, { label: string; names: string[] }>();
  for (const p of placed) {
    const row = byHost.get(p.backendId) ?? { label: p.label, names: [] };
    row.names.push(`\`${p.name}\``);
    byHost.set(p.backendId, row);
  }
  const lines = [...byHost.entries()].map(
    ([id, { label, names }]) => `- ${names.join(", ")} run on ${label} (\`${id}\`).`,
  );
  return [
    "Some of your MCP servers run on another machine, not on the Dispatch host:",
    ...lines,
    "",
    "A browser there loads pages AS THAT MACHINE: `localhost` is its own, so a dev server your " +
      "terminal started there answers on `localhost:<port>` as-is (the \"there\" URL under " +
      "Forwarded ports), while a server on the Dispatch " +
      "host (run_subapp, your Bash) is not reachable at its local URL. Files these tools save " +
      "are on that machine too.",
    "If the machine drops off, calls fail with an error that says so. Retry once it is back; " +
      "the server keeps running there, so open pages survive a short drop. A result that says " +
      "the server was RESTARTED means they did not.",
  ].join("\n");
}
