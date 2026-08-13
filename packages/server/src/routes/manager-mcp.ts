/** Streamable HTTP front door for Dispatch's manager tools (used by Codex). */
import type { FastifyInstance } from "fastify";
import { MANAGER_MCP_PATH } from "../services/mcp/manager-http.js";

export function registerManagerMcpRoute(app: FastifyInstance): void {
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: MANAGER_MCP_PATH,
    handler: async (req, reply) => {
      reply.hijack();
      await app.services.managerMcp.handle(
        req.raw,
        reply.raw,
        req.body,
        typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
      );
    },
  });
}
