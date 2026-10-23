/**
 * Builds the `PluginContext` a server plugin's `activate` receives.
 *
 * Every member here is a thin adapter over an existing service — nothing a
 * plugin can do through the context is something the host could not already
 * do through the same service. The two rules the adapters keep, from
 * docs/plugins.md → "Server API":
 *
 *   - SENDS GO THROUGH THE MESSENGER, never `broker.sendMessage`. The broker
 *     declines every pending question card on a send; the messenger holds a
 *     message while the target is awaiting input. A plugin's message is not a
 *     human's dismissal of a card they haven't seen.
 *   - EVERYTHING IS OWNED. Bus subscriptions, route registrars and settings
 *     listeners are recorded in {@link OwnedResources} so deactivate can undo
 *     all of it without the plugin's cooperation.
 *
 * Capability gating is by ABSENCE: a member whose capability the manifest does
 * not declare is not on the object. That is enforcement enough for code the
 * owner chose to install; the point is the consent card, not containment.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import Router from "find-my-way";
import {
  realProjects,
  type ChannelSender,
  type Harness,
  type ProviderDescriptor,
  type PluginCapability,
  type PluginContext,
  type PluginLog,
  type PluginManifest,
  type PluginRouteHandler,
  type PluginRouter,
  type QuestionAnswer,
  type WsServerEvent,
} from "@dispatch/shared";
import type { EventBus } from "../bus.js";
import type { Store } from "../store/index.js";
import type { SecretsService } from "../services/secrets.js";
import type { InspectService } from "../services/inspect.js";
import { renderRead } from "../services/inspect-render.js";
import type { MemoryService } from "../services/memory.js";
import type { AttentionQueue } from "../services/attention.js";
import type { ChatMessenger } from "../services/chat-messenger.js";
import { PluginKv } from "./kv.js";
import type { PluginOAuthService } from "./oauth.js";

/** The server's narrowing of the shared context: route handlers see Fastify's request and reply. */
export type ServerPluginContext = PluginContext<FastifyRequest, FastifyReply>;
export type ServerPluginRouteHandler = PluginRouteHandler<FastifyRequest, FastifyReply>;

/**
 * A plugin's route table — find-my-way, which IS Fastify's router, so `:param`
 * syntax and matching behave exactly as a Fastify route would. The real
 * handler rides in find-my-way's `store` slot: its own handler signature is
 * the raw Node one, and what the host calls is a Fastify-shaped handler.
 */
export type PluginRouteTable = Router.Instance<Router.HTTPVersion.V1>;

const TABLE_METHODS = ["get", "post", "put", "delete"] as const;

export function newRouteTable(): PluginRouteTable {
  return Router({ ignoreTrailingSlash: true });
}

/** Adapt a table to the `PluginRouter` a plugin's `define` receives. */
function routerFor(table: PluginRouteTable): PluginRouter<FastifyRequest, FastifyReply> {
  const r = {} as PluginRouter<FastifyRequest, FastifyReply>;
  for (const method of TABLE_METHODS) {
    r[method] = (path, handler) => {
      const normalized = `/${path.replace(/^\/+/, "")}`;
      table.on(method.toUpperCase() as Router.HTTPMethod, normalized, () => undefined, { handler });
    };
  }
  return r;
}

/** The slice of the broker the context needs — narrow so tests can fake it. */
export interface PluginQuestionAnswerer {
  answerQuestion(
    requestId: string,
    answer: { optionId?: string; answer?: string; notes?: string; answers?: QuestionAnswer[] },
  ): boolean;
  declineQuestion(requestId: string, message?: string): boolean;
}

export interface PluginContextDeps {
  store: Store;
  bus: EventBus;
  secrets: SecretsService;
  inspect: InspectService;
  memory: MemoryService;
  attention: AttentionQueue;
  messenger: ChatMessenger;
  broker: PluginQuestionAnswerer;
  log: PluginLog;
  /** The plugin's cached settings — read live so `onChange` and `get` agree. */
  settings: () => Record<string, unknown>;
  /** The host-run OAuth client flow (`ctx.oauth`). Optional so a unit test can build a context without it. */
  pluginOAuth?: PluginOAuthService;
  /**
   * The plugin's `ctx.processes`, already bound to its id. Supplied by the
   * service (it owns the process host); absent when the host has no runner,
   * in which case the member is absent too, capability or not.
   */
  processes?: PluginContext["processes"];
  /**
   * Where `ctx.providers.register` lands — the host's `HarnessRegistry`. Absent
   * in a host built without one (unit tests); then the member is absent too.
   */
  providers?: {
    register(harness: Harness, descriptor: ProviderDescriptor): void;
    unregister(kind: string): Promise<void>;
  };
}

