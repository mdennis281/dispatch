/**
 * OAuth, both roles — every HTTP endpoint. See docs/plugins.md → "OAuth".
 *
 * AUTHORIZATION SERVER (Dispatch issues tokens to connectors)
 *   GET  /.well-known/oauth-authorization-server     RFC 8414, public
 *   GET  /.well-known/oauth-protected-resource[/*]   RFC 9728, public
 *   POST /api/oauth/register                         RFC 7591 — gate-exempt (see app.ts)
 *   GET  /oauth/authorize                            browser navigation → parks the request, redirects to #oauth=<nonce>
 *   GET  /api/oauth/requests/:nonce                  consent page data — owner's session bearer
 *   POST /api/oauth/requests/:nonce/decision         { approve } → { redirectUrl } — owner's session bearer
 *   POST /api/oauth/token                            code + PKCE / rotating refresh — gate-exempt
 *   POST /api/oauth/revoke                           RFC 7009 — gate-exempt
 *   GET  /api/auth/oauth/grants                      Settings → Integrations — owner
 *   DELETE /api/auth/oauth/grants/:id                revoke a grant family — owner
 *
 * CLIENT FLOW (Dispatch obtains tokens for a plugin)
 *   POST /api/plugins/:id/oauth/:name/connect        { url } — session bearer
 *   DELETE /api/plugins/:id/oauth/:name              forget the tokens — session bearer
 *   GET  /oauth/callback/:plugin/:name               provider redirect → stores tokens, redirects to #settings=plugins
 *
 * THE PATH SPLIT IS THE DESIGN. The auth gate authenticates `/api/*` from a
 * bearer header; a browser navigation carries none. So every step a BROWSER
 * performs (`/oauth/authorize`, `/oauth/callback/…`, the well-known
 * documents) lives outside `/api/`, and the only `/api/oauth/` routes exempt
 * from the gate are the three that are the credential exchange itself and
 * carry their own proof (a PKCE verifier, a client secret, a refresh token).
 * The consent decision is deliberately NOT one of them: it is the one step
 * that must come from the owner's logged-in session.
 *
 * CORS on the public endpoints: a browser-resident MCP client (the Inspector's
 * UI) performs discovery, registration and the token exchange from its own
 * origin. `*` is safe here because none of these endpoints read a cookie or a
 * session bearer — what they read, they read from the body.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as z from "zod";
import { AuthFailure, type RequestIdentity } from "../services/auth.js";
import { OAuthError, type ClientCredentials } from "../services/oauth-server.js";
import { PluginOAuthError } from "../plugins/oauth.js";
import { PluginNotFound } from "../plugins/service.js";

const DecisionBody = z.object({ approve: z.boolean() });

/** Where the plugin callback lands the browser. `oauthError` rides in the hash for the pane's toast. */
function pluginsPage(error?: string): string {
  const hash = new URLSearchParams({ settings: "plugins", ...(error ? { oauthError: error } : {}) });
  return `/#${hash.toString()}`;
}

function cors(reply: FastifyReply): FastifyReply {
  return reply
    .header("access-control-allow-origin", "*")
    .header("access-control-allow-methods", "GET, POST, OPTIONS")
    .header("access-control-allow-headers", "authorization, content-type, mcp-protocol-version")
    .header("access-control-max-age", "600");
}

/** The person behind an owner-only route, or a 401/403. */
function owner(req: FastifyRequest): RequestIdentity {
  if (!req.authIdentity) throw new AuthFailure(401, "Authentication required.");
  if (req.authIdentity.kind !== "user") throw new AuthFailure(403, "Integration tokens cannot authorize connectors.");
  if (!req.authIdentity.user.owner) throw new AuthFailure(403, "Only the owner can authorize connectors.");
  return req.authIdentity;
}

/**
 * RFC 6749 §2.3.1: credentials in the body, or as HTTP Basic with the client
 * id as the username. Both are accepted; a client that sends both must agree
 * with itself.
 */
function clientCredentials(req: FastifyRequest, body: Record<string, unknown>): ClientCredentials {
  const header = req.headers.authorization;
  if (header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon >= 0) {
      return {
        clientId: decodeURIComponent(decoded.slice(0, colon)),
        clientSecret: decodeURIComponent(decoded.slice(colon + 1)),
        basic: true,
      };
    }
  }
  return {
    ...(typeof body.client_id === "string" ? { clientId: body.client_id } : {}),
    ...(typeof body.client_secret === "string" ? { clientSecret: body.client_secret } : {}),
    basic: false,
  };
}

