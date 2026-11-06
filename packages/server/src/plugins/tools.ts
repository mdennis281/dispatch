/**
 * `ctx.tools` — agent tools whose handler is a plugin's code.
 *
 * One registry for the process. A plugin registers into it; every session
 * built afterwards gets ONE MCP server per plugin with tools, named
 * `dispatch-plugin-<id>`, through the same channel as Dispatch's own servers
 * (`ManagerMcpContext.pluginTools`): in-process for Claude, the per-chat HTTP
 * bridge for Codex and goose. A plugin that contributed a stdio MCP server
 * instead would have to find its way back into Dispatch to reach its SSH
 * connections and would never learn which chat called; this runs in-process
 * and is told.
 *
 * The servers speak JSON Schema straight through — a plugin hands over plain
 * JSON, not a Zod shape — so they set the raw `tools/list` and `tools/call`
 * handlers rather than going through `McpServer.registerTool`.
 *
 * A call looks the tool up in the registry AT CALL TIME, never through a
 * closure captured at build: a session outlives the plugin version it was
 * built against (an update, a disable), and the old handler must not keep
 * running against a deactivated plugin's torn-down state.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  PLUGIN_TOOL_LIMITS,
  PLUGIN_TOOL_NAME_PATTERN,
  PLUGIN_TOOL_SERVER_PREFIX,
  isToolAllowed,
  normalizePluginToolResult,
  pluginToolError,
  pluginToolThrown,
  pluginToolQualifiedName,
  pluginToolServerName,
  type PluginTool,
  type PluginToolCall,
  type PluginToolInputSchema,
} from "@dispatch/shared";

interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: PluginToolInputSchema;
  handler: PluginTool["handler"];
  /** Identity, so an unregister from an earlier registration of the same name is a no-op. */
  token: symbol;
}

interface PluginEntry {
  /** The manifest's display name, for error text the agent reads. */
  name: string;
  tools: Map<string, RegisteredTool>;
}

/** Who is calling: the session the servers are built for. */
export interface PluginToolSession {
  chatId: string;
  projectId?: string;
  cwd?: string;
  /** The mode's policy. A denied tool is not listed, exactly as for Dispatch's own. */
  toolPolicy?: { allowedTools?: string[]; disallowedTools?: string[] };
  /** The session's signal: ends every call when the session does. */
  signal?: AbortSignal;
}

/**
 * The session's view of the registry, carried on `ManagerMcpContext`. Both
 * paths build from it: in-process takes every server at once, the HTTP bridge
 * one per request.
 */
export interface PluginToolsBinding {
  /** Every plugin server with at least one tool this session may call, by server name. */
  servers(): Record<string, McpServer>;
  /** One server by name, or undefined when that plugin has no tool this session may call. */
  server(serverName: string): McpServer | undefined;
}

const EMPTY_SCHEMA: PluginToolInputSchema = { type: "object", properties: {} };

export class PluginToolRegistry {
  private readonly plugins = new Map<string, PluginEntry>();

  /**
   * Add one tool. Throws on a bad definition — synchronously, from the
   * plugin's `activate()`, where its author sees it — rather than serving a
   * tool the runtime would refuse or truncate.
   */
  register(pluginId: string, pluginName: string, tool: PluginTool): () => void {
    const def = this.validate(pluginId, tool);
    let entry = this.plugins.get(pluginId);
    if (!entry) {
      entry = { name: pluginName, tools: new Map() };
      this.plugins.set(pluginId, entry);
    }
    if (entry.tools.has(def.name)) {
      throw new Error(`tools.register: "${def.name}" is already registered; unregister it first`);
    }
    if (entry.tools.size >= PLUGIN_TOOL_LIMITS.toolsPerPlugin) {
      throw new Error(`tools.register: at most ${PLUGIN_TOOL_LIMITS.toolsPerPlugin} tools per plugin`);
    }
    entry.tools.set(def.name, def);
    const owner = entry;
    return () => {
      if (owner.tools.get(def.name)?.token !== def.token) return;
      owner.tools.delete(def.name);
      if (!owner.tools.size && this.plugins.get(pluginId) === owner) this.plugins.delete(pluginId);
    };
  }

  /** Drop every tool a plugin registered (its deactivation). */
  unregisterAll(pluginId: string): void {
    this.plugins.delete(pluginId);
  }

  /** The tools a plugin has registered now, by name (diagnostics, tests). */
  list(pluginId: string): string[] {
    return [...(this.plugins.get(pluginId)?.tools.keys() ?? [])].sort();
  }

  /** Bind the registry to one session. */
  bind(session: PluginToolSession): PluginToolsBinding {
    return {
      servers: () => {
        const out: Record<string, McpServer> = {};
        for (const pluginId of [...this.plugins.keys()].sort()) {
          const server = this.buildServer(pluginId, session);
          if (server) out[pluginToolServerName(pluginId)] = server;
        }
        return out;
      },
      server: (serverName) => {
        if (!serverName.startsWith(PLUGIN_TOOL_SERVER_PREFIX)) return undefined;
        return this.buildServer(serverName.slice(PLUGIN_TOOL_SERVER_PREFIX.length), session);
      },
    };
  }

