/**
 * REST for the composer's model picker and the provider/account lists.
 *   GET /api/models                          → ModelOption[]  (cached ~5min)
 *   GET /api/models?refresh=1                → ModelOption[]  (re-probe the runtime now)
 *   GET /api/models?subscription=<id>        → that ACCOUNT's list
 *   GET /api/models/context-windows?harness= → { [modelId]: tokens }, from the runtime
 *   GET /api/harnesses                       → registered providers + capabilities
 *   GET /api/subscriptions                   → every account, with login presence
 *   PUT /api/subscriptions                   → replace the stored account list
 *   POST   /api/subscriptions/:id/login      → start the provider's sign-in (owner only)
 *   GET    /api/subscriptions/:id/login      → { flow } — that sign-in's progress, null when none (owner only)
 *   POST   /api/subscriptions/:id/login/code → { code } relayed to the CLI (owner only)
 *   DELETE /api/subscriptions/:id/login      → cancel it (owner only)
 *
 * Models are live from each runtime's own list, which works on subscription auth
 * with no API key. See packages/plugins/claude/src/models.ts.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  SubscriptionListSchema,
  providerFor,
  findSubscription,
  subscriptionFor,
} from "@dispatch/shared";
import { accountOf, subscriptionStatuses } from "../services/subscriptions.js";
import { AccountLoginError } from "../services/account-login.js";

/**
 * Signing a machine into a paid account is the owner's call, the way installing
 * a plugin is: an invited user or an integration token must not be able to
 * re-point an account's directory at their own login.
 */
function refuseNonOwner(req: FastifyRequest, reply: FastifyReply): FastifyReply | null {
  const who = req.authIdentity;
  if (!who) return null;
  if (who.kind !== "user") return reply.code(403).send({ error: "Integration tokens cannot sign accounts in." });
  if (!who.user.owner) return reply.code(403).send({ error: "Only the owner can sign accounts in." });
  return null;
}

function loginFailure(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AccountLoginError) return reply.code(err.status).send({ error: err.message });
  throw err;
}

export function registerModelRoutes(app: FastifyInstance): void {
  const { store } = app.cm;

  app.get<{ Querystring: { refresh?: string; harness?: string; subscription?: string } }>(
    "/api/models",
    async (req) => {
      const settings = await store.getSettings().catch(() => null);
      const kind = req.query.harness;
      // No runtime, no catalogue — and no provider asked for, no catalogue
      // either. Answering either with the default's list put Claude ids in a
      // picker for a chat that could never send them.
      const harness = kind ? app.services.harnesses.find(kind) : undefined;
      if (!kind || !harness) return [];
      // A named account wins, but only on ITS provider: `?harness=codex&subscription=claude2`
      // is a stale client, and answering it with Claude's catalogue would put a
      // Claude id in a Codex picker.
      const named = findSubscription(settings, req.query.subscription);
      const sub = named?.provider === kind ? named : subscriptionFor(settings, kind);
      return harness.listModels({ refresh: req.query.refresh === "1", account: accountOf(sub) });
    },
  );

  // Same provider/account resolution as the list above, so a window is read
  // from the account whose catalogue the row came from.
  app.get<{ Querystring: { refresh?: string; harness?: string } }>(
    "/api/models/context-windows",
    async (req) => {
      const settings = await store.getSettings().catch(() => null);
      const kind = req.query.harness;
      const harness = kind ? app.services.harnesses.find(kind) : undefined;
      if (!kind || !harness) return {};
      const windows = await harness.contextWindows?.({
        refresh: req.query.refresh === "1",
        account: accountOf(subscriptionFor(settings, kind)),
      });
      return windows ?? {};
    },
  );

  app.get("/api/harnesses", async () =>
    app.services.harnesses.list().map((harness) => ({
      kind: harness.kind,
      runtime: harness.runtime(),
      capabilities: harness.capabilities,
      // The client's labels, pickers and account pane read the descriptor, and
      // only the server knows the ones a plugin registered.
      descriptor: providerFor(harness.kind),
      // The DEFAULT account's cached login, so the composer can show
      // "not logged in" before a send is refused. Absent until probed.
      ...(app.services.logins?.peek(harness.kind) ? { login: app.services.logins.peek(harness.kind) } : {}),
    })),
  );

  // Both the read and the save answer with this, so a pane that just saved its
  // list keeps its "Log in" buttons and login badges instead of losing them
  // until the next visit re-reads.
  const decorate = (statuses: ReturnType<typeof subscriptionStatuses>) =>
    statuses.map((status) => {
      // Each account's own cached login, so the composer judges a chat pinned
      // to a second account by THAT account's probe, as the broker does (#428).
      const login = app.services.logins?.peek(status.provider, accountOf(status));
      const canLogIn = app.services.accountLogins?.supports(status.provider) ?? false;
      return { ...status, ...(login ? { login } : {}), ...(canLogIn ? { canLogIn } : {}) };
    });

  app.get("/api/subscriptions", async () => {
    const settings = await store.getSettings().catch(() => null);
    return decorate(subscriptionStatuses(settings));
  });

  app.post<{ Params: { id: string } }>("/api/subscriptions/:id/login", async (req, reply) => {
    if (refuseNonOwner(req, reply)) return reply;
    try {
      return await app.services.accountLogins.start(req.params.id);
    } catch (err) {
      return loginFailure(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/api/subscriptions/:id/login", async (req, reply) => {
    if (refuseNonOwner(req, reply)) return reply;
    // "None ran" is an answer, not an error: the pane asks on every visit, and
    // a 404 per account was a console full of red for nothing.
    return { flow: app.services.accountLogins.get(req.params.id) ?? null };
  });

  app.post<{ Params: { id: string }; Body: { code?: unknown } }>(
    "/api/subscriptions/:id/login/code",
    async (req, reply) => {
      if (refuseNonOwner(req, reply)) return reply;
      const code = req.body?.code;
      if (typeof code !== "string" || !code.trim() || code.length > 4096) {
        return reply.code(400).send({ error: "A code is required." });
      }
      try {
        return app.services.accountLogins.submitCode(req.params.id, code);
      } catch (err) {
        return loginFailure(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/api/subscriptions/:id/login", async (req, reply) => {
    if (refuseNonOwner(req, reply)) return reply;
    app.services.accountLogins.cancel(req.params.id);
    return { ok: true };
  });

  /**
   * Replace the stored list. Its own route rather than a field of the settings
   * PUT, which preserves `subscriptions` by hand: the settings pane round-trips
   * a whole draft, and a draft loaded before an account was added would
   * otherwise delete it on the next theme change.
   *
   * Removing an account that chats are pinned to is allowed — those chats fall
   * back to their provider's default account (see `subscriptionFor`). Refusing
   * would make a deleted login directory impossible to clean up after.
   */
  app.put("/api/subscriptions", async (req, reply) => {
    const parsed = SubscriptionListSchema.safeParse(
      (req.body as { subscriptions?: unknown } | null)?.subscriptions,
    );
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const current = await store.getSettings();
    const saved = await store.saveSettings({ ...current, subscriptions: parsed.data });
    return decorate(subscriptionStatuses(saved));
  });
}
