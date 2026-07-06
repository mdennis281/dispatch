/**
 * MCP catalog view DTOs — the read-only shape returned by
 * `GET /api/projects/:projectId/mcp` and consumed by the client's MCP catalog
 * overlay. These are transient VIEW types (never persisted), so unlike the
 * entities in `domain.ts` they are plain interfaces rather than zod schemas —
 * the server assembles them by introspecting the in-process "manager" MCP and
 * probing each external server's `tools/list`.
 */

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

/** Is this a built-in in-process server or an external/passthrough one? */
export type McpServerKind = "custom" | "external";

/** Probe outcome for one server. `unconfigured` = no transport to connect on. */
export type McpServerStatus = "ok" | "error" | "unconfigured";

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
}

/** The full per-project MCP catalog. */
export interface McpCatalog {
  servers: McpServerCatalogEntry[];
}
