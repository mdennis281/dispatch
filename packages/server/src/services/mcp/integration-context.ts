/**
 * THE EXTERNAL MANAGER CONTEXT — what the integration MCP mount builds a
 * category server from.
 *
 * A session's context (session-broker.ts) is bound to a chat: its shells, its
 * tree, its slot, the card channel to its human. An integration has none of
 * that. This builds a {@link ManagerMcpContext} with NO self chat — `chatId`
 * is empty, the broker binding is a read-only shim, and nothing that would
 * act on a session is bound — and leaves the tool set to
 * {@link externalToolPolicy}, which denies every tool `MANAGER_TOOL_EXTERNAL`
 * says is not external. Both halves matter: the policy keeps `terminal` off
 * the server even though no `terminals` binding is here to offer it, and the
 * missing bindings keep a future tool from being offered merely because its
 * verdict was forgotten.
 *
 * PROJECT-BOUND TOOLS. Memory and issues need a project, and a token has no
 * chat to inherit one from. They are bound when the token's allowlist names
 * EXACTLY ONE project — that is the only honest reading of "which project" —
 * and omitted otherwise. A token meant for memory curation gets one project.
 *
 * `spawn_chat` is external by the registry's rule, but its consent card is
 * routed through the PARENT session's permission channel, and there is no
 * parent here. It stays unbound until a session-less consent card exists; the
 * tool is simply not listed.
 */
import type { EventBus } from "../../bus.js";
import type { Store } from "../../store/index.js";
import type { IntegrationIdentity } from "../integration-tokens.js";
import type { ChatMessenger } from "../chat-messenger.js";
import type { InspectService } from "../inspect.js";
import type { MemoryService } from "../memory.js";
import type { MemoryHistoryService } from "../memory-history.js";
import type { IssueService } from "../issues/service.js";
import type { AuthoredConfigService } from "../authored-config.js";
import type { SessionBroker } from "../session-broker.js";
import { BUILTIN_MODE_PERMISSION } from "../session-broker.js";
import { createAuthoringEditor } from "./authoring-editor.js";
import { createModeEditor } from "./mode-editor.js";
import { externalToolPolicy, type ManagerMcpBroker, type ManagerMcpContext } from "./manager-mcp.js";

export interface IntegrationContextDeps {
  bus: EventBus;
  store: Store;
  broker: Pick<SessionBroker, "has" | "getStatus" | "getContextUsage">;
  inspect?: InspectService;
  messenger?: ChatMessenger;
  memory?: MemoryService;
  memoryHistory?: MemoryHistoryService;
  issues?: IssueService;
  authored?: AuthoredConfigService;
  now?: () => number;
}

/**
 * A broker binding with no session behind it. Reads delegate to the real
 * broker — `wait_for_chat` and `chat_state` need live statuses — and every
 * write is a no-op or a refusal: there is no slot to take, no PR dot to light,
 * and no human to put a card in front of.
 */
function externalBroker(broker: IntegrationContextDeps["broker"]): ManagerMcpBroker {
  return {
    has: (chatId) => broker.has(chatId),
    getStatus: (chatId) => broker.getStatus(chatId),
    getContextUsage: (chatId) => broker.getContextUsage(chatId),
    compact: () => {},
    markPrWatched: () => {},
    acquireSlot: async () => {},
    noteWaitingOn: () => {},
    askUser: async () => ({ status: "declined" as const }),
    requestHumanReview: async () => ({ status: "dismissed" as const }),
  };
}

export function createIntegrationContext(
  deps: IntegrationContextDeps,
  identity: IntegrationIdentity,
): ManagerMcpContext {
  const { memory, memoryHistory, issues, inspect, messenger, authored } = deps;
  const projectId = identity.projectIds?.length === 1 ? identity.projectIds[0] : undefined;
  // What the row says and what the reminder names: the token's name, which is
  // what the human chose when they minted it.
  const channel = { name: identity.name };
  return {
    chatId: "",
    bus: deps.bus,
    broker: externalBroker(deps.broker),
    toolPolicy: externalToolPolicy(),
    now: deps.now,
    inspect: inspect
      ? {
          findChats: (q) => inspect.findChats(q),
          readChat: (q) => inspect.readChat(q),
          // No caller project to fall back to: `project` must be named.
          projectInfo: (q) => inspect.projectInfo(q, projectId),
          projectList: (instance) => inspect.projectList(instance),
        }
      : undefined,
    messaging: messenger
      ? {
          send: ({ to, message, delivery }) => messenger.send({ channel, to, message, delivery }),
          ask: ({ to, question, timeoutMs, signals, onWaiting }) =>
            messenger.ask({ channel, to, question, timeoutMs, signals, onWaiting }),
          // An integration is never the TARGET of an ask, so this can only ever
          // refuse — but it refuses honestly ("addressed to chat X, not to you")
          // rather than being absent and reading as a missing tool.
          reply: ({ askId, answer }) => messenger.reply({ from: `channel:${identity.name}`, askId, answer }),
          state: (chatId) => messenger.state(chatId),
          // Denied by the policy; present so the binding is whole.
          setMode: async () => {
            throw new Error("chat_set_mode is not available to integrations.");
          },
          setPersona: async () => {
            throw new Error("chat_set_persona is not available to integrations.");
          },
        }
      : undefined,
    memory:
      memory && projectId
        ? {
            remember: (input) => memory.write(projectId, input),
            recall: (query, opts) => memory.recall(projectId, query, opts),
            forget: (name) => memory.delete(projectId, name),
            findSimilar: (candidate, opts) => memory.findSimilar(projectId, candidate, opts),
            inventory: (opts) => memory.inventory(projectId, opts),
            grep: (opts) => memory.grep(projectId, opts),
            read: (name) => memory.read(projectId, name),
            history: memoryHistory ? (opts) => memoryHistory.forProject(projectId, opts) : undefined,
          }
        : undefined,
    issues: issues && projectId ? { tracker: () => issues.forProject(projectId) } : undefined,
    // Reads of the shipped and global scopes. No project config dir: the
    // project-scoped copies belong to a checkout no integration is working in.
    authoring: authored
      ? createAuthoringEditor({ authored, configPaths: null, getConfig: () => null })
      : undefined,
    modes: authored
      ? createModeEditor({ store: deps.store, configPaths: null, builtin: BUILTIN_MODE_PERMISSION })
      : undefined,
  };
}
