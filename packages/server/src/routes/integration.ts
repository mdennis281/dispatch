/**
 * THE INTEGRATION SURFACE — `/api/integration/*`, a curated REST view for a
 * caller holding a `dsp_` token, plus the owner's token-management routes
 * under `/api/auth/tokens`.
 *
 * Curated rather than scope checks sprinkled over the SPA's routes: the SPA
 * API is wide, chatty and shaped for a client that holds every event in a
 * store. A bot wants six questions answered — which chats, what did one say,
 * send it something, what needs a human, answer that, which projects — and a
 * surface that small can be documented in one OpenAPI file and reasoned about
 * as a whole. Every route names its scope; `requireScope` 403s with the
 * missing one spelled out.
 *
 * A browser session may call these too (it holds every scope), which is how
 * the Settings pane can be built against the same routes a bot uses.
 *
 * THE SEND PATH. `POST chats/:id/messages` goes through `ChatMessenger` with a
 * channel sender — never `broker.sendMessage` directly. The broker treats any
 * incoming message as the human dismissing their open question cards; the
 * messenger holds a message while the target is `awaiting-input`. A bot's
 * message is not a human's dismissal.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as z from "zod";
import {
  INTEGRATION_EVENT_PAGE_MAX,
  INTEGRATION_EVENT_TYPES,
  INTEGRATION_SCOPES,
  isIntegrationEventType,
  INTEGRATION_TRUST_LEVELS,
  QuestionAnswerSchema,
  AttentionItemSchema,
  type IntegrationTokenCreateRequest,
} from "@dispatch/shared";
import { AuthFailure, type RequestIdentity } from "../services/auth.js";
import { ChannelChatRefusal } from "../services/channel-chats.js";
import { SummaryRateLimitError } from "../services/chat-summary.js";
import { FindCursorError, FindFilterError } from "../services/inspect.js";
import { personasFor } from "../services/personas.js";
import { EventCursorError, eventReachFor } from "../services/event-feed.js";
import { AttentionAnswerError, answerAttentionItem, buildAttentionEntries } from "../services/mcp/attention-tools.js";
import { ProviderUnavailableError } from "../harness/index.js";
import {
  ScopeFailure,
  projectAllowed,
  requireScope,
  sendScopeFailure,
} from "../services/integration-tokens.js";

/* --------------------------------------------------------------- helpers */

function withScope<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  return fn().catch((error: unknown) => {
    if (error instanceof ScopeFailure) return sendScopeFailure(reply, error);
    throw error;
  });
}

/**
 * A query-string boolean. Not `z.coerce.boolean()`: that is `Boolean("false")`,
 * which is `true` — `?archived=false` used to INCLUDE archived chats.
 */
const queryBool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const ListChatsQuery = z.object({
  projectId: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  /** `awaiting-input`: a permission prompt or question is waiting on the human. */
  blockedOnHuman: queryBool.optional(),
  /** Only chats with a PR still open. */
  unmerged: queryBool.optional(),
  since: z.coerce.number().int().nonnegative().optional(),
  before: z.coerce.number().int().nonnegative().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  archived: queryBool.optional(),
  /** `nextCursor` from the previous page of the same search. */
  cursor: z.string().min(1).optional(),
});

