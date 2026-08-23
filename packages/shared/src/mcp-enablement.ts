/**
 * Whether a given MCP server actually runs — resolved across two layers.
 *
 * Every MCP server a session gets used to be all-or-nothing at its point of
 * declaration: an external server ran because it was in `mcpServers`, and the
 * bundled browser pair ran because `browser:` said so. Turning one OFF meant
 * deleting its declaration (and re-typing it later), and there was no way at all
 * to say "not on this machine" — the only lever was a committed file, so one
 * person's preference became everyone's.
 *
 * So enablement is its own axis, spelled the same way in both places it can be
 * set, and read through this one resolver:
 *
 *   - APP     — `AppSettings.mcpEnabled` in `config/`, never committed. "I don't
 *               want this here", across every project on this install.
 *   - PROJECT — `mcpEnabled` in `.dispatch/project.yaml`, committed. "This repo
 *               doesn't use that", for everyone who checks it out.
 *
 * Both are `Record<name, boolean>` rather than a disabled-LIST, because a list
 * can only ever subtract: a project could never re-enable something the app
 * turned off, which is exactly the case a two-layer system exists to serve. An
 * ABSENT key means "inherit" and is the reason the record is tri-state.
 *
 * Below both sits a per-server default the caller supplies — `true` for a server
 * somebody explicitly declared, and for the bundled browser servers whatever the
 * `browser:` auto-gate decided (see services/mcp/browser-mcp.ts). Which is why
 * this resolver takes the default as an argument instead of assuming one.
 */
import { MANAGER_SERVER_NAMES } from "./manager-tools.js";

/** A layer that can pin a server on or off. */
export type McpEnablementScope = "app" | "project";

/** Which layer decided, `default` when neither pinned it. */
export type McpEnablementSource = McpEnablementScope | "default";

/** The two settable layers, most specific last. Absent key ⇒ inherit. */
export interface McpEnablementLayers {
  /** `AppSettings.mcpEnabled` — this install, every project. */
  app?: Record<string, boolean>;
  /** `.dispatch/project.yaml` → `mcpEnabled` — this repo, everyone. */
  project?: Record<string, boolean>;
}

/** The resolved answer for one server, with every layer's value kept visible. */
export interface McpEnablement {
  /** What actually happens: is this server handed to the session? */
  effective: boolean;
  /** Which layer produced `effective`. */
  source: McpEnablementSource;
  /** The app layer's pin, if it has one. */
  app?: boolean;
  /** The project layer's pin, if it has one. */
  project?: boolean;
  /** What it would be with neither layer pinning it. */
  byDefault: boolean;
  /** True for a server no toggle may switch off (see {@link MCP_ALWAYS_ON}). */
  alwaysOn: boolean;
}

/**
 * Servers that ignore both layers.
 *
 * Dispatch's own `dispatch-*` servers are how an agent creates a PR, records
 * memory, drives a terminal — and how this very setting gets written. A UI that
 * offers to switch one off is offering to remove the tool that switches it back
 * on, so it doesn't.
 *
 * Derived from the registry rather than listed: a category added later is
 * always-on the moment it exists, instead of being quietly togglable until
 * somebody notices this line.
 */
export const MCP_ALWAYS_ON: readonly string[] = MANAGER_SERVER_NAMES;

/** True when no toggle may disable this server. */
export function isAlwaysOnMcpServer(name: string): boolean {
  return MCP_ALWAYS_ON.includes(name);
}

/**
 * Resolve one server's enablement. `byDefault` is what applies when neither
 * layer pinned it — `true` for anything explicitly declared, or the browser
 * auto-gate's verdict for the bundled pair.
 */
export function resolveMcpEnablement(
  name: string,
  layers: McpEnablementLayers | undefined,
  byDefault = true,
): McpEnablement {
  const app = layers?.app?.[name];
  const project = layers?.project?.[name];
  const alwaysOn = isAlwaysOnMcpServer(name);
  const base: Omit<McpEnablement, "effective" | "source"> = {
    ...(typeof app === "boolean" ? { app } : {}),
    ...(typeof project === "boolean" ? { project } : {}),
    byDefault,
    alwaysOn,
  };
  if (alwaysOn) return { ...base, effective: true, source: "default" };
  if (typeof project === "boolean") return { ...base, effective: project, source: "project" };
  if (typeof app === "boolean") return { ...base, effective: app, source: "app" };
  return { ...base, effective: byDefault, source: "default" };
}

/**
 * Drop every server the layers switched off.
 *
 * Used on the merged `mcpServers` record the broker hands the SDK, so a disabled
 * server is never SPAWNED — it isn't launched-then-hidden, and its tools cost no
 * context. Names here are all explicitly declared, so the default is `true`; the
 * bundled pair is filtered earlier, against its own auto-gate default.
 */
export function applyMcpEnablement<T>(
  servers: Record<string, T>,
  layers: McpEnablementLayers | undefined,
): Record<string, T> {
  if (!layers?.app && !layers?.project) return servers;
  const out: Record<string, T> = {};
  for (const [name, value] of Object.entries(servers)) {
    if (resolveMcpEnablement(name, layers).effective) out[name] = value;
  }
  return out;
}
