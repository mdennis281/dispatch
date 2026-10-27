/**
 * The Claude boundary for Dispatch's own MCP tool servers.
 *
 * `createManagerMcpServers` builds plain MCP-SDK `McpServer`s so that Codex and
 * goose (HTTP) and the integration mount can serve them without the Claude
 * Agent SDK installed (#422/#423). Only Claude takes them in-process, and the
 * Agent SDK wants each one in its own config shape — so the wrap happens here,
 * on Claude's side of the seam, and nowhere in `services/mcp`.
 *
 * The Agent SDK only calls `instance.connect(transport)` on what it is given,
 * so an instance from our `@modelcontextprotocol/sdk` copy works even though
 * the Agent SDK bundles its own.
 */
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Server name (`dispatch-github`, …) → the in-process config the Agent SDK takes. */
export function claudeSdkMcpServers(
  servers: Record<string, McpServer>,
): Record<string, McpSdkServerConfigWithInstance> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, instance]) => [name, { type: "sdk", name, instance }]),
  );
}
