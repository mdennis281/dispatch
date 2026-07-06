/**
 * mcp-catalog — assemble the per-project MCP catalog the UI visualizes.
 *
 * The catalog reflects EXACTLY what a session gets in `SessionBroker.buildOptions`
 * (`{ ...projectMcpServers, manager }`):
 *
 *   - the in-process "manager" server, enumerated from {@link managerToolDescriptors}
 *     (the same tool definitions the SDK registers — one source, no drift), and
 *   - every external/passthrough server on the project's `mcpServers` config,
 *     probed over a short-timeout MCP `tools/list`.
 *
 * External probing is defensive: each server is connected in isolation with a
 * hard timeout, and ANY connect/list failure is captured as a `status:"error"`
 * entry — one bad server never fails the whole catalog. The transport is torn
 * down (child process killed / socket closed) whether the probe succeeds, errors,
 * or times out. The `probe` seam is injectable so tests can script outcomes
 * without spawning anything.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  McpCatalog,
  McpServerCatalogEntry,
  McpServerConfig,
  McpServerTransport,
  McpToolInfo,
  McpToolParam,
  Project,
} from "@cm/shared";
import { managerToolDescriptors } from "./manager-mcp.js";

/** Default per-server probe budget — bounds a hanging/slow external server. */
export const DEFAULT_PROBE_TIMEOUT_MS = 4_000;

/* --------------------------------------------------------- schema flatten */

/** Best-effort human-readable type for a JSON-Schema property. */
function jsonSchemaTypeLabel(prop: Record<string, unknown>): string {
  const t = prop.type;
  if (typeof t === "string") {
    if (t === "array") {
      const items = prop.items as Record<string, unknown> | undefined;
      const it = items && typeof items.type === "string" ? items.type : undefined;
      return it ? `array<${it}>` : "array";
    }
    return t;
  }
  if (Array.isArray(t)) {
    const types = t.filter((x): x is string => typeof x === "string");
    return types.length ? types.join(" | ") : "unknown";
  }
  if (Array.isArray(prop.enum)) return "enum";
  const variants = (prop.anyOf ?? prop.oneOf) as unknown;
  if (Array.isArray(variants)) {
    const types = variants.map((v) => {
      const vt = (v as Record<string, unknown> | null)?.type;
      return typeof vt === "string" ? vt : "?";
    });
    const uniq = [...new Set(types)];
    return uniq.join(" | ");
  }
  if (prop.const !== undefined) return "const";
  return "unknown";
}

/**
 * Flatten a tool's input JSON Schema `properties` into a `params[]` table
 * (name · type · required · description). Non-object / schema-less inputs → [].
 */
export function paramsFromJsonSchema(
  schema: Record<string, unknown> | undefined,
): McpToolParam[] {
  if (!schema || typeof schema !== "object") return [];
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props || typeof props !== "object") return [];
  const required = new Set(
    Array.isArray(schema.required)
      ? (schema.required as unknown[]).filter((x): x is string => typeof x === "string")
      : [],
  );
  return Object.entries(props).map(([name, prop]) => ({
    name,
    type: jsonSchemaTypeLabel(prop ?? {}),
    required: required.has(name),
    description: typeof prop?.description === "string" ? prop.description : undefined,
  }));
}

/* ------------------------------------------------------------- probing */

/** One tool as reported by an external server's `tools/list`. */
export interface RawMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Outcome of probing one external server. Never rejects for a connect failure. */
export interface McpProbeResult {
  status: "ok" | "error";
  error?: string;
  tools: RawMcpTool[];
}

/** The injectable external-server probe seam. */
export type McpProbe = (
  name: string,
  config: McpServerConfig,
  timeoutMs: number,
) => Promise<McpProbeResult>;

/** Reject if `fn` hasn't settled within `ms`. */
function withTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
    fn().then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * The real MCP probe: connect the configured transport, `tools/list`, tear down.
 * Prefers stdio (a `command`), else an HTTP/SSE `url`. Any failure resolves as
 * `{ status: "error", ... }` — it never throws.
 */