function formBody(req: FastifyRequest): Record<string, unknown> {
  const body = req.body;
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

/** A minimal page for the one error that must not redirect: a bad client or redirect URI. */
function errorPage(message: string): string {
  const safe = message.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return `<!doctype html><meta charset="utf-8"><title>Dispatch — authorization refused</title>` +
    `<body style="font-family:system-ui;margin:3rem auto;max-width:36rem;line-height:1.5">` +
    `<h1 style="font-size:1.25rem">Authorization refused</h1><p>${safe}</p>` +
    `<p style="color:#666">Dispatch did not redirect you back to the application because it could not verify where the request came from.</p></body>`;
}

export function registerOAuthRoutes(app: FastifyInstance): void {
  const server = app.oauthServer;
  const { pluginOAuth, plugins } = app.services;

  /** Map the two error classes to their status; everything else is a 500. */
  const run = async <T>(reply: FastifyReply, fn: () => Promise<T> | T): Promise<T | FastifyReply> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof OAuthError) return reply.code(err.status).header("cache-control", "no-store").send(err.body());
      if (err instanceof AuthFailure) return reply.code(err.status).send({ error: err.message });
      if (err instanceof PluginOAuthError) return reply.code(err.status).send({ error: err.message });
      if (err instanceof PluginNotFound) return reply.code(404).send({ error: err.message });
      throw err;
    }
  };

  /* -------------------------------------------------------- discovery */

  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/*", "/api/oauth/register", "/api/oauth/token", "/api/oauth/revoke"]) {
    app.options(path, async (_req, reply) => cors(reply).code(204).send());
  }

  app.get("/.well-known/oauth-authorization-server", (_req, reply) =>
    run(cors(reply), async () => server.metadata()),
  );
  app.get("/.well-known/oauth-protected-resource", (_req, reply) =>
    run(cors(reply), async () => server.protectedResource()),
  );
  app.get<{ Params: { "*": string } }>("/.well-known/oauth-protected-resource/*", (req, reply) =>
    run(cors(reply), async () => server.protectedResource(`/${req.params["*"] ?? ""}`)),
  );

  /* ----------------------------------------------------- registration */

  app.post("/api/oauth/register", (req, reply) =>
    run(cors(reply), async () => {
      const created = await server.register(req.body ?? {}, req.ip);
      return reply.code(201).header("cache-control", "no-store").send(created);
    }),
  );

  /* -------------------------------------------------------- authorize */

  app.get("/oauth/authorize", async (req, reply) => {
    try {
      const { redirectUrl } = await server.authorize(req.query);
      return reply.header("cache-control", "no-store").redirect(redirectUrl, 302);
    } catch (err) {
      // The unredirectable errors — unknown client, unregistered redirect URI,
      // OAuth not offered. Shown to the person, never bounced to a URL the
      // request named, or this endpoint would be an open redirector.
      const message = err instanceof OAuthError ? err.message : err instanceof z.ZodError ? "The authorization request is malformed." : "The authorization request could not be processed.";
      const status = err instanceof OAuthError ? err.status : 400;
      return reply.code(status).type("text/html; charset=utf-8").send(errorPage(message));
    }
  });

  app.get<{ Params: { nonce: string } }>("/api/oauth/requests/:nonce", (req, reply) =>
    run(reply, () => {
      owner(req);
      return server.requestView(req.params.nonce);
    }),
  );

  app.post<{ Params: { nonce: string } }>("/api/oauth/requests/:nonce/decision", (req, reply) =>
    run(reply, () => {
      owner(req);
      const parsed = DecisionBody.safeParse(req.body ?? {});
      if (!parsed.success) throw new AuthFailure(400, "approve (boolean) is required.");
      return server.decide(req.params.nonce, parsed.data.approve);
    }),
  );

  /* ------------------------------------------------------------ token */

  app.post("/api/oauth/token", (req, reply) =>
    run(cors(reply), async () => {
      const body = formBody(req);
      const creds = clientCredentials(req, body);
      try {
        const issued = await server.token(body, creds);
        return reply.header("cache-control", "no-store").header("pragma", "no-cache").send(issued);
      } catch (err) {
        // §5.2: a failed Basic authentication answers with the matching challenge.
        if (err instanceof OAuthError && err.status === 401 && creds.basic) reply.header("www-authenticate", 'Basic realm="dispatch"');
        throw err;
      }
    }),
  );

  app.post("/api/oauth/revoke", (req, reply) =>
    run(cors(reply), async () => {
      const body = formBody(req);
      await server.revoke(body, clientCredentials(req, body));
      return reply.code(200).header("cache-control", "no-store").send({});
    }),
  );

  /* ----------------------------------------------------------- grants */

  app.get("/api/auth/oauth/grants", (req, reply) =>
    run(reply, () => {
      owner(req);
      return { grants: server.listGrants() };
    }),
  );

  app.delete<{ Params: { id: string } }>("/api/auth/oauth/grants/:id", (req, reply) =>
    run(reply, async () => {
      owner(req);
      if (!(await server.revokeGrant(req.params.id))) throw new AuthFailure(404, "Grant not found.");
      return { ok: true };
    }),
  );

  /* ------------------------------------------------------ plugin flow */

  app.post<{ Params: { id: string; name: string } }>("/api/plugins/:id/oauth/:name/connect", (req, reply) =>
    run(reply, async () => {
      const identity = req.authIdentity;
      if (identity && identity.kind !== "user") throw new AuthFailure(403, "Integration tokens cannot connect plugins.");
      // The origin this click arrived on backs the redirect URL only when no
      // canonical URL is configured — an auth-off dev instance has none.
      const fallbackOrigin = `${req.protocol}://${req.headers.host ?? "localhost"}`;
      const url = await pluginOAuth.connectUrl(req.params.id, req.params.name, {
        ...(identity ? { sessionId: identity.sessionId } : {}),
        fallbackOrigin,
      });
      return { url };
    }),
  );

  app.delete<{ Params: { id: string; name: string } }>("/api/plugins/:id/oauth/:name", (req, reply) =>
    run(reply, async () => {
      if (req.authIdentity && req.authIdentity.kind !== "user") throw new AuthFailure(403, "Integration tokens cannot disconnect plugins.");
      await pluginOAuth.disconnect(req.params.id, req.params.name);
      const info = plugins.get(req.params.id);
      if (!info) throw new PluginNotFound(req.params.id);
      return info;
    }),
  );

  app.get<{ Params: { plugin: string; name: string } }>("/oauth/callback/:plugin/:name", async (req, reply) => {
    const query = req.query && typeof req.query === "object" ? (req.query as Record<string, unknown>) : {};
    const result = await pluginOAuth.handleCallback(req.params.plugin, req.params.name, query);
    return reply.header("cache-control", "no-store").redirect(result.ok ? pluginsPage() : pluginsPage(result.error), 302);
  });
}
