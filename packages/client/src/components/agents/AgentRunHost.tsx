/**
 * Single mount point for the agent-run inspector. Rendered once at the app root;
 * shows the inspector whenever a surface has opened a run (the in-chat run card,
 * the Agents rail, or a nested drill-in). Renders nothing until one is open.
 */
import { useAgentRun } from "../../stores/agentRun.js";
import { AgentRunInspector } from "./AgentRunInspector.js";

export function AgentRunHost() {
  const target = useAgentRun((s) => s.target);
  if (!target) return null;
  return <AgentRunInspector chatId={target.chatId} runId={target.runId} />;
}
