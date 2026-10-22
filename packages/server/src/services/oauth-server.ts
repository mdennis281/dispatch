/**
 * DISPATCH AS AN OAUTH 2.1 AUTHORIZATION SERVER — for remote-MCP connectors.
 *
 * A connector (Claude.ai, ChatGPT, Grok, the MCP Inspector) discovers the
 * metadata document, registers itself (RFC 7591), sends the owner through the
 * consent page with PKCE, and exchanges the code for an ACCESS TOKEN THAT IS AN
 * ORDINARY INTEGRATION TOKEN — minted through `AuthService.mintIntegrationToken`
 * with `clientId` set, one hour long, fenced by the auth gate to the
 * integration surface exactly like a hand-minted one — plus a rotating
 * refresh token. Nothing a connector obtains here can reach anything a `dsp_`
 * token could not.
 *
 * Three things this class is strict about, each because the lenient version
 * is a known attack:
 *
 *   - PKCE S256 IS MANDATORY and `plain` is refused. Public clients (every
 *     MCP connector) have no secret; the verifier is the only thing binding
 *     the token request to the browser that consented.
 *   - REDIRECT URIS MATCH EXACTLY against what the client registered. A prefix
 *     or host match lets an attacker registered on the same host receive
 *     somebody else's code.
 *   - REFRESH TOKENS ROTATE, AND REUSE REVOKES THE FAMILY. A refresh token
 *     that is presented twice was stolen or leaked; neither party keeps the
 *     grant.
 *
 * Where it lives: clients, grants and refresh-token hashes in this instance's
 * state database (schema step 9); authorization codes and consent nonces in
 * memory, because they live a minute and ten minutes and a restart that
 * drops them costs one more click.
 *
 * NEVER log a token or a code. They enter {@link token} and {@link revoke} as
 * fields of a parsed body and are hashed on the first line that touches them.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  OFFERABLE_INTEGRATION_SCOPES,
  OAUTH_ACCESS_TOKEN_SECONDS,
  isOfferableIntegrationScope,
  OAUTH_AUTHORIZE_NONCE_MS,
  OAUTH_CODE_MS,
  OAUTH_REFRESH_TOKEN_DAYS,
  OAUTH_REFRESH_TOKEN_PREFIX,
  INTEGRATION_TOKEN_NAME_MAX,
  parseIntegrationScopes,
  type IntegrationScope,
  type OAuthDecisionResult,
  type OAuthGrantSummary,
  type OAuthRequestView,
} from "@dispatch/shared";
import * as z from "zod";
import type { Store } from "../store/index.js";
import type { AuthService } from "./auth.js";

/* ----------------------------------------------------------------- errors */

/**
 * An RFC 6749 §5.2 error. `status` is what the HTTP layer answers; `code` and
 * `description` are the `error` / `error_description` body the connector
 * reads. Thrown from every entry point so the route layer has one catch.
 */
export class OAuthError extends Error {
  constructor(
    public status: number,
    public code: string,
    description: string,
  ) {
    super(description);
    this.name = "OAuthError";
  }

  body(): { error: string; error_description: string } {
    return { error: this.code, error_description: this.message };
  }
}

/* ------------------------------------------------------------------ shapes */

const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
type AuthMethod = (typeof AUTH_METHODS)[number];

/** One registered connector, the JSON body of an `oauth_client` row. */
const StoredClientSchema = z.object({
  id: z.string(),
  name: z.string(),
  redirectUris: z.array(z.string()),
  authMethod: z.enum(AUTH_METHODS),
  /** SHA-256 (base64url) of the client secret, confidential clients only. */
  secretHash: z.string().optional(),
  /** The scopes the client may ask for. Registration without `scope` gets every one. */
  scopes: z.array(z.string()),
  createdAt: z.number(),
});
type StoredClient = z.infer<typeof StoredClientSchema>;

/** The RFC 7591 request body, with the fields Dispatch acts on. Unknown fields are ignored. */
const RegistrationSchema = z.object({
  redirect_uris: z.array(z.string().min(1)).min(1),
  client_name: z.string().trim().min(1).max(INTEGRATION_TOKEN_NAME_MAX).optional(),
  token_endpoint_auth_method: z.enum(AUTH_METHODS).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().optional(),
});

/** The authorization request. Everything is a string because it is a query. */
const AuthorizeQuerySchema = z.object({
  response_type: z.string().optional(),
  client_id: z.string().optional(),
  redirect_uri: z.string().optional(),
  scope: z.string().optional(),
  state: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
  /** RFC 8707. Accepted and recorded; see {@link OAuthServer.authorize}. */
  resource: z.string().optional(),
});

