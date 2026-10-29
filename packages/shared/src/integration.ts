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
import { MANAGER_CATEGORIES, externalManagerTools, type ManagerCategory } from "./manager-tools.js";

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
  // Its own scope, not part of `chats:write`: sending a message into a chat
  // the owner opened is a different grant from starting a NEW agent working
  // in one of their repositories, and the consent page must say so separately.
  "chats:create",
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
 * The categories a `tools:*` scope can actually unlock: those with at least
 * one tool marked external in `MANAGER_TOOL_EXTERNAL`. A category made of
 * session, shell or PR tools has nothing an integration may call, and the
 * mount answers 404 for it however the token was scoped — so `tools:session`
 * is a valid scope that grants nothing.
 *
 * Derived rather than listed, because the list drifted the first time: the
 * token form, the consent page, `scopes_supported` and the grant chips each
 * iterated `MANAGER_CATEGORIES` and offered every dead category as if it were
 * a grant. Every place that OFFERS a scope reads this; every place that
 * VALIDATES one keeps reading {@link INTEGRATION_SCOPES}, so a token minted
 * with a dead scope before this existed still parses.
 */
export const OFFERABLE_TOOL_CATEGORIES: readonly ManagerCategory[] = MANAGER_CATEGORIES.filter(
  (category) => externalManagerTools(category).length > 0,
);

/** `tools:<category>` for every category in {@link OFFERABLE_TOOL_CATEGORIES}. */
export const OFFERABLE_TOOL_SCOPES: readonly IntegrationToolScope[] = OFFERABLE_TOOL_CATEGORIES.map(toolScope);

/**
 * Every scope worth offering, in the pane's order: the fixed scopes, then the
 * `tools:*` scopes with something behind them. What a registration without a
 * `scope` gets, what the AS advertises, what the form ticks.
 */
export const OFFERABLE_INTEGRATION_SCOPES: readonly IntegrationScope[] = [
  ...INTEGRATION_FIXED_SCOPES,
  ...OFFERABLE_TOOL_SCOPES,
];

const OFFERABLE_SET: ReadonlySet<string> = new Set(OFFERABLE_INTEGRATION_SCOPES);

/** Whether a scope grants anything — false for a `tools:*` over an empty category. */
export function isOfferableIntegrationScope(scope: string): scope is IntegrationScope {
  return OFFERABLE_SET.has(scope);
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

/**
 * How far the RECEIVING MODEL may take a token's messages — not what the token
 * may call (that is scopes), but whose words the agent should read them as.
 *
 *  - `external`: a relay from outside Dispatch. The human may never have seen
 *    it, so nothing it asks carries their consent. The default, and what every
 *    token minted before this existed reads as.
 *  - `owner`: the human's own channel — a bot they talk to that passes their
 *    instructions on. Without this, an agent told "this is not from the human"
 *    on every message sensibly refused to merge anything the bot relayed, and
 *    the bot writing "this is Michael" in the text only made it look MORE like
 *    an injection. The authority has to come from here, out of band, where only
 *    the owner can set it.
 *
 * Grants no permission either way: a chat still runs in its own mode.
 */
export const INTEGRATION_TRUST_LEVELS = ["external", "owner"] as const;

export type IntegrationTrust = (typeof INTEGRATION_TRUST_LEVELS)[number];

export function isIntegrationTrust(value: unknown): value is IntegrationTrust {
  return typeof value === "string" && (INTEGRATION_TRUST_LEVELS as readonly string[]).includes(value);
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
  /** Always present here; a row stored without one reads as `external`. */
  trust: IntegrationTrust;
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

/** What a mint request carries — from the pane or `dispatch token create`. */
export interface IntegrationTokenCreateRequest {
  name: string;
  scopes: string[];
  projectIds?: string[];
  /** Epoch ms. Absent means the token never expires on its own. */
  expiresAt?: number;
  /** Absent means `external`. */
  trust?: IntegrationTrust;
}

/** What an edit to a live token may change — only what is safe to change in place. */
export interface IntegrationTokenUpdateRequest {
  trust: IntegrationTrust;
}

/** The ONE response that ever contains the token value. */
export interface IntegrationTokenCreated {
  token: string;
  summary: IntegrationTokenSummary;
}
