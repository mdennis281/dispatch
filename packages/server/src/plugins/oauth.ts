/**
 * THE HOST-RUN OAUTH CLIENT FLOW FOR PLUGINS — `ctx.oauth`, the Connect button,
 * and the callback. See docs/plugins.md → "OAuth" → "Client flow for plugins".
 *
 * A plugin declares `oauth.clients.<name>` in its manifest and never touches a
 * token endpoint itself: the host mints the `state`, builds the authorization
 * URL (PKCE included — a provider that ignores the challenge is unharmed by
 * it), exchanges the code at the callback, stores the result in this
 * instance's `plugin_oauth_token` table, and hands the plugin a live access
 * token on request, refreshing it first when it is within a minute of expiry.
 *
 * `clientId` / `clientSecret` may be `${secret:NAME}` references. They resolve
 * ONLY for names the manifest lists under `secrets:` — the same rule as
 * `ctx.secrets.get` — and resolve SERVER-SIDE ONLY: the SPA sees a Connect
 * button and a status, never a credential.
 *
 * The callback authenticates by `state` alone. It is a top-level navigation
 * from the provider, so it carries no bearer; the state is 32 random bytes,
 * single-use, and ten minutes old at most, which is the same posture every
 * OAuth client takes at its redirect URI.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  OAUTH_PLUGIN_STATE_MS,
  PLUGIN_OAUTH_CLIENT_NAME_PATTERN,
  type PluginManifest,
  type PluginOAuthClient,
  type PluginOAuthStatus,
} from "@dispatch/shared";
import type { Store } from "../store/index.js";

/** The secrets-service slice this needs — narrow so tests can fake it. */
export interface PluginOAuthSecrets {
  /** Refreshes the cache from disk; the resolver reads only the cache. */
  list(): Promise<unknown>;
  resolve(projectId: string | undefined, name: string): string | undefined;
}

/** What the host knows about one plugin's declared clients. */
export interface PluginOAuthManifestView {
  clients: Record<string, PluginOAuthClient>;
  /** The manifest's `secrets:` list — the only names a `${secret:…}` may name. */
  secretNames: string[];
}

export interface PluginOAuthDeps {
  store: Store;
  secrets: PluginOAuthSecrets;
  /**
   * The manifest view for an ENABLED, VALID plugin, or undefined. Supplied by
   * the plugin service after construction (the two reference each other).
   */
  resolve: (pluginId: string) => PluginOAuthManifestView | undefined;
  /** The origin the callback is built on: the canonical URL when set. */
  canonicalUrl: () => Promise<string | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
}

interface PendingState {
  pluginId: string;
  name: string;
  redirectUri: string;
  codeVerifier: string;
  /** The session that clicked Connect, when one did (informational; see file header). */
  sessionId?: string;
  expiresAt: number;
}

interface TokenRow {
  plugin: string;
  name: string;
  access_token: string;
  refresh_token: string | null;
  token_type: string | null;
  expires_at: number | null;
  scopes: string;
  updated_at: number;
}

/** Refresh when the token has less than this long to live. */
const REFRESH_AHEAD_MS = 60_000;

/** A provider that answers in more than this is not going to answer. */
const PROVIDER_TIMEOUT_MS = 20_000;

const SECRET_REF = /^\$\{secret:([A-Za-z_][A-Za-z0-9_]{0,63})\}$/;

export class PluginOAuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "PluginOAuthError";
  }
}

function pluginManifestView(manifest: PluginManifest): PluginOAuthManifestView | undefined {
  if (!manifest.capabilities?.includes("oauth")) return undefined;
  const clients = manifest.oauth?.clients;
  if (!clients || !Object.keys(clients).length) return undefined;
  return { clients, secretNames: manifest.secrets ?? [] };
}

export { pluginManifestView as pluginOAuthManifestView };

