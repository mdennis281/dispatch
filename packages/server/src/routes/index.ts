/**
 * Route registration barrel. `registerRoutes(app)` mounts every REST + WS route
 * on the Fastify instance (which must already be decorated with `app.cm` and
 * `app.services`). Called once from `buildApp`.
 */
import type { FastifyInstance } from "fastify";
import { registerWsRoutes } from "./ws.js";
import { registerProjectRoutes } from "./projects.js";
import { registerChatRoutes } from "./chats.js";
import { registerAssetRoutes } from "./assets.js";
import { registerAgentRoutes } from "./agents.js";
import { registerModeRoutes } from "./modes.js";
import { registerMemoryRoutes } from "./memory.js";
import { registerMcpRoutes } from "./mcp.js";
import { registerWorktreeRoutes } from "./worktrees.js";
import { registerRunnerRoutes } from "./runner.js";
import { registerTerminalRoutes } from "./terminals.js";
import { registerGithubRoutes } from "./github.js";
import { registerAttentionRoutes } from "./attention.js";
import { registerSettingsRoutes } from "./settings.js";

export function registerRoutes(app: FastifyInstance): void {
  registerWsRoutes(app);
  registerProjectRoutes(app);
  registerChatRoutes(app);
  registerAssetRoutes(app);
  registerAgentRoutes(app);
  registerModeRoutes(app);
  registerMemoryRoutes(app);
  registerMcpRoutes(app);
  registerWorktreeRoutes(app);
  registerRunnerRoutes(app);
  registerTerminalRoutes(app);
  registerGithubRoutes(app);
  registerAttentionRoutes(app);
  registerSettingsRoutes(app);
}
