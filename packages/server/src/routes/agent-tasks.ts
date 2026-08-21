/**
 * REST for launching agent tasks — the one endpoint behind every "describe it
 * and an agent does it" affordance in the app.
 *
 *   POST /api/projects/:id/tasks  → { chat, prompt, parts }
 *
 * One endpoint rather than one per feature: the task id selects the briefing
 * (see services/agent-tasks.ts), so a new task ships as a catalog entry plus a
 * brief, with no route, no client method and no launcher UI of its own. This
 * replaced `POST /config/author`, which was the same call with `section` in
 * place of `taskId` and no effort selector.
 *
 * 201 with the spawned chat (its briefing already sent) so the caller can focus
 * it and watch the work happen.
 */
import type { FastifyInstance } from "fastify";
import { LaunchAgentTaskInputSchema, AGENT_TASKS } from "@dispatch/shared";
import { launchAgentTask } from "../services/agent-tasks.js";

export function registerAgentTaskRoutes(app: FastifyInstance): void {
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/tasks",
    async (req, reply) => {
      const parsed = LaunchAgentTaskInputSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }
      const input = parsed.data;
      // Tasks whose whole content IS the human's sentence (every config task)
      // can't run on an empty one — the agent would invent a request. A sweep
      // has the working tree to go on, so instructions there stay optional.
      if (AGENT_TASKS[input.taskId].instructionsRequired && !input.instructions?.trim()) {
        return reply.code(400).send({ error: "instructions required for this task" });
      }
      try {
        const out = await launchAgentTask(app.services, {
          projectId: req.params.id,
          taskId: input.taskId,
          instructions: input.instructions,
          effort: input.effort,
          model: input.model,
          agentId: input.agentId,
          params: input.params,
        });
        if (!out) return reply.code(404).send({ error: "project not found" });
        return reply.code(201).send(out);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