const MessagesQuery = z.object({
  kinds: z.string().optional(),
  /** User/assistant text unclipped; tool payloads stay clipped. */
  fullText: queryBool.optional(),
  before: z.string().min(1).optional(),
  after: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const SendBody = z.object({
  text: z.string().min(1),
  delivery: z.enum(["queue", "interrupt"]).optional(),
  /** A display name for the row; defaults to the token's name. */
  sender: z.string().trim().min(1).max(64).optional(),
});

const CreateChatBody = z.object({
  projectId: z.string().min(1),
  /** The first message — the new chat's whole brief, attributed to this integration. */
  text: z.string().min(1),
  title: z.string().trim().min(1).max(200).optional(),
  modeId: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
});

const EventsQuery = z.object({
  cursor: z.string().min(1).optional(),
  /** Epoch ms or ISO 8601; parsed in the route so a bad value is a sentence, not a zod dump. */
  since: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(INTEGRATION_EVENT_PAGE_MAX).optional(),
  /** Comma-separated event types. */
  types: z.string().optional(),
  projectId: z.string().min(1).optional(),
  chatId: z.string().min(1).optional(),
});

const SummaryQuery = z.object({ focus: z.string().max(500).optional() });

const StopBody = z.object({ archive: z.boolean().optional() });

const ArchiveBody = z.object({ archived: z.boolean() });

const AnswerBody = z.object({
  answer: z.string().optional(),
  optionId: z.string().optional(),
  notes: z.string().optional(),
  answers: z.array(QuestionAnswerSchema).optional(),
  decline: z.boolean().optional(),
});

const DismissBody = z.object({
  /** At least one: an empty list is a caller that named nothing, never a sweep. */
  ids: z.array(z.string().trim().min(1)).min(1).optional(),
  kinds: z.array(AttentionItemSchema.shape.kind).min(1).optional(),
  chatId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
});

const CreateTokenBody = z.object({
  name: z.string(),
  scopes: z.array(z.string()),
  projectIds: z.array(z.string()).optional(),
  expiresAt: z.number().optional(),
  trust: z.enum(INTEGRATION_TRUST_LEVELS).optional(),
});

const UpdateTokenBody = z.object({ trust: z.enum(INTEGRATION_TRUST_LEVELS) });

function csv(value: string | undefined): string[] | undefined {
  const out = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return out.length ? out : undefined;
}

/** The person behind an owner-only route, or a 401/403. */
function person(req: FastifyRequest): RequestIdentity {
  if (!req.authIdentity) throw new AuthFailure(401, "Authentication required.");
  if (req.authIdentity.kind !== "user") {
    throw new AuthFailure(403, "Integration tokens cannot manage tokens.");
  }
  return req.authIdentity;
}

/* ---------------------------------------------------------------- routes */

export function registerIntegrationRoutes(app: FastifyInstance): void {
  const { inspect, chatMessenger, attention, broker, store } = app.services;

  /* -- chats ------------------------------------------------------------ */

  app.get("/api/integration/chats", (req, reply) =>
    withScope(reply, async () => {
      requireScope(req, "chats:read");
      const parsed = ListChatsQuery.safeParse(req.query ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const q = parsed.data;
      if (q.projectId && !projectAllowed(req, q.projectId)) {
        return reply.code(403).send({ error: "This token cannot see that project." });
      }
      const result = await inspect.findChats({
        query: q.q,
        project: q.projectId,
        status: q.status,
        blockedOnHuman: q.blockedOnHuman,
        unmerged: q.unmerged,
        since: q.since,
        before: q.before,
        limit: q.limit,
        archived: q.archived,
        cursor: q.cursor,
      }).catch((err: unknown) => {
        // A foreign cursor or a filter nothing could match is the caller's
        // mistake, not a 500 — and not an empty list that reads as an answer.
        if (err instanceof FindCursorError || err instanceof FindFilterError) return err;
        throw err;
      });
      if (result instanceof Error) return reply.code(400).send({ error: result.message });
      // The allowlist is applied AFTER the search rather than by narrowing the
      // query: a token with two projects and no `projectId` filter needs both.
      const chats = result.chats.filter((c) => projectAllowed(req, c.projectId));
      return {
        chats,
        truncated: result.truncated,
        unscanned: result.unscanned,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      };
    }),
  );

  app.get<{ Params: { id: string } }>("/api/integration/chats/:id", (req, reply) =>
    withScope(reply, async () => {
      requireScope(req, "chats:read");
      const chat = await store.getChat(req.params.id).catch(() => null);
      if (!chat || !projectAllowed(req, chat.projectId)) {
        return reply.code(404).send({ error: "No such chat." });
      }
      return inspect.readChat({ chatId: chat.id, view: "digest" });
    }),
  );

  app.get<{ Params: { id: string } }>("/api/integration/chats/:id/messages", (req, reply) =>
    withScope(reply, async () => {
      requireScope(req, "chats:read");
      const parsed = MessagesQuery.safeParse(req.query ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const chat = await store.getChat(req.params.id).catch(() => null);
      if (!chat || !projectAllowed(req, chat.projectId)) {
        return reply.code(404).send({ error: "No such chat." });
      }
      const q = parsed.data;
      const result = await inspect.readChat({
        chatId: chat.id,
        view: "messages",
        kinds: csv(q.kinds),
        beforeId: q.before,
        afterId: q.after,
        limit: q.limit,
        fullText: q.fullText,
      });
      return {
        chat: result.chat,
        rows: result.rows,
        totalRows: result.totalRows,
        kindCounts: result.kindCounts,
        truncated: result.truncated,
      };
    }),
  );

  app.post<{ Params: { id: string } }>("/api/integration/chats/:id/messages", (req, reply) =>
    withScope(reply, async () => {
      requireScope(req, "chats:write");
      const parsed = SendBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const chat = await store.getChat(req.params.id).catch(() => null);
      if (!chat || !projectAllowed(req, chat.projectId)) {
        return reply.code(404).send({ error: "No such chat." });
      }
      // The name on the row: the token's, unless the caller relays for someone
      // and says so. A browser session (no token) is named by its user.
      const identity = req.authIdentity;
      const fallback =
        identity?.kind === "integration"
          ? identity.name
          : identity?.kind === "user"
            ? identity.user.displayName
            : "integration";
      // Trust is the TOKEN's, whatever name the caller relays under: the
      // token is the principal the owner vouched for, and `sender` is a label.
      const trust = identity?.kind === "integration" ? identity.trust : undefined;
      const result = await chatMessenger.send({
        channel: { name: parsed.data.sender ?? fallback, ...(trust === "owner" ? { trust } : {}) },
        to: chat.id,
        message: parsed.data.text,
        delivery: parsed.data.delivery ?? "queue",
      });
      if (!result.ok) {
        const status = result.refusal?.startsWith("rate-limited") ? 429 : 400;
        return reply.code(status).send({ error: result.message, refusal: result.refusal, retryAt: result.retryAt });
      }
      return reply.code(202).send({
        ok: true,
        chatId: chat.id,
        held: Boolean(result.held),
        interrupted: Boolean(result.interrupted),
        woke: Boolean(result.woke),
      });
    }),
  );

  // Its own scope: starting an agent in a repository is not "sending a message".
  app.post("/api/integration/chats", (req, reply) =>
    withScope(reply, async () => {
      requireScope(req, "chats:create");
      const parsed = CreateChatBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const body = parsed.data;
      // Same answer as an unknown project: a restricted token cannot probe for others.
      if (!projectAllowed(req, body.projectId)) return reply.code(404).send({ error: `No project "${body.projectId}".` });
      const identity = req.authIdentity;
      const channel =
        identity?.kind === "integration" ? identity.name : identity?.kind === "user" ? identity.user.displayName : "integration";
      try {
        const chat = await app.services.channelChats.create({
          channel,
          ...(identity?.kind === "integration" ? { tokenId: identity.tokenId, trust: identity.trust } : {}),
          projectId: body.projectId,
          prompt: body.text,
          ...(body.title ? { title: body.title } : {}),
          ...(body.modeId ? { modeId: body.modeId } : {}),
          ...(body.provider ? { provider: body.provider } : {}),
          ...(body.model ? { model: body.model } : {}),
          ...(body.effort ? { effort: body.effort } : {}),
        });
        return reply.code(201).send(chat);
      } catch (err) {
        if (err instanceof ChannelChatRefusal) return reply.code(err.status).send({ error: err.message });
        // Typed, not matched on wording: a regex over messages turned a store
        // failure that happened to say "model" into a 409 nobody logged.
        if (err instanceof ProviderUnavailableError) return reply.code(409).send({ error: err.message });
        throw err;
      }
    }),
  );

  // `chats:write`, not a scope of its own: interrupting a turn is already in
  // reach through `POST …/messages` with delivery "interrupt". Archiving is
  // limited to the chats this caller started — see ChannelChatService.stop.
  app.post<{ Params: { id: string } }>("/api/integration/chats/:id/stop", (req, reply) =>
    withScope(reply, async () => {
      requireScope(req, "chats:write");
      const parsed = StopBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const chat = await store.getChat(req.params.id).catch(() => null);
      if (!chat || !projectAllowed(req, chat.projectId)) {
        return reply.code(404).send({ error: "No such chat." });
      }
      const identity = req.authIdentity;
      const channel =
        identity?.kind === "integration" ? identity.name : identity?.kind === "user" ? identity.user.displayName : "integration";
      try {
        return await app.services.channelChats.stop({
          channel,
          // Ownership is by token id; a browser session (no token) is the owner.
          ...(identity?.kind === "integration" ? { tokenId: identity.tokenId } : {}),
          chatId: chat.id,
          archive: parsed.data.archive === true,
        });
      } catch (err) {
        if (err instanceof ChannelChatRefusal) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    }),
  );

  // The REST twin of `chat_archive`: archive (own chats only) or restore, and
  // nothing else — `stop` is the route that interrupts.
  app.post<{ Params: { id: string } }>("/api/integration/chats/:id/archive", (req, reply) =>
    withScope(reply, async () => {
      requireScope(req, "chats:write");
      const parsed = ArchiveBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const chat = await store.getChat(req.params.id).catch(() => null);
      if (!chat || !projectAllowed(req, chat.projectId)) return reply.code(404).send({ error: "No such chat." });
      const identity = req.authIdentity;
      const channel =
        identity?.kind === "integration" ? identity.name : identity?.kind === "user" ? identity.user.displayName : "integration";
      try {
        return await app.services.channelChats.setArchived({
          channel,
          ...(identity?.kind === "integration" ? { tokenId: identity.tokenId } : {}),
          chatId: chat.id,
          archived: parsed.data.archived,
        });
      } catch (err) {
        if (err instanceof ChannelChatRefusal) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    }),
  );

  app.get<{ Params: { id: string } }>("/api/integration/chats/:id/summary", (req, reply) =>
    withScope(reply, async () => {
      requireScope(req, "chats:read");
      const parsed = SummaryQuery.safeParse(req.query ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const chat = await store.getChat(req.params.id).catch(() => null);
      if (!chat || !projectAllowed(req, chat.projectId)) {
        return reply.code(404).send({ error: "No such chat." });
      }
      const identity = req.authIdentity;
      const caller =
        identity?.kind === "integration" ? `channel:${identity.name}` : identity?.kind === "user" ? `user:${identity.user.username}` : "anonymous";
      try {
        return await app.services.chatSummaries.summarize(chat.id, {
          caller,
          ...(parsed.data.focus ? { focus: parsed.data.focus } : {}),
        });
      } catch (err) {
        if (err instanceof SummaryRateLimitError) {
          return reply.code(429).header("Retry-After", String(Math.ceil(err.retryAfterMs / 1000))).send({ error: err.message });
        }
        if (err instanceof ProviderUnavailableError) return reply.code(409).send({ error: err.message });
        throw err;
      }
    }),
  );

  /* -- attention -------------------------------------------------------- */

  app.get("/api/integration/attention", (req, reply) =>
    withScope(reply, async () => {
      requireScope(req, "attention:read");
      // Enriched exactly as `attention_list` is — question text and options,
      // chat title, local time — so a bot can answer without a second call.
      const items = attention.list().filter((i) => projectAllowed(req, i.projectId));
      return {
        items: await buildAttentionEntries(items, {
          pending: broker.pendingPermissionSnapshot(),
          chatTitle: async (id) => (await store.getChat(id).catch(() => null))?.title,
        }),
      };
    }),
  );

  /**
   * Dismiss items — the REST twin of `attention_dismiss`. Named ids go
   * whatever their kind; without ids the sweep defaults to the retrospective
   * kinds, exactly as the SPA's `DELETE /api/attention`. Never answers or
   * denies: a dismissed permission card's tool call is still waiting.
   */
  app.post("/api/integration/attention/dismiss", (req, reply) =>
    withScope(reply, async () => {
      requireScope(req, "attention:answer");
      const parsed = DismissBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const body = parsed.data;
      if (body.ids?.length && (body.kinds || body.chatId || body.projectId)) {
        return reply.code(400).send({ error: "Pass either ids, or kinds/chatId/projectId to sweep — not both." });
      }
      if (body.projectId && !projectAllowed(req, body.projectId)) return reply.code(404).send({ error: `No project "${body.projectId}".` });
      const { removed, missing } = attention.dismiss({
        ...body,
        visible: (i) => projectAllowed(req, i.projectId),
      });
      for (const i of removed) app.cm.bus.publish({ type: "attention-resolve", id: i.id, chatId: i.chatId });
      return { dismissed: removed.map((i) => ({ id: i.id, kind: i.kind, chatId: i.chatId, summary: i.summary })), missing };
    }),
  );

  /**
   * Answer (or decline) a question card. The same path the SPA's
   * `answer-question` WS action takes — `broker.answerQuestion` — so what a bot
   * answers reaches the model exactly as a click would. Only question-kind
   * items: a PERMISSION card is a tool call waiting on a human, and a bearer
   * token answering "allow" for them is not something v1 offers.
   */
  app.post<{ Params: { id: string } }>("/api/integration/attention/:id/answer", (req, reply) =>
    withScope(reply, async () => {
      requireScope(req, "attention:answer");
      const parsed = AnswerBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      // The same function `attention_answer` calls, so the two refuse alike.
      try {
        const r = answerAttentionItem({ attention, broker }, req.params.id, parsed.data, (i) => projectAllowed(req, i.projectId));
        return { ok: true, ...r };
      } catch (err) {
        if (err instanceof AttentionAnswerError) {
          // The error's own kind, never a fresh lookup: that would name an item outside the allowlist.
          return reply.code(err.status).send({ error: err.message, ...(err.kind ? { kind: err.kind } : {}) });
        }
        throw err;
      }
    }),
  );

  /* -- events ----------------------------------------------------------- */

  // The REST twin of `events_poll`. No scope of its own: each event TYPE needs
  // the read scope its subject does (INTEGRATION_EVENT_SCOPES), so a token
  // reads the feed exactly as far as it could read the things it describes.
  app.get("/api/integration/events", async (req, reply) => {
    const parsed = EventsQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const q = parsed.data;
    const identity = req.authIdentity;
    const reach = eventReachFor(identity?.kind === "integration" ? identity : null);
    if (reach.types.length === 0) {
      return reply.code(403).send({ error: "This token has no read scope any event falls under (chats:read, projects:read or attention:read)." });
    }
    const types = csv(q.types);
    const unknown = types?.filter((t) => !isIntegrationEventType(t));
    if (unknown?.length) {
      return reply.code(400).send({ error: `Unknown event type(s): ${unknown.join(", ")}. Valid: ${INTEGRATION_EVENT_TYPES.join(", ")}.` });
    }
    let since: number | undefined;
    if (q.since) {
      since = /^\d+$/.test(q.since) ? Number(q.since) : Date.parse(q.since);
      if (!Number.isFinite(since)) return reply.code(400).send({ error: `"${q.since}" is not a time — pass epoch ms or ISO 8601.` });
    }
    if (q.projectId && !projectAllowed(req, q.projectId)) return reply.code(404).send({ error: `No project "${q.projectId}".` });
    if (q.chatId) {
      const chat = await store.getChat(q.chatId).catch(() => null);
      if (!chat || !projectAllowed(req, chat.projectId)) return reply.code(404).send({ error: "No such chat." });
    }
    try {
      return app.services.eventFeed.poll(
        {
          ...(q.cursor ? { cursor: q.cursor } : {}),
          ...(since !== undefined ? { since } : {}),
          ...(q.limit ? { limit: q.limit } : {}),
          ...(types ? { types: types.filter(isIntegrationEventType) } : {}),
          ...(q.projectId ? { projectIds: [q.projectId] } : {}),
          ...(q.chatId ? { chatId: q.chatId } : {}),
        },
        reach,
      );
    } catch (err) {
      if (err instanceof EventCursorError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  /* -- projects --------------------------------------------------------- */

  app.get("/api/integration/projects", (req, reply) =>
    withScope(reply, async () => {
      requireScope(req, "projects:read");
      const all = await inspect.projectList();
      return { projects: all.filter((p) => projectAllowed(req, p.id)) };
    }),
  );

  // The REST twin of `persona_list`: what a `personaId` may name when starting
  // a chat in this project — its own personas included, which nothing else on
  // this surface can show.
  app.get<{ Params: { id: string } }>("/api/integration/projects/:id/personas", (req, reply) =>
    withScope(reply, async () => {
      requireScope(req, "projects:read");
      const project = await store.getProject(req.params.id).catch(() => null);
      if (!project || !projectAllowed(req, project.id)) return reply.code(404).send({ error: "No such project." });
      const personas = await personasFor(store, app.services.authored, project.id);
      return { personas: personas.map((p) => ({ id: p.id, name: p.name, scope: p.scope })) };
    }),
  );

  /* -- openapi ---------------------------------------------------------- */

  app.get("/api/integration/openapi.json", async () => OPENAPI);

  /* -- token management (a person, at Settings) ------------------------ */

  const run = <T>(fn: () => Promise<T>, reply: FastifyReply): Promise<T | FastifyReply> =>
    fn().catch((error: unknown) => {
      if (error instanceof AuthFailure) return reply.code(error.status).send({ error: error.message });
      throw error;
    });

  app.get("/api/auth/tokens", (req, reply) =>
    run(async () => ({ tokens: await app.auth.listIntegrationTokens(person(req)) }), reply),
  );

  app.post("/api/auth/tokens", (req, reply) =>
    run(async () => {
      const parsed = CreateTokenBody.safeParse(req.body ?? {});
      if (!parsed.success) throw new AuthFailure(400, parsed.error.message);
      const input: IntegrationTokenCreateRequest = parsed.data;
      // The ONE response that carries the value. Not logged by the request log
      // (it records paths and statuses, never bodies) and never written again.
      return app.auth.mintIntegrationToken(person(req), input);
    }, reply),
  );

  app.patch<{ Params: { id: string } }>("/api/auth/tokens/:id", (req, reply) =>
    run(async () => {
      const parsed = UpdateTokenBody.safeParse(req.body ?? {});
      if (!parsed.success) throw new AuthFailure(400, parsed.error.message);
      return { token: await app.auth.setIntegrationTokenTrust(person(req), req.params.id, parsed.data.trust) };
    }, reply),
  );

  app.delete<{ Params: { id: string } }>("/api/auth/tokens/:id", (req, reply) =>
    run(async () => {
      await app.auth.revokeIntegrationToken(person(req), req.params.id);
      return { ok: true };
    }, reply),
  );
}

/* --------------------------------------------------------------- openapi */

const bearer = { bearerAuth: [] as string[] };
const scoped = (scope: string) => ({ "x-scope": scope, security: [bearer] });

/**
 * Hand-written rather than generated: the surface is six routes and the point
 * of the document is to be read by a person wiring a bot, so every route says
 * its scope in `x-scope` and the schemas stay short.
 */
const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "Dispatch integration API",
    version: "1",
    description:
      "A curated surface for bots and scripts holding an integration token " +
      "(`Authorization: Bearer dsp_…`). Every route names the scope it needs; a " +
      "missing scope is a 403 with the scope in the body. 60 requests per minute " +
      "per token; a 429 carries `Retry-After`.",
  },
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    schemas: {
      Scope: { type: "string", enum: [...INTEGRATION_SCOPES] },
      ChatSummary: {
        type: "object",
        properties: {
          id: { type: "string" }, title: { type: "string" }, projectId: { type: "string" },
          projectName: { type: "string" }, status: { type: "string" }, archived: { type: "boolean" },
          harness: { type: "string" }, model: { type: "string" },
          createdAt: { type: "integer" }, updatedAt: { type: "integer" },
        },
      },
      AttentionItem: {
        type: "object",
        properties: {
          id: { type: "string" }, chatId: { type: "string" },
          kind: { type: "string", enum: ["permission", "question", "idle", "done", "review"] },
          summary: { type: "string" }, projectId: { type: "string" }, createdAt: { type: "integer" },
        },
      },
    },
  },
  paths: {
    "/api/integration/chats": {
      get: {
        ...scoped("chats:read"),
        summary: "List chats",
        description: "A search with `q` stops at a scan budget; when it does, `truncated` is true and " +
          "`nextCursor` continues it — repeat the request with the same parameters plus `cursor`.",
        parameters: [
          ...["projectId", "q", "cursor"].map((name) => ({ name, in: "query", schema: { type: "string" } })),
          ...["since", "before", "limit"].map((name) => ({ name, in: "query", schema: { type: "integer" } })),
          { name: "status", in: "query", schema: { type: "string", enum: ["idle", "queued", "running", "waiting", "awaiting-input", "done", "failed", "error"] } },
          { name: "blockedOnHuman", in: "query", schema: { type: "boolean" }, description: "true: only chats a permission prompt or question is holding" },
          { name: "unmerged", in: "query", schema: { type: "boolean" }, description: "true: only chats with a PR still open; every chat's `prStatus` carries state, CI and review" },
          { name: "archived", in: "query", schema: { type: "boolean" } },
        ],
        responses: { "200": { description: "Chats", content: { "application/json": { schema: {
          type: "object", properties: {
            chats: { type: "array", items: { $ref: "#/components/schemas/ChatSummary" } },
            truncated: { type: "boolean" }, unscanned: { type: "integer" }, nextCursor: { type: "string" },
          },
        } } } }, "400": { description: "A cursor from a different search, an unknown status, or an empty time window" } },
      },
      post: { ...scoped("chats:create"), summary: "Start a new chat in a project; the first message is attributed to this integration",
        description: "Runs in the project's default mode unless `modeId` names another; a mode that bypasses permission prompts is refused (403).",
        requestBody: { required: true, content: { "application/json": { schema: {
          type: "object", required: ["projectId", "text"],
          properties: {
            projectId: { type: "string" }, text: { type: "string" }, title: { type: "string" },
            modeId: { type: "string" }, provider: { type: "string" }, model: { type: "string" },
            effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
          },
        } } } },
        responses: { "201": { description: "Created and briefed" }, "403": { description: "Bypass mode refused" }, "404": { description: "No such project" }, "409": { description: "No provider can run it, or the brief was refused" } } },
    },
    "/api/integration/chats/{id}/stop": {
      post: { ...scoped("chats:write"), summary: "Interrupt the chat's running turn — the Stop button; optionally archive it",
        description: "`archive: true` also releases the chat's session and archives it, and is allowed only for a chat this integration started (403 otherwise).",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: {
          type: "object", properties: { archive: { type: "boolean" } },
        } } } },
        responses: { "200": { description: "`interrupted` says whether a turn was running; `archived` its state now" }, "403": { description: "Archive refused: not started by this integration" }, "404": { description: "No such chat" } } },
    },
    "/api/integration/chats/{id}/archive": {
      post: { ...scoped("chats:write"), summary: "Archive a chat (only one this integration started) or restore any — without interrupting it",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: {
          type: "object", required: ["archived"], properties: { archived: { type: "boolean" } },
        } } } },
        responses: { "200": { description: "`{ chatId, title, projectId, archived, changed }`" }, "403": { description: "Archive refused: not started by this integration" }, "404": { description: "No such chat" } } },
    },
    "/api/integration/chats/{id}/summary": {
      get: { ...scoped("chats:read"), summary: "A model's summary of the chat — cached until it changes, rate-limited per token",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "focus", in: "query", schema: { type: "string" }, description: "What the reader specifically wants to know" },
        ],
        responses: { "200": { description: "Summary" }, "404": { description: "No such chat" }, "409": { description: "The chat's provider is unavailable" }, "429": { description: "Summary rate limit" } } },
    },
    "/api/integration/chats/{id}": {
      get: { ...scoped("chats:read"), summary: "A chat's digest: its summary, the human's messages, and any problems",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Digest" }, "404": { description: "No such chat" } } },
    },
    "/api/integration/chats/{id}/messages": {
      get: { ...scoped("chats:read"), summary: "Transcript rows, newest last, paged by row id",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "kinds", in: "query", schema: { type: "string" }, description: "Comma-separated row kinds (user, assistant, tool_use, …)" },
          { name: "before", in: "query", schema: { type: "string" } },
          { name: "after", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "fullText", in: "query", schema: { type: "boolean" }, description: "User and assistant text unclipped (tool payloads stay clipped)" },
        ],
        responses: { "200": { description: "Rows" } } },
      post: { ...scoped("chats:write"), summary: "Send a message into a chat, attributed to this integration",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: {
          type: "object", required: ["text"],
          properties: { text: { type: "string" }, delivery: { type: "string", enum: ["queue", "interrupt"] }, sender: { type: "string" } },
        } } } },
        responses: { "202": { description: "Accepted; `held` when the chat was mid-turn" }, "429": { description: "Peer rate limit" } } },
    },
    "/api/integration/attention": {
      get: { ...scoped("attention:read"), summary: "Everything waiting on a human",
        responses: { "200": { description: "Items", content: { "application/json": { schema: {
          type: "object", properties: { items: { type: "array", items: { $ref: "#/components/schemas/AttentionItem" } } },
        } } } } } },
    },
    "/api/integration/attention/dismiss": {
      post: { ...scoped("attention:answer"), summary: "Dismiss items: named ids whatever their kind, or a sweep of kinds (default idle, done, review)",
        description: "Pass `ids`, or `kinds`/`chatId`/`projectId` — not both. Dismissing never answers or denies; a permission card's tool call keeps waiting.",
        requestBody: { content: { "application/json": { schema: {
          type: "object",
          properties: {
            ids: { type: "array", items: { type: "string" } },
            kinds: { type: "array", items: { type: "string", enum: ["permission", "question", "idle", "done", "review"] } },
            chatId: { type: "string" }, projectId: { type: "string" },
          },
        } } } },
        responses: { "200": { description: "`{ dismissed: [{ id, kind, chatId, summary }], missing: [id] }`" }, "400": { description: "Both ids and a sweep" } } },
    },
    "/api/integration/attention/{id}/answer": {
      post: { ...scoped("attention:answer"), summary: "Answer or decline a question card",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: {
          type: "object",
          properties: {
            answer: { type: "string" }, optionId: { type: "string" }, notes: { type: "string" },
            answers: { type: "array", items: { type: "object", properties: {
              questionIndex: { type: "integer" }, optionId: { type: "string" }, answer: { type: "string" }, notes: { type: "string" },
            } } },
            decline: { type: "boolean" },
          },
        } } } },
        responses: { "200": { description: "Answered" }, "409": { description: "Not a pending question" } } },
    },
    "/api/integration/events": {
      get: {
        security: [bearer],
        "x-scope": "chats:read | projects:read | attention:read (per event type)",
        summary: "The event feed: chats that settled, PRs opened/merged/closed, attention raised/resolved — oldest first, from a cursor",
        description: "Store `nextCursor` and pass it back as `cursor`; it survives server restarts. Without a cursor (and without `since`) " +
          "the newest page is returned. Each event type is visible only with the read scope its subject needs. " +
          "`gap: true` means events between your cursor and this page were pruned (7-day retention).",
        parameters: [
          { name: "cursor", in: "query", schema: { type: "string" } },
          { name: "since", in: "query", schema: { type: "string" }, description: "Epoch ms or ISO 8601. Ignored when `cursor` is given — the cursor is authoritative" },
          { name: "limit", in: "query", schema: { type: "integer", maximum: INTEGRATION_EVENT_PAGE_MAX } },
          { name: "types", in: "query", schema: { type: "string" }, description: `Comma-separated: ${INTEGRATION_EVENT_TYPES.join(", ")}` },
          { name: "projectId", in: "query", schema: { type: "string" } },
          { name: "chatId", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "`{ events: [{ id, type, chatId, projectId, ts, tsLocal, payload }], nextCursor, hasMore, gap? }`" },
          "400": { description: "Bad cursor, time or type" }, "403": { description: "No read scope" }, "404": { description: "No such project or chat" } },
      },
    },
    "/api/integration/projects": {
      get: { ...scoped("projects:read"), summary: "Every project this token can see", responses: { "200": { description: "Projects" } } },
    },
    "/api/integration/projects/{id}/personas": {
      get: { ...scoped("projects:read"), summary: "The personas a chat started in this project can run as — each `id` is a valid `personaId`, with its display `name`",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "`{ personas: [{ id, name, scope }] }`" }, "404": { description: "No such project" } } },
    },
    "/api/integration/openapi.json": {
      get: { summary: "This document", security: [bearer], responses: { "200": { description: "OpenAPI" } } },
    },
  },
};
