/**
 * THE MANAGER TOOLS, SERVED OVER HTTP.
 *
 * `mcp__manager__*` is Dispatch's own toolbox — wait, wait_for_chat,
 * context_usage, compact_context, watch_pr, approve_pr, terminal, remember /
 * recall / forget, run_subapp, and the MCP config editors. Every one of them
 * closes over live server objects (the TerminalService, the GitHubService, the
 * SessionBroker itself), so they were built as an IN-PROCESS MCP server: the
 * Agent SDK accepts `{ type: "sdk", instance }` and calls straight into it with
 * no transport at all.
 *
 * Codex cannot do that. It only speaks to MCP servers over stdio or streamable
 * HTTP. The naive fix — a separate `manager-mcp` binary — would mean every tool
 * re-implemented against an RPC boundary, i.e. a second copy of 1800 lines that
 * drifts from the first.
 *
 * So instead we keep ONE implementation and give it a second front door. The
 * same `createManagerMcpServer` factory produces an MCP `Server`; here we bolt a
 * `StreamableHTTPServerTransport` onto it and expose it on the Fastify server
 * Dispatch already runs. Claude keeps calling in-process; Codex dials
 * `http://127.0.0.1:<port>/api/mcp/manager` with a bearer token. Neither knows
 * the other exists, and a change to a tool lands in both at once.
 *
 * SECURITY. The endpoint drives real side effects (shells, merges, memory), so
 * it is not open just because it is on loopback — anything running as the user
 * could reach it. Every session mints a single-use-scope bearer token bound to
 * its chat; a request without a token that resolves to a live grant is refused
 * before any tool is constructed. Tokens die with their session.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { createManagerMcpServer, type ManagerMcpContext } from "./manager-mcp.js";

/** A minted grant: which chat's manager tools a token unlocks. */
interface Grant {
  chatId: string;
  /** Rebuilt per request so a tool always sees current service state. */
  context: () => ManagerMcpContext;
}

/** What a session needs to hand Codex. */
export interface ManagerMcpGrant {
  /** Bearer token value. */
  token: string;
  /** Name of the env var the token is passed through. */
  tokenEnvVar: string;
  /** Absolute URL of the streamable HTTP endpoint. */
  url: string;
  /** Drop the grant (called when the session disposes). */
  revoke: () => void;
}

/** Path the bridge is mounted at. */
export const MANAGER_MCP_PATH = "/api/mcp/manager";
/** Env var Codex reads the bearer token from. */
export const MANAGER_MCP_TOKEN_ENV = "DISPATCH_MANAGER_MCP_TOKEN";

export class ManagerMcpBridge {
  private readonly grants = new Map<string, Grant>();
  /** Loopback origin of this server, e.g. "http://127.0.0.1:4319". */
  private origin: string;

  constructor(origin = "http://127.0.0.1:4319") {
    this.origin = origin;
  }

  /** Called once the HTTP server knows its real port. */
  setOrigin(origin: string): void {
    this.origin = origin;
  }

  /** Mint a token for one session. */
  mint(chatId: string, context: () => ManagerMcpContext): ManagerMcpGrant {
    const token = randomBytes(24).toString("base64url");
    this.grants.set(token, { chatId, context });
    return {
      token,
      tokenEnvVar: MANAGER_MCP_TOKEN_ENV,
      url: `${this.origin}${MANAGER_MCP_PATH}`,
      revoke: () => this.grants.delete(token),
    };
  }

  /** Number of live grants (tests, diagnostics). */
  size(): number {
    return this.grants.size;
  }

  /** Resolve a bearer token, or undefined when it isn't ours. */
  resolve(header: string | undefined): Grant | undefined {
    if (!header) return undefined;
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    const token = m?.[1]?.trim();
    return token ? this.grants.get(token) : undefined;
  }

  /**
   * Serve one MCP request.
   *
   * Stateless: a fresh transport and a fresh server per request, with no MCP
   * session id. That costs a little setup per call but removes a whole class of
   * bug — a stale transport outliving the chat it belonged to — and manager
   * calls are rare compared to ordinary tool use. Long-running tools (`wait`,
   * `watch_pr`) simply hold their request open, which streamable HTTP is built
   * for.
   */
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
    authorization: string | undefined,
  ): Promise<void> {
    const grant = this.resolve(authorization);
    if (!grant) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const { instance } = createManagerMcpServer(grant.context()) as unknown as {
      instance: McpServer;
    };
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // Closing the transport must also close the server, or the pair leaks for
    // the lifetime of the process.
    // Both `.catch`ed: closing an already-torn-down stream rejects, and from a
    // socket 'close' handler there is no caller to receive that — it surfaced as
    // an unhandled rejection and killed the process.
    res.on("close", () => {
      void transport.close().catch(() => {});
      void instance.close().catch(() => {});
    });
    await instance.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}
