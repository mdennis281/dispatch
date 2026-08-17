/**
 * Route registration barrel. `registerRoutes(app)` mounts every REST + WS route
 * on the Fastify instance (which must already be decorated with `app.cm` and
 * `app.services`). Called once from `buildApp`.
 */
import type { FastifyInstance } from "fastify";
import { registerWsRoutes } from "./ws.js";
import { registerProjectRoutes } from "./projects.js";
import { registerProjectConfigRoutes } from "./project-config.js";
import { registerAgentTaskRoutes } from "./agent-tasks.js";
import { registerChatRoutes } from "./chats.js";
import { registerAssetRoutes } from "./assets.js";
import { registerAgentRoutes } from "./agents.js";
import { registerModeRoutes } from "./modes.js";
import { registerModelRoutes } from "./models.js";
import { registerManagerMcpRoute } from "./manager-mcp.js";
import { registerMemoryRoutes } from "./memory.js";
import { registerMcpRoutes } from "./mcp.js";
import { registerWorktreeRoutes } from "./worktrees.js";
import { registerGitRoutes } from "./git.js";
import { registerRunnerRoutes } from "./runner.js";
import { registerTerminalRoutes } from "./terminals.js";
import { registerGithubRoutes } from "./github.js";
import { registerPrRoutes } from "./prs.js";
import { registerAttentionRoutes } from "./attention.js";
import { registerSettingsRoutes } from "./settings.js";
import { registerUsageRoutes } from "./usage.js";
import { registerFileRoutes } from "./files.js";
import { registerFsRoutes } from "./fs.js";
import { registerShutdownRoutes } from "./shutdown.js";
import { registerUpdateRoutes } from "./update.js";
import { registerAuthRoutes } from "./auth.js";

export function registerRoutes(app: FastifyInstance): void {
  registerAuthRoutes(app);
  registerWsRoutes(app);
  registerProjectRoutes(app);
  registerProjectConfigRoutes(app);
  registerAgentTaskRoutes(app);
  registerChatRoutes(app);
  registerAssetRoutes(app);
  registerAgentRoutes(app);
  registerModeRoutes(app);
  registerModelRoutes(app);
  registerManagerMcpRoute(app);
  registerMemoryRoutes(app);
  registerMcpRoutes(app);
  registerWorktreeRoutes(app);
  registerGitRoutes(app);
  registerRunnerRoutes(app);
  registerTerminalRoutes(app);
  registerGithubRoutes(app);
  registerPrRoutes(app);
  registerAttentionRoutes(app);
  registerSettingsRoutes(app);
  registerUsageRoutes(app);
  registerFileRoutes(app);
  registerFsRoutes(app);
  registerShutdownRoutes(app);
  registerUpdateRoutes(app);
}
