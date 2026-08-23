/**
 * Streamable HTTP front door for Dispatch's own tools (used by Codex).
 *
 * One route, one path parameter: the category names which of the eight servers
 * to build. Registering eight routes would put the registry in a second place
 * and let it drift from the one in `@dispatch/shared`.
 */
import type { FastifyInstance } from "fastify";
import { MANAGER_MCP_ROUTE } from "../services/mcp/manager-http.js";

export function registerManagerMcpRoute(app: FastifyInstance): void {
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: MANAGER_MCP_ROUTE,
    handler: async (req, reply) => {
      reply.hijack();
      const { category } = req.params as { category?: string };
      await app.services.managerMcp.handle(
        req.raw,
        reply.raw,
        req.body,
        typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
        category,
      );
    },
  });
}
