/**
 * MCP catalog view DTOs — the read-only shape returned by
 * `GET /api/projects/:projectId/mcp` and consumed by the client's MCP catalog
 * overlay. These are transient VIEW types (never persisted), so unlike the
 * entities in `domain.ts` they are plain interfaces rather than zod schemas —
 * the server assembles them by introspecting the in-process "manager" MCP and
 * probing each external server's `tools/list`.
 */
import type { McpEnablement } from "./mcp-enablement.js";

/** One flattened input parameter of a tool (derived from its JSON Schema). */
export interface McpToolParam {
  name: string;
  /** Human-readable JSON-Schema type (e.g. "string", "number", "array<string>"). */
  type: string;
  required: boolean;
  description?: string;
}

/** One MCP tool/endpoint exposed by a server. */
export interface McpToolInfo {
  /** Fully-qualified name the agent sees, e.g. "mcp__manager__wait". */
  qualifiedName: string;
  /** Bare tool name within its server, e.g. "wait". */
  name: string;
  description: string;
  /** The tool's input JSON Schema (draft 2020-12). */
  inputSchema: Record<string, unknown>;
  /** Flattened top-level parameters (from the JSON Schema `properties`). */
  params: McpToolParam[];
  /** Whether the session would actually OFFER this tool (broker gating). */
  available: boolean;
}

/**
 * Where a server came from.
 *
 *   custom   — in-process, built into this app (`manager`).
 *   bundled  — ships inside Dispatch and is injected on the project's behalf
 *              (the browser pair), so it has no entry in `mcpServers` to point
 *              at. It was invisible here until it had a kind of its own, which
 *              made "why can the agent call playwright?" unanswerable from the
 *              one screen that exists to answer it.
 *   external — declared by the project under `mcpServers`.
 */
export type McpServerKind = "custom" | "bundled" | "external";

/**
 * Probe outcome for one server. `unconfigured` = no transport to connect on;
 * `disabled` = switched off by an app or project toggle, so it was never probed
 * (a server nobody will run should not be spawned just to list its tools).
 */
export type McpServerStatus = "ok" | "error" | "unconfigured" | "disabled";

/** Sanitized transport descriptor (never carries env/headers/secrets). */
export interface McpServerTransport {
  type: "sdk" | "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
}

/** One server in the project's catalog (the custom manager + any external). */
export interface McpServerCatalogEntry {
  /** The server key (e.g. "manager" or a project-config server name). */
  name: string;
  kind: McpServerKind;
  transport?: McpServerTransport;
  status: McpServerStatus;
  /** Populated only when `status === "error"`. */
  error?: string;
  tools: McpToolInfo[];
  /**
   * Whether this server runs, and which layer decided — every layer's value
   * kept, so the UI can show the effective state AND which switch to flip.
   * A disabled entry is still listed: you cannot turn back on what you can't see.
   */
  enablement: McpEnablement;
  /** One line on where `byDefault` came from, when it isn't simply "declared". */
  defaultReason?: string;
}

/** The full per-project MCP catalog. */
export interface McpCatalog {
  servers: McpServerCatalogEntry[];
}
