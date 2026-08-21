/**
 * mcp-catalog — assemble the per-project MCP catalog the UI visualizes.
 *
 * The catalog reflects EXACTLY what a session gets in `SessionBroker.buildOptions`
 * (`{ ...projectMcpServers, manager }`):
 *
 *   - the in-process "manager" server, enumerated from {@link managerToolDescriptors}
 *     (the same tool definitions the SDK registers — one source, no drift),
 *   - the BUNDLED servers Dispatch injects on the project's behalf (the browser
 *     pair) — 53 tools that every gated-in session has been getting while this
 *     view, the one place that claims to list them all, never named them, and
 *   - every external/passthrough server on the project's `mcpServers` config,
 *     probed over a short-timeout MCP `tools/list`.
 *
 * A server switched off by an app or project toggle is listed with its tools
 * empty and `status:"disabled"`, and is NOT probed — spawning a process to
 * enumerate tools nobody can call is pure cost. It stays visible because this
 * screen is also where you switch it back on.
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
import {
  resolveMcpEnablement,
  type McpCatalog,
  type McpEnablementLayers,
  type McpServerCatalogEntry,
  type McpServerConfig,
  type McpServerKind,
  type McpServerTransport,
  type McpToolInfo,
  type McpToolParam,
  type Project,
} from "@dispatch/shared";
import { managerToolDescriptors, type ManagerToolBindings } from "./manager-mcp.js";

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

/**
 * The injectable external-server probe seam. `cwd` is the directory a stdio
 * server is spawned in (the project repo, unless the server overrides it).
 */
export type McpProbe = (
  name: string,
  config: McpServerConfig,
  timeoutMs: number,
  cwd?: string,
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
export const probeExternalMcpServer: McpProbe = async (_name, config, timeoutMs, cwd) => {
  let transport: Transport | undefined;
  let client: Client | undefined;
  try {
    if (config.command) {
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
        // Spawn in the project repo (or the server's own override) — a config's
        // relative command/args are written relative to the repo, and without
        // this the child would inherit the MANAGER's cwd and die on startup.
        cwd: config.cwd ?? cwd,
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
      { name: "Dispatch-mcp-catalog", version: "0.1.0" },
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

/** One spawnable server to describe: an external declaration or a bundled one. */
interface SpawnableEntryInput {
  name: string;
  kind: Extract<McpServerKind, "bundled" | "external">;
  config: McpServerConfig;
  /** Enablement with neither layer pinning it (see {@link BundledCatalogServer}). */
  byDefault: boolean;
  defaultReason?: string;
  unavailable?: string;
}

async function buildSpawnableEntry(
  input: SpawnableEntryInput,
  layers: McpEnablementLayers | undefined,
  probe: McpProbe,
  timeoutMs: number,
  cwd: string | undefined,
): Promise<McpServerCatalogEntry> {
  const { name, kind, config } = input;
  const transport = describeTransport(config);
  const enablement = resolveMcpEnablement(name, layers, input.byDefault);
  const base = {
    name,
    kind,
    transport,
    enablement,
    ...(input.defaultReason ? { defaultReason: input.defaultReason } : {}),
  };

  // A server nobody will run is not worth spawning to interrogate. It is still
  // LISTED — with its toggle — because the catalog is where you go to turn it
  // back on, and an entry that vanished when switched off would strand it.
  if (!enablement.effective) return { ...base, status: "disabled", tools: [] };

  // Nothing on disk to spawn — say so rather than probing a command that isn't there.
  if (input.unavailable) {
    return { ...base, status: "error", error: input.unavailable, tools: [] };
  }

  // No transport to connect on → unconfigured (don't spawn/probe).
  if (!config.command && !config.url) {
    return { ...base, status: "unconfigured", tools: [] };
  }
  const result: McpProbeResult = await probe(name, config, timeoutMs, cwd).catch((err) => ({
    status: "error" as const,
    error: err instanceof Error ? err.message : String(err),
    tools: [],
  }));
  if (result.status === "error") {
    return { ...base, status: "error", error: result.error, tools: [] };
  }
  return {
    ...base,
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
  bindings?: ManagerToolBindings;
  /** Override the external probe (tests inject a scripted one). */
  probe?: McpProbe;
  /** Per-server probe timeout. */
  timeoutMs?: number;
  /**
   * The effective external servers to enumerate, OVERRIDING `project.mcpServers`.
   * The route passes the session's real merged set — the `.data` record layered
   * with the `.dispatch/` config-sourced servers (config wins per-name) —
   * so the catalog reflects EXACTLY what a session gets in `buildOptions`.
   */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Directory stdio servers are spawned in. Defaults to `project.repoPath` —
   * the same cwd a real session runs in — so a server configured with relative
   * paths probes exactly as it will launch.
   */
  cwd?: string;
  /**
   * The bundled servers Dispatch injects on this project's behalf — ALL of
   * them, including any a toggle has switched off, because the catalog has to
   * be able to offer them back.
   */
  bundled?: readonly BundledCatalogServer[];
  /** App + project `mcpEnabled` pins (see `mcp-enablement.ts`). */
  enablement?: McpEnablementLayers;
}

/** One bundled server, with what its own config block says before any toggle. */
export interface BundledCatalogServer {
  name: string;
  config: McpServerConfig;
  /** Enablement with neither layer pinning it — e.g. the `browser:` auto-gate. */
  byDefault: boolean;
  /** One line on why `byDefault` is what it is, shown beside the toggle. */
  defaultReason?: string;
  /**
   * Set when the server is selected but its npm package couldn't be resolved off
   * disk. Reported as an error entry WITHOUT probing — there is nothing to
   * spawn — because "its tools are silently missing" was previously visible only
   * as a line in the server log nobody reads.
   */
  unavailable?: string;
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
    // Resolved rather than hard-coded so the UI reads its always-on-ness off the
    // same rule the broker does, instead of a second copy of the exception.
    enablement: resolveMcpEnablement("manager", opts.enablement, true),
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
  const cwd = opts.cwd ?? project.repoPath;
  // A project may declare a server of the same name as a bundled one, in which
  // case its declaration wins outright in the broker's merge — so listing both
  // would show a bundled entry no session ever gets. Drop it here for the same
  // reason and by the same rule.
  const bundled = (opts.bundled ?? []).filter((b) => !(b.name in external));
  const inputs: SpawnableEntryInput[] = [
    ...bundled.map(
      (b): SpawnableEntryInput => ({
        name: b.name,
        kind: "bundled",
        config: b.config,
        byDefault: b.byDefault,
        ...(b.defaultReason ? { defaultReason: b.defaultReason } : {}),
        ...(b.unavailable ? { unavailable: b.unavailable } : {}),
      }),
    ),
    ...Object.entries(external).map(
      ([name, config]): SpawnableEntryInput => ({
        name,
        kind: "external",
        config,
        // Declared servers default ON: somebody wrote them down on purpose.
        byDefault: true,
      }),
    ),
  ];
  const entries = await Promise.all(
    inputs.map((input) => buildSpawnableEntry(input, opts.enablement, probe, timeoutMs, cwd)),
  );

  return { servers: [managerEntry, ...entries] };
}