/** What the host must tear down when the plugin goes away. */
export interface OwnedResources {
  /** Bus unsubscribes. */
  offs: Array<() => void>;
  /** The route table the prefix wildcard consults. Emptied on deactivate. */
  routes: PluginRouteTable;
  settingsListeners: Set<(next: unknown) => void>;
}

export function newOwnedResources(): OwnedResources {
  return { offs: [], routes: newRouteTable(), settingsListeners: new Set() };
}

/** Default `ask` wait, matching `chat_ask`'s posture of "long, but not forever". */
const DEFAULT_ASK_SECONDS = 600;

export function buildPluginContext(
  manifest: PluginManifest,
  dir: string,
  deps: PluginContextDeps,
  owned: OwnedResources,
): ServerPluginContext {
  const id = manifest.id;
  const caps = new Set<PluginCapability>(manifest.capabilities ?? []);
  const has = (c: PluginCapability) => caps.has(c);
  // The messenger's channel sender for this plugin: rate limits key on the
  // name, and the row is stamped `origin: "channel"` with it.
  const channel = (sender?: string): ChannelSender => ({ name: sender?.trim() || id });

  const ctx: ServerPluginContext = {
    id,
    dir,
    version: manifest.version,
    log: deps.log,

    settings: {
      get: <T = Record<string, unknown>>() => deps.settings() as T,
      onChange: (fn) => {
        owned.settingsListeners.add(fn);
        return () => owned.settingsListeners.delete(fn);
      },
    },

    projects: {
      list: async () =>
        realProjects(await deps.store.listProjects()).map((p) => ({
          id: p.id,
          name: p.name,
          repoPath: p.repoPath,
          worktreeRoot: p.worktreeRoot,
          defaultBranch: p.defaultBranch,
        })),
      get: async (projectId) => {
        const p = await deps.store.getProject(projectId);
        if (!p) return undefined;
        return {
          id: p.id,
          name: p.name,
          repoPath: p.repoPath,
          worktreeRoot: p.worktreeRoot,
          defaultBranch: p.defaultBranch,
        };
      },
    },

    emit: (payload, chatId) => {
      deps.bus.publish({ type: "plugin-event", plugin: id, ...(chatId ? { chatId } : {}), payload });
    },
  };

  if (has("events")) {
    ctx.bus = {
      on: (type, fn) => {
        const off = deps.bus.on(type, fn);
        owned.offs.push(off);
        return off;
      },
      subscribe: (fn: (evt: WsServerEvent) => void) => {
        const off = deps.bus.subscribe(fn);
        owned.offs.push(off);
        return off;
      },
    };
  }

  if (has("routes")) {
    const router = routerFor(owned.routes);
    ctx.routes = (define) => define(router);
  }

  if (has("secrets")) {
    const allowed = new Set(manifest.secrets ?? []);
    ctx.secrets = {
      get: async (name) => {
        if (!allowed.has(name)) {
          deps.log.warn(`secret "${name}" is not listed under secrets: in plugin.yaml`);
          return undefined;
        }
        // `list()` is what refreshes the secrets cache from disk; `resolve`
        // alone reads whatever was last synced.
        await deps.secrets.list();
        return deps.secrets.resolve(undefined, name);
      },
      list: async () => {
        const stored = new Set((await deps.secrets.list()).filter((s) => s.scope === "global").map((s) => s.name));
        return [...allowed].filter((n) => stored.has(n));
      },
    };
  }

  if (has("kv")) {
    ctx.kv = new PluginKv(deps.store.stateDb, id);
  }

  if (has("chats:read") || has("chats:write")) {
    ctx.chats = {};
    if (has("chats:read")) {
      ctx.chats.list = async (q = {}) => {
        const chats = await deps.store.listChats(q.projectId);
        return chats
          .filter((c) => (q.archived ? true : !c.archived))
          .filter((c) => (q.status ? c.status === q.status : true))
          .filter((c) => (q.since ? (c.updatedAt ?? c.createdAt) >= q.since : true))
          .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
          .slice(0, q.limit ?? 50)
          .map((c) => ({
            id: c.id,
            title: c.title,
            projectId: c.projectId,
            status: c.status,
            archived: c.archived,
            harness: c.harness,
            model: c.model,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt ?? c.createdAt,
            worktrees: c.worktrees,
            prs: c.prs.map((p) => p.number),
          }));
      };
      ctx.chats.find = async (q) => (await deps.inspect.findChats(q)).chats;
      ctx.chats.read = async (chatId, view = "digest", opts = {}) =>
        renderRead(await deps.inspect.readChat({ chatId, view, ...opts }));
      ctx.chats.state = async (chatId) => {
        const s = await deps.messenger.state(chatId);
        return s && { ...s, prs: s.prs.map((p) => p.number) };
      };
    }
    if (has("chats:write")) {
      ctx.chats.send = async (chatId, text, opts = {}) =>
        deps.messenger.send({
          channel: channel(opts.sender),
          to: chatId,
          message: text,
          delivery: opts.delivery,
        });
      ctx.chats.ask = async (chatId, question, opts = {}) =>
        deps.messenger.ask({
          channel: channel(opts.sender),
          to: chatId,
          question,
          timeoutMs: (opts.timeoutSeconds ?? DEFAULT_ASK_SECONDS) * 1000,
        });
      ctx.chats.reply = async (askId, answer) => {
        // `reply` insists the replier is the chat that was asked — the guard
        // against a third chat answering on another's behalf. A plugin has the
        // host's privileges and answers AS that chat, so it looks the target up.
        const target = deps.messenger.targetOf(askId);
        if (!target) return { ok: false, message: `no pending ask "${askId}"` };
        const result = deps.messenger.reply({ from: target, askId, answer });
        return result.ok ? { ok: true } : { ok: false, message: result.message };
      };
    }
  }

  if (has("chats:read") || has("chats:write")) {
    ctx.attention = {};
    if (has("chats:read")) ctx.attention.list = async () => deps.attention.list();
    if (has("chats:write")) {
      ctx.attention.answer = async (itemId, answer) => {
        const item = deps.attention.get(itemId);
        if (!item) return { ok: false, message: `no attention item "${itemId}"` };
        if (item.kind !== "question" || !item.permissionRequestId) {
          // A permission is the human's to grant; an integration answering a
          // tool-call prompt would be the one thing the consent model forbids.
          return { ok: false, message: `attention item "${itemId}" is a ${item.kind}, not a question` };
        }
        const ok =
          "decline" in answer
            ? deps.broker.declineQuestion(item.permissionRequestId)
            : deps.broker.answerQuestion(item.permissionRequestId, answer);
        return ok ? { ok: true } : { ok: false, message: "the question is no longer pending" };
      };
    }
  }

  if (has("oauth") && deps.pluginOAuth) {
    // Bound to this plugin's id: a plugin names its own clients and cannot
    // reach another plugin's tokens by naming that plugin.
    const oauth = deps.pluginOAuth;
    ctx.oauth = {
      connectUrl: (name) => oauth.connectUrl(id, name),
      token: (name) => oauth.token(id, name),
      disconnect: (name) => oauth.disconnect(id, name),
    };
  }

  if (has("process") && deps.processes) {
    ctx.processes = deps.processes;
  }

  if (has("providers") && deps.providers) {
    const providers = deps.providers;
    ctx.providers = {
      register: (harness, descriptor) => {
        providers.register(harness, descriptor);
        // Torn down with the plugin, like a route or a bus listener: a
        // switched-off plugin's runtime must not keep taking new sessions.
        // Caught here: `offs` run synchronously during teardown, and a
        // harness whose `dispose()` rejects would otherwise be an unhandled
        // rejection — fatal to the whole process.
        owned.offs.push(() => {
          providers.unregister(harness.kind).catch((err: unknown) => {
            deps.log.error(`provider "${harness.kind}" failed to dispose`, err);
          });
        });
      },
    };
  }

  if (has("memory")) {
    ctx.memory = {
      recall: async (projectId, query) => {
        const r = await deps.memory.recall(projectId, query);
        if (!r.matches.length) return r.index;
        const bodies = r.matches.map((m) => `## ${m.name}\n${m.description}\n\n${m.body}`);
        return `${r.index}\n\n${bodies.join("\n\n---\n\n")}`;
      },
      remember: async (projectId, m) => {
        await deps.memory.write(projectId, m);
      },
      forget: async (projectId, name) => {
        await deps.memory.delete(projectId, name);
      },
    };
  }

  return ctx;
}