export const probeExternalMcpServer: McpProbe = async (_name, config, timeoutMs) => {
  let transport: Transport | undefined;
  let client: Client | undefined;
  try {
    if (config.command) {
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
        // Never let a child's stderr bleed into the manager's own logs.
        stderr: "ignore",
      });
    } else if (config.url) {
      const url = new URL(config.url);
      transport =
        config.type === "sse"
          ? new SSEClientTransport(url)
          : new StreamableHTTPClientTransport(url);
    } else {
      return { status: "error", error: "server has neither a command nor a url", tools: [] };
    }

    client = new Client(
      { name: "claude-manager-mcp-catalog", version: "0.1.0" },
      { capabilities: {} },
    );
    const c = client;
    const t = transport;
    const tools = await withTimeout(timeoutMs, async () => {
      await c.connect(t);
      const res = await c.listTools();
      return res.tools;
    });

    return {
      status: "ok",
      tools: tools.map((tool) => ({
        name: String(tool.name),
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
      })),
    };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      tools: [],
    };
  } finally {
    // Kill the child / close the socket regardless of outcome (incl. timeout).
    try {
      await client?.close();
    } catch {
      /* ignore */
    }
    try {
      await transport?.close();
    } catch {
      /* ignore */
    }
  }
};

/* ------------------------------------------------------------- assembly */

/** Sanitized transport descriptor (never leaks env/headers). */
function describeTransport(config: McpServerConfig): McpServerTransport {
  if (config.command) {
    return { type: "stdio", command: config.command, args: config.args };
  }
  if (config.url) {
    return { type: config.type === "sse" ? "sse" : "http", url: config.url };
  }
  return { type: config.type === "sse" ? "sse" : "http" };
}

async function buildExternalEntry(
  name: string,
  config: McpServerConfig,
  probe: McpProbe,
  timeoutMs: number,
): Promise<McpServerCatalogEntry> {
  const transport = describeTransport(config);
  // No transport to connect on → unconfigured (don't spawn/probe).
  if (!config.command && !config.url) {
    return { name, kind: "external", transport, status: "unconfigured", tools: [] };
  }
  const result: McpProbeResult = await probe(name, config, timeoutMs).catch((err) => ({
    status: "error" as const,
    error: err instanceof Error ? err.message : String(err),
    tools: [],
  }));
  if (result.status === "error") {
    return { name, kind: "external", transport, status: "error", error: result.error, tools: [] };
  }
  return {
    name,
    kind: "external",
    transport,
    status: "ok",
    tools: result.tools.map(
      (t): McpToolInfo => ({
        qualifiedName: `mcp__${name}__${t.name}`,
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        params: paramsFromJsonSchema(t.inputSchema),
        available: true,
      }),
    ),
  };
}

/** Options for {@link buildProjectMcpCatalog}. */
export interface BuildCatalogOptions {
  /** Which backing services the session has (gates manager tool availability). */
  bindings?: { github?: boolean; terminals?: boolean; memory?: boolean };
  /** Override the external probe (tests inject a scripted one). */
  probe?: McpProbe;
  /** Per-server probe timeout. */
  timeoutMs?: number;
  /**
   * The effective external servers to enumerate, OVERRIDING `project.mcpServers`.
   * The route passes the session's real merged set — the `.data` record layered
   * with the `.claude-manager/` config-sourced servers (config wins per-name) —
   * so the catalog reflects EXACTLY what a session gets in `buildOptions`.
   */
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * Build a project's full MCP catalog: the in-process "manager" server plus every
 * configured external server (probed in parallel, each isolated behind a timeout).
 */
export async function buildProjectMcpCatalog(
  project: Project,
  opts: BuildCatalogOptions = {},
): Promise<McpCatalog> {
  const probe = opts.probe ?? probeExternalMcpServer;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const managerEntry: McpServerCatalogEntry = {
    name: "manager",
    kind: "custom",
    transport: { type: "sdk" },
    status: "ok",
    tools: managerToolDescriptors(opts.bindings ?? {}).map(
      (d): McpToolInfo => ({
        qualifiedName: `mcp__manager__${d.name}`,
        name: d.name,
        description: d.description,
        inputSchema: d.inputSchema,
        params: paramsFromJsonSchema(d.inputSchema),
        available: d.available,
      }),
    ),
  };

  const external = (opts.mcpServers ??
    project.mcpServers ??
    {}) as Record<string, McpServerConfig>;
  const externalEntries = await Promise.all(
    Object.entries(external).map(([name, config]) =>
      buildExternalEntry(name, config, probe, timeoutMs),
    ),
  );

  return { servers: [managerEntry, ...externalEntries] };
}
