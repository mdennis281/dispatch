/**
 * OAUTH, BOTH ROLES — the wire shapes the server and the SPA share.
 *
 *   1. Dispatch as an OAuth 2.1 AUTHORIZATION SERVER for remote-MCP connectors
 *      (Claude.ai, ChatGPT, Grok, the MCP Inspector…). A connector discovers
 *      `/.well-known/oauth-authorization-server`, registers itself, sends the
 *      owner through the consent page, and ends up holding an ordinary
 *      integration token (`dsp_…`, see integration.ts) with `clientId` set.
 *   2. Dispatch as an OAuth CLIENT on a plugin's behalf: a manifest declares
 *      `oauth.clients.<name>` and the host runs the round trip, stores the
 *      tokens per instance, and refreshes them before they expire.
 *
 * The protocol documents themselves (RFC 8414 metadata, RFC 7591 registration,
 * RFC 6749 token responses) are plain JSON the server builds on the fly and
 * are not typed here — their field names are the standard's, not ours.
 *
 * See docs/plugins.md → "OAuth".
 */
import type { IntegrationScope } from "./integration.js";

/** An access token minted by a grant lives this long; the connector refreshes after. */
export const OAUTH_ACCESS_TOKEN_SECONDS = 60 * 60;

/** A refresh token lives this long from the moment it is issued; rotation issues a fresh one. */
export const OAUTH_REFRESH_TOKEN_DAYS = 30;

/** A parked authorization request (the consent page's nonce) is good for this long. */
export const OAUTH_AUTHORIZE_NONCE_MS = 10 * 60_000;

/** An authorization code is good for this long, once. RFC 6749 recommends ≤ 10 min; one is plenty on a loopback round trip. */
export const OAUTH_CODE_MS = 60_000;

/** The plugin client flow's `state` is good for this long. */
export const OAUTH_PLUGIN_STATE_MS = 10 * 60_000;

/** Every refresh token Dispatch issues starts with this; the value is hashed at rest like `dsp_` tokens. */
export const OAUTH_REFRESH_TOKEN_PREFIX = "dsr_";

/**
 * What the consent page shows. Fetched with the session bearer from
 * `GET /api/oauth/requests/:nonce`; nothing here is secret, but the nonce is
 * single-use and the page is the only thing that ever sees it.
 */
export interface OAuthRequestView {
  nonce: string;
  client: {
    id: string;
    name: string;
    /** Host of the redirect URI, so the page can say where the code goes. */
    redirectHost: string;
  };
  scopes: IntegrationScope[];
  expiresAt: number;
}

/** `POST /api/oauth/requests/:nonce/decision` → where the SPA navigates next. */
export interface OAuthDecisionResult {
  redirectUrl: string;
}

/**
 * One grant as Settings → Integrations lists it: a connector the owner
 * approved, holding a rotating refresh token. The access token it currently
 * holds is an ordinary integration token in the Tokens list with the `oauth`
 * chip; revoking the GRANT revokes that token and every refresh token with it.
 */
export interface OAuthGrantSummary {
  id: string;
  clientId: string;
  clientName: string;
  scopes: IntegrationScope[];
  createdAt: number;
  lastRefreshedAt?: number;
  /** When the live refresh token expires — after this the connector must re-consent. */
  refreshExpiresAt?: number;
  revokedAt?: number;
}

/**
 * One declared `oauth.clients.<name>` of a plugin, as `GET /api/plugins`
 * reports it. The token value never rides along: the pane only needs to know
 * whether to show Connect or Disconnect, and until when.
 */
export interface PluginOAuthStatus {
  name: string;
  connected: boolean;
  /** When the stored access token expires (the host refreshes before it). Absent = provider gave no expiry. */
  expiresAt?: number;
  /** The scopes the provider actually granted, when it said. */
  scopes?: string[];
  /** Why Connect cannot work yet — an unset `${secret:…}` or a missing canonical URL. */
  configError?: string;
}

/** `POST /api/plugins/:id/oauth/:name/connect` → the provider URL to navigate to. */
export interface PluginOAuthConnectResult {
  url: string;
}