  private allowed(pluginId: string, session: PluginToolSession): RegisteredTool[] {
    const entry = this.plugins.get(pluginId);
    if (!entry) return [];
    return [...entry.tools.values()]
      .filter((t) => isToolAllowed(pluginToolQualifiedName(pluginId, t.name), session.toolPolicy))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private buildServer(pluginId: string, session: PluginToolSession): McpServer | undefined {
    // Absent rather than empty: a server that lists nothing reads to a runtime
    // as a working integration with no tools — the bridge's own rule.
    if (!this.allowed(pluginId, session).length) return undefined;
    const server = new McpServer({ name: pluginToolServerName(pluginId), version: "1.0.0" });
    server.server.registerCapabilities({ tools: {} });
    // Listed live as well: the HTTP bridge builds per request, so a tool
    // registered or dropped since the session started shows up here.
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.allowed(pluginId, session).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }));
    server.server.setRequestHandler(CallToolRequestSchema, (req, extra) =>
      this.call(pluginId, req.params.name, req.params.arguments, session, extra.signal),
    );
    return server;
  }

  private async call(
    pluginId: string,
    name: string,
    args: unknown,
    session: PluginToolSession,
    callSignal: AbortSignal,
  ): Promise<CallToolResult> {
    const entry = this.plugins.get(pluginId);
    const tool = entry?.tools.get(name);
    // Looked up NOW. The session may predate a disable or an update.
    if (!entry || !tool) {
      return errorResult(
        `The tool ${name} is no longer available: the plugin ${pluginId} is not active, or no longer offers it. Do not retry.`,
      );
    }
    // The policy again, not just at list time: a runtime can call a name it
    // was never listed (a cached list, a guess), and absence is the gate.
    if (!isToolAllowed(pluginToolQualifiedName(pluginId, name), session.toolPolicy)) {
      return errorResult(`The tool ${name} is not allowed in this chat's mode.`);
    }
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      return errorResult(`${name}: arguments must be an object.`);
    }
    const signal = session.signal ? AbortSignal.any([callSignal, session.signal]) : callSignal;
    const call: PluginToolCall = {
      chatId: session.chatId,
      ...(session.projectId ? { projectId: session.projectId } : {}),
      ...(session.cwd ? { cwd: session.cwd } : {}),
      signal,
    };
    try {
      const out = await tool.handler({ ...(args as Record<string, unknown> | undefined) }, call);
      return normalizePluginToolResult(out, entry.name) as CallToolResult;
    } catch (err) {
      // The plugin's failure is the CALL's result, never the session's: an
      // exception escaping here would surface as a protocol error, which some
      // runtimes treat as the server being broken.
      return pluginToolThrown(err, entry.name) as CallToolResult;
    }
  }

  private validate(pluginId: string, tool: PluginTool): RegisteredTool {
    if (!tool || typeof tool !== "object") throw new Error("tools.register: a tool is an object");
    const { name, description, inputSchema, handler } = tool;
    if (typeof name !== "string" || !PLUGIN_TOOL_NAME_PATTERN.test(name)) {
      throw new Error(`tools.register: name must match ${PLUGIN_TOOL_NAME_PATTERN} (lower snake case)`);
    }
    const qualified = pluginToolQualifiedName(pluginId, name);
    if (qualified.length > PLUGIN_TOOL_LIMITS.qualifiedNameLength) {
      throw new Error(
        `tools.register: "${qualified}" is ${qualified.length} characters; the agent-facing name may be at most ` +
          `${PLUGIN_TOOL_LIMITS.qualifiedNameLength} (Codex refuses longer). Shorten "${name}".`,
      );
    }
    if (typeof description !== "string" || !description.trim()) {
      throw new Error(`tools.register: ${name} needs a description — it is what the model reads to call it`);
    }
    if (description.length > PLUGIN_TOOL_LIMITS.descriptionLength) {
      throw new Error(`tools.register: ${name}'s description is over ${PLUGIN_TOOL_LIMITS.descriptionLength} characters`);
    }
    if (typeof handler !== "function") throw new Error(`tools.register: ${name} needs a handler`);
    let schema = EMPTY_SCHEMA;
    if (inputSchema !== undefined) {
      if (!inputSchema || typeof inputSchema !== "object" || inputSchema.type !== "object") {
        throw new Error(`tools.register: ${name}'s inputSchema must be a JSON Schema with type "object"`);
      }
      // A copy through JSON: what is served is plain data, and a schema that
      // cannot be serialized fails here rather than on the first tools/list.
      try {
        schema = JSON.parse(JSON.stringify(inputSchema)) as PluginToolInputSchema;
      } catch {
        throw new Error(`tools.register: ${name}'s inputSchema is not JSON`);
      }
    }
    return { name, description, inputSchema: schema, handler, token: Symbol(name) };
  }
}

function errorResult(text: string): CallToolResult {
  return pluginToolError(text) as CallToolResult;
}