export class PluginOAuthService {
  private readonly store: Store;
  private readonly secrets: PluginOAuthSecrets;
  private readonly resolve: PluginOAuthDeps["resolve"];
  private readonly canonicalUrl: PluginOAuthDeps["canonicalUrl"];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly states = new Map<string, PendingState>();
  /** One refresh in flight per (plugin, name): two `token()` calls racing would rotate the refresh token twice. */
  private readonly refreshing = new Map<string, Promise<string | undefined>>();

  constructor(deps: PluginOAuthDeps) {
    this.store = deps.store;
    this.secrets = deps.secrets;
    this.resolve = deps.resolve;
    this.canonicalUrl = deps.canonicalUrl;
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? (() => Date.now());
  }

  /* ------------------------------------------------------------- lookups */

  private clientOf(pluginId: string, name: string): { client: PluginOAuthClient; secretNames: string[] } {
    if (!PLUGIN_OAUTH_CLIENT_NAME_PATTERN.test(name)) throw new PluginOAuthError(404, `no OAuth client "${name}"`);
    const view = this.resolve(pluginId);
    const client = view?.clients[name];
    if (!view || !client) throw new PluginOAuthError(404, `plugin "${pluginId}" declares no OAuth client "${name}"`);
    return { client, secretNames: view.secretNames };
  }

  /**
   * A literal, or a `${secret:NAME}` the manifest is allowed to read. A
   * reference to an unlisted or unset secret is an error here rather than an
   * empty string sent to the provider — the provider's "invalid_client" would
   * say nothing about which of the two it was.
   */
  private async credential(value: string | undefined, secretNames: string[], what: string): Promise<string | undefined> {
    if (value === undefined) return undefined;
    const ref = SECRET_REF.exec(value);
    if (!ref) return value;
    const secretName = ref[1]!;
    if (!secretNames.includes(secretName)) {
      throw new PluginOAuthError(400, `${what} refers to secret "${secretName}", which plugin.yaml does not list under secrets:`);
    }
    await this.secrets.list();
    const resolved = this.secrets.resolve(undefined, secretName);
    if (resolved === undefined || resolved === "") {
      throw new PluginOAuthError(409, `${what} refers to secret "${secretName}", which is not set. Add it under Settings → Secrets.`);
    }
    return resolved;
  }

  private async redirectUri(pluginId: string, name: string, fallbackOrigin?: string): Promise<string> {
    const canonical = await this.canonicalUrl();
    let origin: string | undefined;
    if (canonical) {
      try {
        origin = new URL(canonical).origin;
      } catch {
        origin = undefined;
      }
    }
    origin ??= fallbackOrigin;
    if (!origin) {
      throw new PluginOAuthError(409, "Configure a canonical URL (Settings → Authentication) before connecting; the provider needs a redirect URL.");
    }
    return `${origin}/oauth/callback/${encodeURIComponent(pluginId)}/${encodeURIComponent(name)}`;
  }

  /* ------------------------------------------------------------- connect */

  /**
   * Build the provider URL and park the state. `fallbackOrigin` is the origin
   * the Connect click arrived on, used only when no canonical URL is set so
   * an auth-off dev instance can still complete a round trip; `ctx.oauth.
   * connectUrl` has no request to fall back on and needs the canonical URL.
   */
  async connectUrl(
    pluginId: string,
    name: string,
    opts: { sessionId?: string; fallbackOrigin?: string } = {},
  ): Promise<string> {
    const { client, secretNames } = this.clientOf(pluginId, name);
    const clientId = await this.credential(client.clientId, secretNames, "clientId");
    // The secret is not needed until the callback, but resolving it NOW is
    // what turns "the provider said invalid_client after the owner signed in"
    // into "set the secret first" before anyone leaves the page.
    await this.credential(client.clientSecret, secretNames, "clientSecret");
    const redirectUri = await this.redirectUri(pluginId, name, opts.fallbackOrigin);
    this.sweep();
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(48).toString("base64url");
    this.states.set(state, {
      pluginId,
      name,
      redirectUri,
      codeVerifier,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      expiresAt: this.now() + OAUTH_PLUGIN_STATE_MS,
    });
    const url = new URL(client.authorizationUrl);
    // Extras first so a manifest cannot override the parameters the host owns.
    for (const [k, v] of Object.entries(client.extraParams ?? {})) url.searchParams.set(k, v);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId!);
    url.searchParams.set("redirect_uri", redirectUri);
    if (client.scopes?.length) url.searchParams.set("scope", client.scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", createHash("sha256").update(codeVerifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, v] of this.states) if (v.expiresAt <= now) this.states.delete(k);
  }