interface PendingAuthorization {
  nonce: string;
  client: StoredClient;
  redirectUri: string;
  scopes: IntegrationScope[];
  state?: string;
  codeChallenge: string;
  resource?: string;
  expiresAt: number;
}

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  scopes: IntegrationScope[];
  codeChallenge: string;
  expiresAt: number;
  /** Set once exchanged — a second exchange is the RFC 6749 §4.1.2 reuse case. */
  usedForGrant?: string;
}

interface GrantRow {
  id: string;
  client_id: string;
  scopes: string;
  auth_epoch: number;
  created_at: number;
  last_refreshed_at: number | null;
  revoked_at: number | null;
  access_token_id: string | null;
}

interface RefreshRow {
  hash: string;
  grant_id: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

/** How a token-endpoint caller identified itself. */
export interface ClientCredentials {
  /** From the body, or the Basic header's username. */
  clientId?: string;
  /** From the body, or the Basic header's password. */
  clientSecret?: string;
  /** Whether a Basic header carried the credentials (changes the 401's challenge). */
  basic: boolean;
}

export interface OAuthServerDeps {
  store: Store;
  auth: AuthService;
  now?: () => number;
}

/** Registrations one address may make per hour before it is told to wait. */
const REGISTER_PER_HOUR = 20;
const HOUR_MS = 60 * 60_000;

/** Authorization requests one address may park per minute. Unauthenticated, so bounded. */
const AUTHORIZE_PER_MINUTE = 30;
const MINUTE_MS = 60_000;

/**
 * Most parked authorization requests (and codes) held at once, across every
 * address. Past this the oldest is evicted: the owner can only be looking at
 * one consent page, so a backlog that deep is a flood, not a queue.
 */
const MAX_PENDING = 500;

/**
 * How long after a refresh token was rotated a second presentation of it is
 * read as a lost response rather than a theft. Long enough for a timed-out
 * retry; far shorter than any window an attacker could plan around.
 */
const OAUTH_REFRESH_REUSE_GRACE_MS = 30_000;

const DAY_MS = 24 * 60 * 60_000;

/**
 * The at-rest form of a refresh token or client secret: a plain SHA-256, the
 * same treatment `hashIntegrationToken` gives a `dsp_` token.
 *
 * NOT a password hash, on purpose. Every value that reaches this function is
 * 32 bytes from `randomBytes` — 256 bits of entropy — so there is nothing for
 * a KDF to stretch: brute-forcing the preimage of SHA-256 over that space is
 * as hard as brute-forcing argon2 over it. The owner's PASSWORD, which a
 * human chose and a KDF exists for, goes through argon2id in auth.ts. And a
 * salted KDF could not serve here anyway: the token endpoint has to find the
 * row BY the presented value, which needs a deterministic fingerprint, not a
 * per-row salt. (CodeQL's password-hash rule keys on the identifier name
 * containing "TOKEN" and cannot see the entropy; it is excluded project-wide
 * in .github/codeql/codeql-config.yml with this same reasoning.)
 */
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
}

/**
 * Whether a redirect URI is one Dispatch will send a code to. `https` and
 * custom schemes (native apps: `cursor://…`) are fine; plain `http` only on a
 * loopback host — the MCP Inspector listens on `http://localhost:6274`, and a
 * code sent over cleartext to any other host is a code sent to the network.
 * Fragments are refused by RFC 6749 §3.1.2.
 */
function redirectUriAllowed(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return isLoopbackHost(url.hostname);
  // A custom scheme has no host to speak of; accept it as a native-app target.
  return url.protocol.length > 1 && !url.protocol.startsWith("javascript");
}

