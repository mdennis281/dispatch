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
 * THE PROJECT ALLOWLIST IS ENFORCED HERE TOO. The REST surface filters by
 * `identity.projectIds` on every route; a token with "only these projects"
 * must not be able to reach the others by switching to the MCP mount. So the
 * `inspect` and `messaging` bindings are wrapped: listings are filtered, and a
 * chat outside the allowlist is reported as unknown — the same answer REST
 * gives (404), chosen over "forbidden" so a restricted token cannot enumerate
 * what it may not see. `wait_for_chat` asks the BROKER whether a chat exists,
 * synchronously, so a restricted context precomputes the set of chats it may
 * see once per request; the mount builds a fresh context per call and a chat
 * created mid-call is not worth an async broker binding.
 *
 * PROJECT-BOUND TOOLS. Memory and issues need a project, and a token has no
 * chat to inherit one from. They are bound when the token's allowlist names
 * EXACTLY ONE project — that is the only honest reading of "which project" —
 * and omitted otherwise. A token meant for memory curation gets one project.
 *
 * `spawn_chat` is bound only for a token holding `chats:create`, and runs
 * through `ChannelChatService` rather than the broker's spawn: there is no
 * parent session to put a consent card in, so the owner's GRANT of that scope
 * is the consent (see channel-chats.ts for the limits a grant cannot waive —
 * no bypass mode, and the brief lands as this integration's message).
 *
 * `chat_summarize` spends a model call on the summarized chat's account; the
 * service caches it and rate-limits it per token name.
 *
 * `chat_stop` is bound wherever `chat_send` is — interrupting a turn is already
 * in reach through its "interrupt" delivery, so gating the honest name for it
 * behind more than the tool it duplicates would only hide it. Archiving is
 * narrower, and `ChannelChatService.stop` enforces that.
 *
 * `persona_list` resolves against the project the caller names — or, for a
 * token restricted to exactly one project, that one — because a project's own
 * personas are valid `personaId`s that `config_list` cannot show here (this
 * context has no project config dir). A project outside the allowlist reads as
 * unknown, and the refusal lists the ones the caller CAN see.
 */
import type { EventBus } from "../../bus.js";
import type { Store } from "../../store/index.js";
import type { IntegrationIdentity } from "../integration-tokens.js";
import type { ChatMessenger, PeerSendResult } from "../chat-messenger.js";
import type { InspectService } from "../inspect.js";
import type { MemoryService } from "../memory.js";
import type { MemoryHistoryService } from "../memory-history.js";
import type { IssueService } from "../issues/service.js";
import type { AuthoredConfigService } from "../authored-config.js";
import type { SessionBroker } from "../session-broker.js";
import type { ChannelChatService } from "../channel-chats.js";
import { ChannelChatRefusal } from "../channel-chats.js";
import type { ChatSummaryService } from "../chat-summary.js";
import { eventReachFor, type EventFeedService } from "../event-feed.js";
import type { ChatTree } from "../chat-tree.js";
import type { AttentionQueue } from "../attention.js";
import { answerAttentionItem, buildAttentionEntries, type ManagerMcpAttention } from "./attention-tools.js";
import { BUILTIN_MODE_PERMISSION } from "../session-broker.js";
import { realProjects } from "@dispatch/shared";
import { createAuthoringEditor } from "./authoring-editor.js";
import { createModeEditor } from "./mode-editor.js";
import { externalToolPolicy, type ManagerMcpBroker, type ManagerMcpContext } from "./manager-mcp.js";

export interface IntegrationContextDeps {
  bus: EventBus;
  store: Pick<Store, "getChat" | "listChats"> & Parameters<typeof createModeEditor>[0]["store"];
  broker: Pick<SessionBroker, "has" | "getStatus" | "getContextUsage"> &
    Partial<Pick<SessionBroker, "pendingPermissionSnapshot">>;
  inspect?: InspectService;
  messenger?: ChatMessenger;
  memory?: MemoryService;
  memoryHistory?: MemoryHistoryService;
  issues?: IssueService;
  authored?: AuthoredConfigService;
  channelChats?: Pick<ChannelChatService, "create" | "stop" | "setArchived">;
  summaries?: Pick<ChatSummaryService, "summarize">;
  getProject?: (id: string) => Promise<{ id: string; name: string } | null>;
  /** Every project, for `spawn_chat` to resolve a name against. Filtered here. */
  listProjects?: () => Promise<{ id: string; name: string }[]>;
  /** The effective personas, with a project's own when `projectId` is given. */
  listPersonas?: (projectId?: string) => Promise<{ id: string; name: string; scope: string }[]>;
  /** The integration event feed behind `events_poll`. */
  events?: Pick<EventFeedService, "poll">;
  /** A chat's family (chat-tree.ts). Same-project by construction, so the allowlist holds. */
  chatTree?: (chatId: string, depth: number) => Promise<ChatTree | null>;
  /** The global attention queue behind the `attention_*` tools. */
  attention?: Pick<AttentionQueue, "list" | "dismiss" | "get">;
  /** Answers a question card — the SPA's own path. Absent → no `attention_answer`. */
  questions?: Pick<SessionBroker, "answerQuestion" | "declineQuestion">;
  now?: () => number;
}

/**
 * What a restricted token may see. `null` means unrestricted — every project,
 * every chat — so the bindings pass straight through and pay nothing.
 */
interface Allowlist {
  projects: ReadonlySet<string>;
  chats: ReadonlySet<string>;
}

/**
 * A broker binding with no session behind it. Reads delegate to the real
 * broker — `wait_for_chat` and `chat_state` need live statuses — and every
 * write is a no-op or a refusal: there is no slot to take, no PR dot to light,
 * and no human to put a card in front of.
 */
function externalBroker(
  broker: IntegrationContextDeps["broker"],
  allow: Allowlist | null,
): ManagerMcpBroker {
  const visible = (chatId: string): boolean => !allow || allow.chats.has(chatId);
  return {
    // A chat outside the allowlist does not exist, as far as this caller knows.
    has: (chatId) => visible(chatId) && broker.has(chatId),
    getStatus: (chatId) => (visible(chatId) ? broker.getStatus(chatId) : undefined),
    getContextUsage: async (chatId) => (visible(chatId) ? broker.getContextUsage(chatId) : null),
    compact: () => {},
    markPrWatched: () => {},
    acquireSlot: async () => {},
    noteWaitingOn: () => {},
    askUser: async () => ({ status: "declined" as const }),
    requestHumanReview: async () => ({ status: "dismissed" as const }),
  };
}

/** The refusal a send/ask to an invisible chat gets — the messenger's own unknown-chat shape. */
function unknownChat(to: string): PeerSendResult & { ok: false } {
  return {
    ok: false,
    refusal: "unknown-chat",
    message: `No chat "${to}" exists. Find the right id with chat_find.`,
  };
}

export async function createIntegrationContext(
  deps: IntegrationContextDeps,
  identity: IntegrationIdentity,
): Promise<ManagerMcpContext> {
  const { memory, memoryHistory, issues, inspect, messenger, authored, store, channelChats, summaries, getProject, listProjects, listPersonas, events, attention } = deps;
  const projectId = identity.projectIds?.length === 1 ? identity.projectIds[0] : undefined;
  const allow: Allowlist | null = identity.projectIds?.length
    ? {
        projects: new Set(identity.projectIds),
        chats: new Set(
          (await Promise.all(identity.projectIds.map((p) => store.listChats(p).catch(() => []))))
            .flat()
            .map((c) => c.id),
        ),
      }
    : null;
  const chatVisible = (chatId: string): boolean => !allow || allow.chats.has(chatId);
  const projectVisible = (id: string | undefined): boolean =>
    !allow || (id !== undefined && allow.projects.has(id));
  // What the row says and what the reminder names: the token's name, which is
  // what the human chose when they minted it — and its trust, which only the
  // owner can set and which no tool argument can raise.
  const channel = { name: identity.name, ...(identity.trust === "owner" ? { trust: identity.trust } : {}) };
  return {
    chatId: "",
    bus: deps.bus,
    broker: externalBroker(deps.broker, allow),
    toolPolicy: externalToolPolicy(),
    now: deps.now,
    inspect: inspect
      ? {
          findChats: async (q) => {
            const result = await inspect.findChats(q);
            if (!allow) return result;
            // Filtered AFTER the search rather than by narrowing the query: a
            // token with two projects and no `project` filter needs both.
            const chats = result.chats.filter((c) => projectVisible(c.projectId));
            return { ...result, chats };
          },
          readChat: async (q) => {
            if (!chatVisible(q.chatId)) throw new Error(`No chat "${q.chatId}" exists.`);
            return inspect.readChat(q);
          },
          // No caller project to fall back to: `project` must be named.
          projectInfo: async (q) => {
            const result = await inspect.projectInfo(q, projectId);
            if (!projectVisible(result.project.id)) {
              throw new Error(`No project matching "${q.project ?? ""}".`);
            }
            return result;
          },
          projectList: async (instance) =>
            (await inspect.projectList(instance)).filter((p) => projectVisible(p.id)),
        }
      : undefined,
    messaging: messenger
      ? {
          send: ({ to, message, delivery }) =>
            chatVisible(to)
              ? messenger.send({ channel, to, message, delivery })
              : Promise.resolve(unknownChat(to)),
          ask: ({ to, question, timeoutMs, signals, onWaiting }) =>
            chatVisible(to)
              ? messenger.ask({ channel, to, question, timeoutMs, signals, onWaiting })
              : Promise.resolve({ ...unknownChat(to), answered: false as const }),
          // An integration is never the TARGET of an ask, so this can only ever
          // refuse — but it refuses honestly ("addressed to chat X, not to you")
          // rather than being absent and reading as a missing tool.
          reply: ({ askId, answer }) => messenger.reply({ from: `channel:${identity.name}`, askId, answer }),
          state: (chatId) => (chatVisible(chatId) ? messenger.state(chatId) : Promise.resolve(null)),
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
    chats:
      channelChats && getProject && identity.scopes.includes("chats:create")
        ? {
            canNotify: false,
            // No caller project to default to: an omitted id is "nowhere".
            resolveProject: async (id) => {
              if (!id || !projectVisible(id)) return null;
              const p = await getProject(id).catch(() => null);
              return p ? { id: p.id, name: p.name } : null;
            },
            // Filtered by the allowlist like every other listing here, so a
            // restricted token's refusal cannot enumerate what it may not see.
            listProjects: listProjects
              ? async () =>
                  realProjects(await listProjects().catch(() => []))
                    .filter((p) => projectVisible(p.id))
                    .map((p) => ({ id: p.id, name: p.name }))
              : undefined,
            consent: async () => ({ approved: true, auto: true }),
            spawn: async ({ request, project }) => {
              try {
                const made = await channelChats.create({
                  channel: identity.name,
                  tokenId: identity.tokenId,
                  trust: identity.trust,
                  projectId: project.id,
                  prompt: request.prompt,
                  ...(request.title ? { title: request.title } : {}),
                  ...(request.modeId ? { modeId: request.modeId } : {}),
                  ...(request.provider ? { provider: request.provider } : {}),
                  ...(request.model ? { model: request.model } : {}),
                  ...(request.effort ? { effort: request.effort } : {}),
                  ...(request.personaId ? { personaId: request.personaId } : {}),
                  // Forwarded, not dropped: a request for one login must not
                  // quietly start on (and spend) another.
                  ...(request.subscription ? { subscriptionId: request.subscription } : {}),
                  ...(request.agentId ? { agentId: request.agentId } : {}),
                });
                return { ...made };
              } catch (err) {
                // The tool reports a thrown spawn as its failure; the refusal's
                // own sentence is the useful part.
                if (err instanceof ChannelChatRefusal) throw new Error(err.message);
                throw err;
              }
            },
          }
        : undefined,
    control:
      channelChats && messenger
        ? {
            stop: async (chatId, { archive }) => {
              if (!chatVisible(chatId)) throw new Error(`No chat "${chatId}" exists. Find the right id with chat_find.`);
              try {
                return await channelChats.stop({ channel: identity.name, tokenId: identity.tokenId, chatId, archive });
              } catch (err) {
                if (err instanceof ChannelChatRefusal) throw new Error(err.message);
                throw err;
              }
            },
          }
        : undefined,
    // Wherever chat_stop is: the same reach into another chat, minus the stop.
    archive:
      channelChats && messenger
        ? {
            setArchived: async (chatId, archived) => {
              if (!chatVisible(chatId)) throw new Error(`No chat "${chatId}" exists. Find the right id with chat_find.`);
              try {
                return await channelChats.setArchived({ channel: identity.name, tokenId: identity.tokenId, chatId, archived });
              } catch (err) {
                if (err instanceof ChannelChatRefusal) throw new Error(err.message);
                throw err;
              }
            },
          }
        : undefined,
    personas: listPersonas
      ? {
          list: async (needle) => {
            // No project named: a single-project token means that one; any
            // other token gets the shared set, and is told so.
            const wanted = needle ?? projectId;
            let target: { id: string; name: string } | null = null;
            if (wanted) {
              const visible = realProjects((await listProjects?.().catch(() => [])) ?? []).filter((p) => projectVisible(p.id));
              const lower = wanted.toLowerCase();
              const named = visible.filter((p) => p.id === wanted || p.name.toLowerCase() === lower);
              if (named.length !== 1) {
                const known = visible.map((p) => `${p.name} (${p.id})`).join(", ");
                throw new Error(
                  named.length > 1
                    ? `"${wanted}" names ${named.length} projects — pass one of their ids: ${named.map((p) => p.id).join(", ")}.`
                    : `No project "${wanted}".${known ? ` Projects you can see: ${known}.` : ""}`,
                );
              }
              target = { id: named[0]!.id, name: named[0]!.name };
            }
            const personas = (await listPersonas(target?.id)).map((p) => ({ id: p.id, name: p.name, scope: p.scope }));
            return { project: target, personas };
          },
        }
      : undefined,
    // Scoped per event TYPE rather than gated whole: a token with chats:read
    // but not attention:read polls chat and nothing else, the same split the
    // REST routes and the webhook filters make.
    // Not offered at all to a token that could read nothing from it — a tool
    // that always answers "0 events" reads as a quiet feed, not a missing grant.
    events: events && eventReachFor(identity).types.length > 0
      ? {
          poll: async ({ project, ...q }) => {
            if (project !== undefined && !projectVisible(project)) {
              throw new Error(`No project "${project}". Find ids with project_list.`);
            }
            if (q.chatId !== undefined && !chatVisible(q.chatId)) {
              throw new Error(`No chat "${q.chatId}" exists. Find the right id with chat_find.`);
            }
            return events.poll({ ...q, ...(project ? { projectIds: [project] } : {}) }, eventReachFor(identity));
          },
        }
      : undefined,
    // Each tool behind the scope its REST twin asks: listing needs
    // `attention:read`, dismissing `attention:answer` — a token holding only
    // the latter gets `attention_dismiss` without `attention_list`, exactly as
    // it gets `POST attention/dismiss` without `GET attention`.
    attention:
      attention && (identity.scopes.includes("attention:read") || identity.scopes.includes("attention:answer"))
        ? {
            ...(identity.scopes.includes("attention:read")
              ? {
                  list: async ({ kinds, project, chatId }: Parameters<NonNullable<ManagerMcpAttention["list"]>>[0]) => {
                    if (project !== undefined && !projectVisible(project)) {
                      throw new Error(`No project "${project}". Find ids with project_list.`);
                    }
                    const items = attention
                      .list()
                      .filter((i) => projectVisible(i.projectId) && chatVisible(i.chatId))
                      .filter((i) => !kinds?.length || kinds.includes(i.kind))
                      .filter((i) => !project || i.projectId === project)
                      .filter((i) => !chatId || i.chatId === chatId);
                    return buildAttentionEntries(items, {
                      pending: deps.broker.pendingPermissionSnapshot?.() ?? [],
                      chatTitle: async (id) => (await store.getChat(id).catch(() => null))?.title,
                    });
                  },
                }
              : {}),
            // A write to the queue: `attention:answer`, the scope that already
            // lets this token resolve a question item.
            ...(identity.scopes.includes("attention:answer")
              ? {
                  dismiss: async ({ ids, kinds, project, chatId }) => {
                    if (project !== undefined && !projectVisible(project)) {
                      throw new Error(`No project "${project}". Find ids with project_list.`);
                    }
                    const { removed, missing } = attention.dismiss({
                      ...(ids ? { ids } : {}),
                      ...(kinds ? { kinds } : {}),
                      ...(chatId ? { chatId } : {}),
                      ...(project ? { projectId: project } : {}),
                      visible: (i) => projectVisible(i.projectId) && chatVisible(i.chatId),
                    });
                    // Same broadcast as the SPA's clear: every client holds these.
                    for (const i of removed) deps.bus.publish({ type: "attention-resolve", id: i.id, chatId: i.chatId });
                    return {
                      dismissed: removed.map((i) => ({ id: i.id, kind: i.kind, chatId: i.chatId, summary: i.summary })),
                      missing,
                    };
                  },
                  ...(deps.questions
                    ? {
                        answer: async (id: string, input: Parameters<typeof answerAttentionItem>[2]) =>
                          answerAttentionItem(
                            { attention, broker: deps.questions! },
                            id,
                            input,
                            (i) => projectVisible(i.projectId) && chatVisible(i.chatId),
                          ),
                      }
                    : {}),
                }
              : {}),
          }
        : undefined,
    // Read-only, like chat_state. Every node shares the asked chat's project
    // (chat-tree.ts keeps to one), so checking that one chat checks them all.
    chatTree: deps.chatTree
      ? {
          tree: async (chatId, depth) => (chatVisible(chatId) ? deps.chatTree!(chatId, depth) : null),
        }
      : undefined,
    summary: summaries
      ? {
          summarize: async (chatId, focus) => {
            if (!chatVisible(chatId)) throw new Error(`No chat "${chatId}" exists. Find the right id with chat_find.`);
            return summaries.summarize(chatId, { caller: `channel:${identity.name}`, ...(focus ? { focus } : {}) });
          },
        }
      : undefined,
    // Reads of the shipped and global scopes. No project config dir: the
    // project-scoped copies belong to a checkout no integration is working in.
    authoring: authored
      ? createAuthoringEditor({ authored, configPaths: null, getConfig: () => null })
      : undefined,
    modes: authored
      ? createModeEditor({ store, configPaths: null, builtin: BUILTIN_MODE_PERMISSION })
      : undefined,
  };
}