  /* ------------------------------------------------------------ callback */

  /**
   * `GET /oauth/callback/:plugin/:name`. Consumes the state, exchanges the
   * code, stores the tokens. Returns a message for the pane rather than
   * throwing: the browser is mid-navigation and lands on Settings → Plugins
   * either way, with this as the toast.
   */
  async handleCallback(
    pluginId: string,
    name: string,
    query: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const str = (k: string) => (typeof query[k] === "string" ? (query[k] as string) : undefined);
    const state = str("state");
    const pending = state ? this.states.get(state) : undefined;
    if (state) this.states.delete(state);
    if (!pending || pending.expiresAt <= this.now()) {
      return { ok: false, error: "This sign-in attempt has expired or was already completed. Click Connect again." };
    }
    if (pending.pluginId !== pluginId || pending.name !== name) {
      return { ok: false, error: "The sign-in state does not belong to this plugin." };
    }
    const providerError = str("error");
    if (providerError) {
      return { ok: false, error: `The provider refused: ${str("error_description") ?? providerError}` };
    }
    const code = str("code");
    if (!code) return { ok: false, error: "The provider sent no authorization code." };
    let client: PluginOAuthClient;
    let secretNames: string[];
    try {
      ({ client, secretNames } = this.clientOf(pluginId, name));
      const form: Record<string, string> = {
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.codeVerifier,
      };
      const response = await this.tokenRequest(client, secretNames, form);
      this.storeTokens(pluginId, name, response, undefined);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * One POST to the provider's token endpoint, form-encoded, credentials in
   * the body (`client_secret_post`): the method every major provider accepts,
   * and the one that needs no second round trip when a provider rejects
   * Basic. Expects an RFC 6749 §5.1 JSON response.
   */
  private async tokenRequest(
    client: PluginOAuthClient,
    secretNames: string[],
    form: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const clientId = await this.credential(client.clientId, secretNames, "clientId");
    const clientSecret = await this.credential(client.clientSecret, secretNames, "clientSecret");
    const body = new URLSearchParams({ ...form, client_id: clientId! });
    if (clientSecret) body.set("client_secret", clientSecret);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(client.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: body.toString(),
        signal: controller.signal,
      });
    } catch (err) {
      throw new PluginOAuthError(502, `The provider's token endpoint could not be reached: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new PluginOAuthError(502, `The provider's token endpoint answered ${response.status} with a non-JSON body.`);
    }
    if (!response.ok || typeof json.access_token !== "string") {
      const desc = typeof json.error_description === "string" ? json.error_description : typeof json.error === "string" ? json.error : `HTTP ${response.status}`;
      throw new PluginOAuthError(502, `The provider refused the token request: ${desc}`);
    }
    return json;
  }

  private storeTokens(pluginId: string, name: string, response: Record<string, unknown>, previous: TokenRow | undefined): void {
    const now = this.now();
    const expiresIn = typeof response.expires_in === "number" ? response.expires_in : Number(response.expires_in);
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null;
    // A provider that rotates refresh tokens sends a new one; one that does
    // not (GitHub, for one) sends nothing and the old one stays good.
    const refresh = typeof response.refresh_token === "string" ? response.refresh_token : (previous?.refresh_token ?? null);
    const scopes = typeof response.scope === "string" ? response.scope.split(/[\s,]+/).filter(Boolean) : previous ? (JSON.parse(previous.scopes) as string[]) : [];
    this.store.stateDb
      .prepare(
        "INSERT INTO plugin_oauth_token (plugin, name, access_token, refresh_token, token_type, expires_at, scopes, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(plugin, name) DO UPDATE SET " +
          "access_token = excluded.access_token, refresh_token = excluded.refresh_token, token_type = excluded.token_type, " +
          "expires_at = excluded.expires_at, scopes = excluded.scopes, updated_at = excluded.updated_at",
      )
      .run(
        pluginId,
        name,
        response.access_token as string,
        refresh,
        typeof response.token_type === "string" ? response.token_type : null,
        expiresAt,
        JSON.stringify(scopes),
        now,
      );
  }

  /* --------------------------------------------------------------- token */

  private row(pluginId: string, name: string): TokenRow | undefined {
    return this.store.stateDb
      .prepare("SELECT * FROM plugin_oauth_token WHERE plugin = ? AND name = ?")
      .get(pluginId, name) as TokenRow | undefined;
  }

  /** A live access token, refreshed first if it is about to expire; undefined when not connected. */
  async token(pluginId: string, name: string): Promise<string | undefined> {
    const { client, secretNames } = this.clientOf(pluginId, name);
    const row = this.row(pluginId, name);
    if (!row) return undefined;
    const now = this.now();
    if (row.expires_at === null || row.expires_at - now > REFRESH_AHEAD_MS) return row.access_token;
    if (!row.refresh_token) {
      // Expired with nothing to refresh it: the owner must connect again. An
      // expired token handed out "because it is all we have" would fail at the
      // provider with a message that says nothing about why.
      return row.expires_at > now ? row.access_token : undefined;
    }
    const key = `${pluginId}/${name}`;
    let inflight = this.refreshing.get(key);
    if (!inflight) {
      inflight = (async () => {
        try {
          const response = await this.tokenRequest(client, secretNames, {
            grant_type: "refresh_token",
            refresh_token: row.refresh_token!,
          });
          this.storeTokens(pluginId, name, response, row);
          return response.access_token as string;
        } catch (err) {
          // Still within its lifetime: hand it out and let the next call retry.
          // Past it: the connection is dead and `undefined` says so.
          if (row.expires_at! > this.now()) return row.access_token;
          throw err;
        }
      })().finally(() => this.refreshing.delete(key));
      this.refreshing.set(key, inflight);
    }
    return inflight;
  }

  async disconnect(pluginId: string, name: string): Promise<void> {
    this.clientOf(pluginId, name);
    this.store.stateDb.prepare("DELETE FROM plugin_oauth_token WHERE plugin = ? AND name = ?").run(pluginId, name);
  }

  /* -------------------------------------------------------------- status */

  /**
   * Connect / Connected-until per declared client, for `GET /api/plugins`.
   * Synchronous (it is called from `PluginService.info`), so the secret check
   * reads the cache the secrets service maintains rather than refreshing it.
   */
  status(pluginId: string, view: PluginOAuthManifestView): PluginOAuthStatus[] {
    const out: PluginOAuthStatus[] = [];
    for (const [name, client] of Object.entries(view.clients)) {
      const row = this.row(pluginId, name);
      const configError = this.configErrorSync(client, view.secretNames);
      out.push({
        name,
        connected: !!row,
        ...(row?.expires_at !== null && row?.expires_at !== undefined ? { expiresAt: row.expires_at } : {}),
        ...(row ? { scopes: JSON.parse(row.scopes) as string[] } : {}),
        ...(configError ? { configError } : {}),
      });
    }
    return out;
  }

  private configErrorSync(client: PluginOAuthClient, secretNames: string[]): string | undefined {
    for (const [what, value] of [
      ["clientId", client.clientId],
      ["clientSecret", client.clientSecret],
    ] as const) {
      if (value === undefined) continue;
      const ref = SECRET_REF.exec(value);
      if (!ref) continue;
      const secretName = ref[1]!;
      if (!secretNames.includes(secretName)) return `${what} refers to secret "${secretName}", which plugin.yaml does not list under secrets:`;
      const resolved = this.secrets.resolve(undefined, secretName);
      if (resolved === undefined || resolved === "") return `Secret "${secretName}" is not set (Settings → Secrets).`;
    }
    return undefined;
  }
}