/** Append `params` to a redirect URI's query, keeping whatever query it already had. */
function withQuery(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

export class OAuthServer {
  private readonly store: Store;
  private readonly auth: AuthService;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, IssuedCode>();
  private readonly registerHits = new Map<string, number[]>();
  private readonly authorizeHits = new Map<string, number[]>();

  constructor(deps: OAuthServerDeps) {
    this.store = deps.store;
    this.auth = deps.auth;
    this.now = deps.now ?? (() => Date.now());
  }

  /* --------------------------------------------------------- availability */

  /**
   * Whether this instance advertises itself, and as what issuer.
   *
   * Two conditions, both load-bearing. AUTH MUST BE ON: with it off there are
   * no sessions to consent with and no tokens to mint (`mintIntegrationToken`
   * refuses), so the flow could only end in a 409 after the connector had done
   * all its work. THE CANONICAL URL MUST BE HTTPS OR LOOPBACK: the code and the
   * tokens travel to it, and an `http://` LAN address would send them in the
   * clear. Loopback is allowed so a dev instance can be verified without TLS —
   * the same concession the passkey setup makes for a secure context.
   */
  async availability(): Promise<{ ok: true; issuer: string } | { ok: false; reason: string }> {
    if (!(await this.auth.enabled())) {
      return { ok: false, reason: "Authentication is off; turn it on to let connectors sign in." };
    }
    const canonical = (await this.auth.settings())?.canonicalUrl;
    if (!canonical) return { ok: false, reason: "No canonical URL is configured." };
    let url: URL;
    try {
      url = new URL(canonical);
    } catch {
      return { ok: false, reason: "The canonical URL is not a valid URL." };
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
      return { ok: false, reason: "The canonical URL must be https (or loopback) for OAuth to be offered." };
    }
    return { ok: true, issuer: url.origin };
  }

  private async issuer(): Promise<string> {
    const a = await this.availability();
    if (!a.ok) throw new OAuthError(404, "not_found", a.reason);
    return a.issuer;
  }

  /* ------------------------------------------------------------ metadata */

  /** RFC 8414. */
  async metadata(): Promise<Record<string, unknown>> {
    const issuer = await this.issuer();
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/api/oauth/token`,
      registration_endpoint: `${issuer}/api/oauth/register`,
      revocation_endpoint: `${issuer}/api/oauth/revoke`,
      scopes_supported: [...OFFERABLE_INTEGRATION_SCOPES],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [...AUTH_METHODS],
      revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
      service_documentation: "https://github.com/mdennis281/dispatch/blob/main/docs/plugins.md",
    };
  }

  /**
   * RFC 9728. `suffix` is the path a connector appended to the well-known URL
   * (`/api/mcp/integration/chat`): the resource it is asking about, echoed
   * back so a client that compares them is satisfied. Without one, the answer
   * names the integration MCP mount, which is what every connector wants.
   */
  async protectedResource(suffix = ""): Promise<Record<string, unknown>> {
    const issuer = await this.issuer();
    const path = suffix.startsWith("/") ? suffix : "/api/mcp/integration";
    return {
      resource: `${issuer}${path}`,
      authorization_servers: [issuer],
      scopes_supported: [...OFFERABLE_INTEGRATION_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "Dispatch",
    };
  }

  /** The `WWW-Authenticate` an unauthenticated request on the integration surface gets, or undefined when OAuth is not offered. */
  async challenge(path: string): Promise<string | undefined> {
    const a = await this.availability();
    if (!a.ok) return undefined;
    return `Bearer realm="dispatch", resource_metadata="${a.issuer}/.well-known/oauth-protected-resource${path}"`;
  }

  /* ---------------------------------------------------------- registration */

  /**
   * RFC 7591 dynamic registration. Public clients (`token_endpoint_auth_method:
   * "none"`) are accepted — PKCE is what binds their grants — and a
   * confidential client gets a secret, shown once.
   *
   * Rate-limited per address: the endpoint is unauthenticated by design, and
   * without a cap it is a free write into the state database.
   */
  async register(body: unknown, ip: string): Promise<Record<string, unknown>> {
    await this.issuer();
    this.checkRegisterRate(ip);
    const parsed = RegistrationSchema.safeParse(body);
    if (!parsed.success) {
      throw new OAuthError(400, "invalid_client_metadata", "redirect_uris (a non-empty array) is required.");
    }
    const input = parsed.data;
    for (const uri of input.redirect_uris) {
      if (!redirectUriAllowed(uri)) {
        throw new OAuthError(400, "invalid_redirect_uri", `redirect_uri "${uri}" must be https, a loopback http URL, or a custom scheme, with no fragment.`);
      }
    }
    // The OFFERABLE list, not every valid scope: a registration that says
    // nothing used to be granted `tools:session` and friends, which the mount
    // answers 404 for, and the consent page then listed them as if they were
    // grants. See OFFERABLE_INTEGRATION_SCOPES in @dispatch/shared.
    let scopes: IntegrationScope[] = [...OFFERABLE_INTEGRATION_SCOPES];
    if (input.scope !== undefined) {
      const parsed = parseIntegrationScopes(input.scope.split(/\s+/).filter(Boolean));
      if (!parsed.ok) throw new OAuthError(400, "invalid_client_metadata", `Unknown scope(s): ${parsed.unknown.join(", ")}.`);
      if (!parsed.scopes.length) throw new OAuthError(400, "invalid_client_metadata", "scope must name at least one scope.");
      scopes = parsed.scopes;
    }
    const grantTypes = input.grant_types ?? ["authorization_code", "refresh_token"];
    for (const g of grantTypes) {
      if (g !== "authorization_code" && g !== "refresh_token") {
        throw new OAuthError(400, "invalid_client_metadata", `grant_type "${g}" is not supported.`);
      }
    }
    if (input.response_types?.some((r) => r !== "code")) {
      throw new OAuthError(400, "invalid_client_metadata", "Only the code response type is supported.");
    }
    // Default per RFC 7591 is client_secret_basic; a client that says nothing
    // gets a secret it must then present. MCP clients say "none" explicitly.
    const authMethod: AuthMethod = input.token_endpoint_auth_method ?? "client_secret_basic";
    const secret = authMethod === "none" ? undefined : randomBytes(32).toString("base64url");
    const now = this.now();
    const client: StoredClient = {
      id: randomUUID(),
      name: input.client_name ?? "Unnamed connector",
      redirectUris: [...new Set(input.redirect_uris)],
      authMethod,
      ...(secret ? { secretHash: sha256(secret) } : {}),
      scopes,
      createdAt: now,
    };
    this.store.stateDb
      .prepare("INSERT INTO oauth_client (id, created_at, body) VALUES (?, ?, ?)")
      .run(client.id, now, JSON.stringify(client));
    return {
      client_id: client.id,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(now / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: authMethod,
      grant_types: grantTypes,
      response_types: ["code"],
      scope: client.scopes.join(" "),
    };
  }

  private checkRegisterRate(ip: string): void {
    this.checkRate(this.registerHits, ip, REGISTER_PER_HOUR, HOUR_MS, "Too many registrations from this address; try again later.");
  }

  /**
   * One sliding window per address. Addresses whose hits have all aged out
   * are dropped on the way through, so a scan that touched ten thousand
   * addresses once does not keep ten thousand empty arrays forever.
   */
  private checkRate(hits: Map<string, number[]>, ip: string, max: number, windowMs: number, message: string): void {
    const now = this.now();
    for (const [addr, times] of hits) {
      if (addr !== ip && times.every((t) => t <= now - windowMs)) hits.delete(addr);
    }
    const kept = (hits.get(ip) ?? []).filter((t) => t > now - windowMs);
    if (kept.length >= max) {
      hits.set(ip, kept);
      throw new OAuthError(429, "too_many_requests", message);
    }
    kept.push(now);
    hits.set(ip, kept);
  }

  /** Keep `map` under {@link MAX_PENDING} by evicting its oldest entries (insertion order). */
  private bound<T>(map: Map<string, T>): void {
    while (map.size >= MAX_PENDING) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) return;
      map.delete(oldest);
    }
  }

  private client(id: string | undefined): StoredClient | undefined {
    if (!id) return undefined;
    const row = this.store.stateDb.prepare("SELECT body FROM oauth_client WHERE id = ?").get(id) as
      | { body: string }
      | undefined;
    if (!row) return undefined;
    const parsed = StoredClientSchema.safeParse(JSON.parse(row.body));
    return parsed.success ? parsed.data : undefined;
  }

  /* ------------------------------------------------------------ authorize */

  /**
   * `GET /oauth/authorize`. Validates the request and parks it under a
   * single-use nonce for the consent page; the caller redirects the browser
   * to the returned URL.
   *
   * Two classes of failure, as RFC 6749 §4.1.2.1 prescribes: an unknown
   * client or a redirect URI that is not registered is reported to the USER
   * (thrown, the route renders it) and never redirected — redirecting would
   * make Dispatch an open redirector. Everything else goes back to the
   * client's redirect URI as `error=…` with the state echoed.
   *
   * `resource` (RFC 8707) is accepted and recorded but not enforced as an
   * audience: the token minted is already fenced to the integration surface
   * by the auth gate, which is a stronger restriction than any audience the
   * connector could name.
   */
  async authorize(query: unknown, ip = "unknown"): Promise<{ redirectUrl: string }> {
    await this.issuer();
    this.sweep();
    this.checkRate(this.authorizeHits, ip, AUTHORIZE_PER_MINUTE, MINUTE_MS, "Too many authorization requests from this address; try again shortly.");
    const q = AuthorizeQuerySchema.parse(query ?? {});
    const client = this.client(q.client_id);
    if (!client) throw new OAuthError(400, "invalid_client", "Unknown client_id.");
    if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
      throw new OAuthError(400, "invalid_request", "redirect_uri is missing or is not one this client registered.");
    }
    const back = (code: string, description: string) => ({
      redirectUrl: withQuery(q.redirect_uri!, { error: code, error_description: description, state: q.state }),
    });
    if (q.response_type !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
    if (!q.code_challenge) return back("invalid_request", "code_challenge is required (PKCE).");
    if (q.code_challenge_method !== "S256") return back("invalid_request", "code_challenge_method must be S256.");
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) return back("invalid_request", "code_challenge is malformed.");
    const requested = q.scope ? q.scope.split(/\s+/).filter(Boolean) : client.scopes;
    const parsedScopes = parseIntegrationScopes(requested);
    if (!parsedScopes.ok) return back("invalid_scope", `Unknown scope(s): ${parsedScopes.unknown.join(", ")}.`);
    const outside = parsedScopes.scopes.filter((s) => !client.scopes.includes(s));
    if (outside.length) return back("invalid_scope", `This client did not register for: ${outside.join(", ")}.`);
    if (!parsedScopes.scopes.length) return back("invalid_scope", "At least one scope is required.");
    // Narrow to what grants something (RFC 6749 §3.3 lets the server issue
    // less than was asked; the token response reports what it issued). A
    // `tools:*` over a category with no external tool is valid to parse but
    // unlocks nothing — listing it on the consent page would ask the owner to
    // approve a grant that does not exist, and storing it would show a dead
    // chip on the grant forever.
    const scopes = parsedScopes.scopes.filter(isOfferableIntegrationScope);
    if (!scopes.length) return back("invalid_scope", "None of the requested scopes grant anything on this host.");

    const nonce = randomBytes(32).toString("base64url");
    this.bound(this.pending);
    this.pending.set(nonce, {
      nonce,
      client,
      redirectUri: q.redirect_uri,
      scopes,
      ...(q.state !== undefined ? { state: q.state } : {}),
      codeChallenge: q.code_challenge,
      ...(q.resource ? { resource: q.resource } : {}),
      expiresAt: this.now() + OAUTH_AUTHORIZE_NONCE_MS,
    });
    // Relative, not the issuer: the SPA is wherever this request arrived, and
    // the consent page needs the same origin's session cookie to work.
    return { redirectUrl: `/#oauth=${encodeURIComponent(nonce)}` };
  }

  /** What the consent page renders. Does NOT consume the nonce — a reload must still show the page. */
  requestView(nonce: string): OAuthRequestView {
    const p = this.pendingOf(nonce);
    return {
      nonce,
      client: { id: p.client.id, name: p.client.name, redirectHost: new URL(p.redirectUri).host },
      scopes: p.scopes,
      expiresAt: p.expiresAt,
    };
  }

  private pendingOf(nonce: string): PendingAuthorization {
    const p = this.pending.get(nonce);
    if (!p || p.expiresAt <= this.now()) {
      this.pending.delete(nonce);
      throw new OAuthError(404, "invalid_request", "This authorization request has expired. Start again from the application.");
    }
    return p;
  }

  /**
   * The owner's decision. Consumes the nonce either way. Approval mints the
   * code (single-use, {@link OAUTH_CODE_MS}); denial sends `access_denied`.
   * The grant itself is created at the TOKEN exchange, so a code that is
   * never redeemed leaves nothing behind to revoke.
   */
  decide(nonce: string, approve: boolean): OAuthDecisionResult {
    const p = this.pendingOf(nonce);
    this.pending.delete(nonce);
    if (!approve) {
      return { redirectUrl: withQuery(p.redirectUri, { error: "access_denied", error_description: "The owner declined.", state: p.state }) };
    }
    const code = randomBytes(32).toString("base64url");
    this.bound(this.codes);
    this.codes.set(code, {
      clientId: p.client.id,
      redirectUri: p.redirectUri,
      scopes: p.scopes,
      codeChallenge: p.codeChallenge,
      expiresAt: this.now() + OAUTH_CODE_MS,
    });
    return { redirectUrl: withQuery(p.redirectUri, { code, state: p.state }) };
  }

  /** Drop expired nonces and codes. Called on the way into the endpoints that add to either map. */
  private sweep(): void {
    const now = this.now();
    for (const [k, v] of this.pending) if (v.expiresAt <= now) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt <= now) this.codes.delete(k);
  }

  /* ----------------------------------------------------------------- token */

  /**
   * Resolve and authenticate the client behind a token/revoke request.
   * Confidential clients must present their secret; public ones must not be
   * asked for one. A client that registered with a secret and then calls
   * without it is `invalid_client`, 401 — with a Basic challenge when that is
   * how it tried, as RFC 6749 §5.2 requires.
   */
  private authenticateClient(creds: ClientCredentials): StoredClient {
    const fail = () => new OAuthError(401, "invalid_client", "Client authentication failed.");
    const client = this.client(creds.clientId);
    if (!client) throw fail();
    if (client.authMethod === "none") return client;
    if (!creds.clientSecret || !client.secretHash) throw fail();
    if (!safeEqual(sha256(creds.clientSecret), client.secretHash)) throw fail();
    return client;
  }

  /** `POST /api/oauth/token`. */
  async token(params: Record<string, unknown>, creds: ClientCredentials): Promise<Record<string, unknown>> {
    await this.issuer();
    this.sweep();
    const str = (k: string) => (typeof params[k] === "string" ? (params[k] as string) : undefined);
    const grantType = str("grant_type");
    if (grantType === "authorization_code") return this.exchangeCode(str, creds);
    if (grantType === "refresh_token") return this.refresh(str, creds);
    throw new OAuthError(400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
  }

  private async exchangeCode(str: (k: string) => string | undefined, creds: ClientCredentials): Promise<Record<string, unknown>> {
    const client = this.authenticateClient(creds);
    const code = str("code");
    const verifier = str("code_verifier");
    const redirectUri = str("redirect_uri");
    if (!code || !verifier) throw new OAuthError(400, "invalid_request", "code and code_verifier are required.");
    const issued = this.codes.get(code);
    if (!issued || issued.expiresAt <= this.now()) {
      this.codes.delete(code);
      throw new OAuthError(400, "invalid_grant", "The authorization code is invalid or has expired.");
    }
    if (issued.usedForGrant) {
      // RFC 6749 §4.1.2: a code presented twice is a code that leaked. The
      // grant the first use produced is revoked along with refusing this one.
      this.codes.delete(code);
      await this.revokeGrant(issued.usedForGrant);
      throw new OAuthError(400, "invalid_grant", "The authorization code was already used; its grant has been revoked.");
    }
    if (issued.clientId !== client.id) throw new OAuthError(400, "invalid_grant", "This code was issued to a different client.");
    if (redirectUri !== undefined && redirectUri !== issued.redirectUri) {
      throw new OAuthError(400, "invalid_grant", "redirect_uri does not match the authorization request.");
    }
    if (!safeEqual(sha256(verifier), issued.codeChallenge)) {
      throw new OAuthError(400, "invalid_grant", "code_verifier does not match the code_challenge.");
    }

    // The epoch is awaited BEFORE the claim so that the claim and the grant
    // row land in the same synchronous stretch: a replay of this code that
    // arrives while `mintAccess` is in flight must find a grant to revoke, or
    // "reuse revokes the grant" would be true only on paper.
    const epoch = await this.auth.currentAuthEpoch();
    const now = this.now();
    const grantId = randomUUID();
    issued.usedForGrant = grantId;
    this.store.stateDb
      .prepare("INSERT INTO oauth_grant (id, client_id, scopes, auth_epoch, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(grantId, client.id, JSON.stringify(issued.scopes), epoch, now);
    const access = await this.mintAccess(client, issued.scopes);
    this.store.stateDb.prepare("UPDATE oauth_grant SET access_token_id = ? WHERE id = ?").run(access.id, grantId);
    const landed = this.grant(grantId);
    if (!landed || landed.revoked_at !== null) {
      // Revoked while the mint was in flight (that replay). The token just
      // minted belongs to nobody now.
      await this.auth.tokens.remove(access.id).catch(() => false);
      throw new OAuthError(400, "invalid_grant", "The authorization code was already used; its grant has been revoked.");
    }
    const refreshToken = this.issueRefresh(grantId);
    return this.tokenResponse(access.token, refreshToken, issued.scopes);
  }

  private async refresh(str: (k: string) => string | undefined, creds: ClientCredentials): Promise<Record<string, unknown>> {
    const client = this.authenticateClient(creds);
    const presented = str("refresh_token");
    if (!presented) throw new OAuthError(400, "invalid_request", "refresh_token is required.");
    const invalid = () => new OAuthError(400, "invalid_grant", "The refresh token is invalid, expired or revoked.");
    const row = this.store.stateDb
      .prepare("SELECT * FROM oauth_refresh_token WHERE hash = ?")
      .get(sha256(presented)) as RefreshRow | undefined;
    if (!row) throw invalid();
    const grant = this.grant(row.grant_id);
    if (!grant || grant.revoked_at !== null) throw invalid();
    if (row.used_at !== null) await this.refuseReuse(grant.id, row.used_at);
    if (row.expires_at <= this.now()) throw invalid();
    if (grant.client_id !== client.id) throw invalid();
    const grantScopes = JSON.parse(grant.scopes) as IntegrationScope[];
    let scopes = grantScopes;
    const narrowed = str("scope");
    if (narrowed) {
      const parsed = parseIntegrationScopes(narrowed.split(/\s+/).filter(Boolean));
      if (!parsed.ok || parsed.scopes.some((s) => !grantScopes.includes(s))) {
        throw new OAuthError(400, "invalid_scope", "A refresh may only narrow the scopes the grant holds.");
      }
      scopes = parsed.scopes;
    }
    // EVERY await happens above this line. The two checks below are the only
    // ones that leave the process, and they must not sit between the read of
    // `used_at` and the claim: two refreshes carrying the same token would
    // both pass, both rotate, and the grant would end up with two live
    // refresh chains and an access token no revocation could reach.
    const epoch = await this.auth.currentAuthEpoch();
    const revokedByOwner = !!grant.access_token_id && (await this.accessTokenRevoked(grant.access_token_id));
    if (grant.auth_epoch !== epoch) {
      // Authentication was turned off (and maybe back on) since the consent.
      // The access tokens already died with the epoch; the grant follows.
      await this.revokeGrant(grant.id);
      throw invalid();
    }
    if (revokedByOwner) {
      // The owner hit Revoke on the `oauth` token in the Tokens list. That is a
      // decision about the connector, not about one hour of its access.
      await this.revokeGrant(grant.id);
      throw invalid();
    }

    // THE CLAIM. Synchronous and conditional: SQLite answers how many rows the
    // UPDATE touched, and zero means another request claimed this token since
    // the read above. That request is the one that rotates; this one is the
    // reuse case, judged by the same grace rule as a stale read.
    const now = this.now();
    const claimed = this.store.stateDb
      .prepare("UPDATE oauth_refresh_token SET used_at = ? WHERE hash = ? AND used_at IS NULL")
      .run(now, row.hash);
    if (Number(claimed.changes) !== 1) {
      const fresh = this.store.stateDb.prepare("SELECT used_at FROM oauth_refresh_token WHERE hash = ?").get(row.hash) as
        | { used_at: number | null }
        | undefined;
      await this.refuseReuse(grant.id, fresh?.used_at ?? now);
    }
    const previous = grant.access_token_id;
    const access = await this.mintAccess(client, scopes);
    this.store.stateDb
      .prepare("UPDATE oauth_grant SET access_token_id = ?, last_refreshed_at = ? WHERE id = ?")
      .run(access.id, now, grant.id);
    const refreshToken = this.issueRefresh(grant.id);
    // REMOVED, not revoked. A revoked row stays in the token file forever by
    // design (the Settings list says "revoked" instead of a token vanishing
    // under a bot); here the grant row is the audit record, the superseded
    // token was never shown to anyone, and one connector rotating hourly
    // would otherwise add ~24 dead rows a day to a whole-file JSON that is
    // rewritten under a lock on every mint.
    if (previous) await this.auth.tokens.remove(previous).catch(() => false);
    return this.tokenResponse(access.token, refreshToken, scopes);
  }

  /**
   * A refresh token presented after it was already rotated. Within the grace
   * window it is almost certainly the same client retrying a request whose
   * response it lost (or two parallel tool calls that both hit the hour), so
   * it is refused and nothing else happens — the rotation that won still
   * stands. Past the window there is no benign reading: whoever holds it
   * replayed something stolen, and the family dies. Never returns.
   */
  private async refuseReuse(grantId: string, usedAt: number): Promise<never> {
    if (this.now() - usedAt <= OAUTH_REFRESH_REUSE_GRACE_MS) {
      throw new OAuthError(400, "invalid_grant", "This refresh token was already used.");
    }
    await this.revokeGrant(grantId);
    throw new OAuthError(400, "invalid_grant", "This refresh token was already used; the grant has been revoked.");
  }

  private async mintAccess(client: StoredClient, scopes: IntegrationScope[]): Promise<{ token: string; id: string }> {
    const created = await this.auth.mintIntegrationToken(
      { kind: "oauth", clientId: client.id },
      {
        name: client.name.slice(0, INTEGRATION_TOKEN_NAME_MAX),
        scopes,
        expiresAt: this.now() + OAUTH_ACCESS_TOKEN_SECONDS * 1000,
      },
    );
    return { token: created.token, id: created.summary.id };
  }

  private issueRefresh(grantId: string): string {
    const raw = `${OAUTH_REFRESH_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const now = this.now();
    this.store.stateDb
      .prepare("INSERT INTO oauth_refresh_token (hash, grant_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(sha256(raw), grantId, now, now + OAUTH_REFRESH_TOKEN_DAYS * DAY_MS);
    return raw;
  }

  private tokenResponse(accessToken: string, refreshToken: string, scopes: IntegrationScope[]): Record<string, unknown> {
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: OAUTH_ACCESS_TOKEN_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  private async accessTokenRevoked(id: string): Promise<boolean> {
    const row = (await this.auth.tokens.list()).find((t) => t.id === id);
    return !!row && row.revokedAt !== undefined;
  }

  /* ---------------------------------------------------------------- revoke */

  /**
   * RFC 7009. Always 200 for a well-formed request from an authenticated
   * client, whether or not the token was found — the standard says so, and
   * answering differently would let a caller probe which tokens exist. A
   * refresh token revokes its whole grant; an access token does too, since
   * one is the other's current face.
   */
  async revoke(params: Record<string, unknown>, creds: ClientCredentials): Promise<void> {
    await this.issuer();
    const client = this.authenticateClient(creds);
    const token = typeof params.token === "string" ? params.token : undefined;
    if (!token) throw new OAuthError(400, "invalid_request", "token is required.");
    const refreshRow = this.store.stateDb
      .prepare("SELECT grant_id FROM oauth_refresh_token WHERE hash = ?")
      .get(sha256(token)) as { grant_id: string } | undefined;
    if (refreshRow) {
      const grant = this.grant(refreshRow.grant_id);
      if (grant && grant.client_id === client.id) await this.revokeGrant(grant.id);
      return;
    }
    const identity = await this.auth.authenticateIntegration(token);
    if (!identity) return;
    const grant = this.store.stateDb
      .prepare("SELECT * FROM oauth_grant WHERE access_token_id = ? AND client_id = ?")
      .get(identity.tokenId, client.id) as GrantRow | undefined;
    if (grant) await this.revokeGrant(grant.id);
  }

  /* ---------------------------------------------------------------- grants */

  private grant(id: string): GrantRow | undefined {
    return this.store.stateDb.prepare("SELECT * FROM oauth_grant WHERE id = ?").get(id) as GrantRow | undefined;
  }

  /** Revoke a grant family: the grant, its refresh tokens, and the access token it backs. Idempotent. */
  async revokeGrant(id: string): Promise<boolean> {
    const grant = this.grant(id);
    if (!grant) return false;
    if (grant.revoked_at === null) {
      this.store.stateDb.prepare("UPDATE oauth_grant SET revoked_at = ? WHERE id = ?").run(this.now(), id);
    }
    this.store.stateDb.prepare("DELETE FROM oauth_refresh_token WHERE grant_id = ?").run(id);
    if (grant.access_token_id) await this.auth.tokens.revoke(grant.access_token_id).catch(() => false);
    return true;
  }

  /** Every grant, newest first, for Settings → Integrations. */
  listGrants(): OAuthGrantSummary[] {
    const rows = this.store.stateDb.prepare("SELECT * FROM oauth_grant ORDER BY created_at DESC").all() as unknown as GrantRow[];
    const live = this.store.stateDb
      .prepare("SELECT grant_id, MAX(expires_at) AS expires_at FROM oauth_refresh_token WHERE used_at IS NULL GROUP BY grant_id")
      .all() as Array<{ grant_id: string; expires_at: number }>;
    const refreshExpiry = new Map(live.map((r) => [r.grant_id, r.expires_at]));
    const names = new Map<string, string>();
    return rows.map((g) => {
      if (!names.has(g.client_id)) names.set(g.client_id, this.client(g.client_id)?.name ?? "Unknown connector");
      const exp = refreshExpiry.get(g.id);
      return {
        id: g.id,
        clientId: g.client_id,
        clientName: names.get(g.client_id)!,
        scopes: JSON.parse(g.scopes) as IntegrationScope[],
        createdAt: g.created_at,
        ...(g.last_refreshed_at !== null ? { lastRefreshedAt: g.last_refreshed_at } : {}),
        ...(exp !== undefined ? { refreshExpiresAt: exp } : {}),
        ...(g.revoked_at !== null ? { revokedAt: g.revoked_at } : {}),
      };
    });
  }
}
