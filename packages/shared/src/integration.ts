/**
 * INTEGRATION TOKENS AND SCOPES — the contract between a non-browser caller
 * (a bot, a script, a remote-MCP connector) and Dispatch's `/api/integration/`
 * surface and external MCP mount.
 *
 * Shared because three things must agree on it and drift between any two is
 * a token that mints fine and then 403s everywhere: the server's gate, the
 * Settings pane that offers the scope checkboxes, and the CLI that mints
 * offline. One list, one prefix, one validator.
 */
import { MANAGER_CATEGORIES, type ManagerCategory } from "./manager-tools.js";

/**
 * Every integration token starts with this. The auth gate branches on it
 * BEFORE the JWT path, so a bearer that carries it is never handed to
 * `verifyJwt` — which would reject it and 401 the caller with a message about
 * sessions, for a credential that was never a session.
 */
export const INTEGRATION_TOKEN_PREFIX = "dsp_";

/** The fixed scopes — what a token may do on the REST surface. */
export const INTEGRATION_FIXED_SCOPES = [
  "chats:read",
  "chats:write",
  "attention:read",
  "attention:answer",
  "memory:read",
  "memory:write",
  "projects:read",
  "webhooks:manage",
] as const;

export type IntegrationFixedScope = (typeof INTEGRATION_FIXED_SCOPES)[number];

/** The scope that unlocks one manager category on the external MCP mount. */
export type IntegrationToolScope = `tools:${ManagerCategory}`;

export type IntegrationScope = IntegrationFixedScope | IntegrationToolScope;

/** The scope name for a category: `"github"` → `"tools:github"`. */
export function toolScope(category: ManagerCategory): IntegrationToolScope {
  return `tools:${category}`;
}

/**
 * Every scope a token can hold, in the order the Settings pane lists them.
 * Derived from the category list so a new manager category is offered the day
 * it exists rather than when someone remembers this file.
 */
export const INTEGRATION_SCOPES: readonly IntegrationScope[] = [
  ...INTEGRATION_FIXED_SCOPES,
  ...MANAGER_CATEGORIES.map(toolScope),
];

const SCOPE_SET: ReadonlySet<string> = new Set(INTEGRATION_SCOPES);

export function isIntegrationScope(value: string): value is IntegrationScope {
  return SCOPE_SET.has(value);
}

/**
 * Validate a scope list the way every minting path must: unknown names are an
 * error, not a silent drop. A token minted with a typo'd scope that was
 * quietly ignored would look complete in the list and fail on first use.
 * Returns the deduplicated list in canonical order.
 */
export function parseIntegrationScopes(
  input: readonly string[],
): { ok: true; scopes: IntegrationScope[] } | { ok: false; unknown: string[] } {
  const unknown = input.filter((s) => !isIntegrationScope(s));
  if (unknown.length) return { ok: false, unknown: [...new Set(unknown)] };
  const wanted = new Set(input);
  return { ok: true, scopes: INTEGRATION_SCOPES.filter((s) => wanted.has(s)) };
}

/** Requests per minute one token may make before the gate answers 429. */
export const INTEGRATION_RATE_LIMIT_PER_MINUTE = 60;

/** Longest a token name may be — it is rendered in a list and a card header. */
export const INTEGRATION_TOKEN_NAME_MAX = 64;

/**
 * What the Settings pane and the CLI list. NEVER carries the token value: that
 * exists in exactly one response, at mint time, and is hashed at rest.
 */
export interface IntegrationTokenSummary {
  id: string;
  name: string;
  scopes: IntegrationScope[];
  /** When set, the token may only reach these projects' chats and memory. */
  projectIds?: string[];
  createdAt: number;
  lastUsedAt?: number;
  expiresAt?: number;
  revokedAt?: number;
  /**
   * Reserved for OAuth (workstream F): set when an authorization grant minted
   * this token rather than a human. Hand-minted tokens leave it absent.
   */
  clientId?: string;
}

/** What a mint request carries — from the pane or `cm token create`. */
export interface IntegrationTokenCreateRequest {
  name: string;
  scopes: string[];
  projectIds?: string[];
  /** Epoch ms. Absent means the token never expires on its own. */
  expiresAt?: number;
}

/** The ONE response that ever contains the token value. */
export interface IntegrationTokenCreated {
  token: string;
  summary: IntegrationTokenSummary;
}
