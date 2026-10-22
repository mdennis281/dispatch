/**
 * Streamable HTTP front door for Dispatch's own tools (used by Codex).
 *
 * One route, one path parameter: the category names which of the eight servers
 * to build. Registering eight routes would put the registry in a second place
 * and let it drift from the one in `@dispatch/shared`.
 */
import type { FastifyInstance } from "fastify";
import { INTEGRATION_MCP_ROUTE, MANAGER_MCP_ROUTE } from "../services/mcp/manager-http.js";
import { integrationIdentity } from "../services/integration-tokens.js";

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

  // The integration mount. Authenticated by the global gate (a `dsp_` bearer),
  // scoped per category inside the handler — see `handleIntegration`.
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: INTEGRATION_MCP_ROUTE,
    handler: async (req, reply) => {
      reply.hijack();
      const { category } = req.params as { category?: string };
      await app.services.managerMcp.handleIntegration(
        req.raw,
        reply.raw,
        req.body,
        integrationIdentity(req),
        category,
      );
    },
  });
}
