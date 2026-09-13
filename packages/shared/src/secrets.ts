/**
 * SECRETS — the contract between the secret store, `secret_request`, the card
 * that collects a value, and the placeholders that consume one.
 *
 * The rule every piece of this file serves: **a secret value never crosses the
 * model's context.** An agent can ASK for a secret by name, LIST names, and
 * REFER to one with `${secret:NAME}` — it can never read one back. The value
 * travels exactly one route: the human types it into a card, the card PUTs it
 * straight to `/api/secrets`, and the card then answers the question with a
 * word that contains no secret. The alternative this replaces is an agent
 * saying "paste your API key here", which lands the key in a transcript on
 * disk, in the model provider's logs, and in any memory the agent writes after.
 *
 * What it is NOT is a wall between an agent and a value it has been given: once
 * a secret is expanded into a sub-app's or MCP server's environment, anything
 * with a shell in that tree can print it. The guarantee is about transcripts,
 * commits and memory, not about a determined process.
 */
import * as z from "zod";

/**
 * A secret's name — an env-style identifier, because that is what it most often
 * becomes and what `${secret:NAME}` has to parse unambiguously. Capped so a name
 * fits a card header and an Attention Queue row.
 */
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export const SECRET_SCOPES = ["project", "global"] as const;
export type SecretScope = (typeof SECRET_SCOPES)[number];

/** Upper bound on a value. Big enough for a PEM bundle, small enough to refuse a pasted file. */
export const SECRET_VALUE_MAX = 64 * 1024;

/** The agent's reason, shown on the card. Capped for the same reason a review summary is. */
export const SECRET_WHY_MAX = 300;

export const SecretNameSchema = z.string().regex(SECRET_NAME_RE, {
  message: "A secret name is letters, digits and underscores, starting with a letter or underscore (max 64).",
});

/** What anything outside the store may know about a secret: everything but the value. */
export const SecretSummarySchema = z.object({
  name: SecretNameSchema,
  scope: z.enum(SECRET_SCOPES),
  /** Set when `scope` is `project`. */
  projectId: z.string().optional(),
  updatedAt: z.number(),
});
export type SecretSummary = z.infer<typeof SecretSummarySchema>;

/** Where a secret is referenced from, for the settings view and the refresh report. */
export interface SecretUsage {
  projectId: string;
  /** `mcp:<server>` or `subapp:<id>`. */
  consumer: string;
}

/** What a set/delete refreshed, reported back to whoever changed the secret. */
export interface SecretRefreshReport {
  /** Projects whose config was reloaded because they reference the secret. */
  projects: string[];
  /** MCP servers (qualified `projectId/server`) whose definition picked up the new value. */
  mcpServers: string[];
  /** Live chats whose MCP servers were swapped in place. */
  chatsRefreshed: string[];
  /** Live chats that reference it but whose runtime can't swap servers mid-session. */
  chatsOnNextSession: string[];
  /** Running sub-app instances restarted onto the new value. */
  subAppsRestarted: string[];
}

export const EMPTY_REFRESH_REPORT: SecretRefreshReport = {
  projects: [],
  mcpServers: [],
  chatsRefreshed: [],
  chatsOnNextSession: [],
  subAppsRestarted: [],
};

/** `PUT /api/secrets` body. The only way a value enters the system. */
export const SecretPutSchema = z.object({
  name: SecretNameSchema,
  scope: z.enum(SECRET_SCOPES),
  projectId: z.string().optional(),
  value: z.string().min(1).max(SECRET_VALUE_MAX),
});
export type SecretPut = z.infer<typeof SecretPutSchema>;

/** `DELETE /api/secrets` body. */
export const SecretDeleteSchema = z.object({
  name: SecretNameSchema,
  scope: z.enum(SECRET_SCOPES),
  projectId: z.string().optional(),
});
export type SecretDelete = z.infer<typeof SecretDeleteSchema>;

/**
 * The option labels a secret card answers with. Neither carries the value —
 * `Saved` is only a claim, and the broker checks the store's timestamp before
 * believing it (see `readSecretRequest`'s caller), so an older client's plain
 * question card pressing "Saved" without ever sending a value reads as skipped.
 */
export const SECRET_ANSWERS = { saved: "Saved", skip: "Skip" } as const;

/** The `secret` payload riding a secret card's input, beside its `questions`. */
export const SecretRequestPayloadSchema = z.object({
  name: SecretNameSchema,
  scope: z.enum(SECRET_SCOPES),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  why: z.string().min(1).max(SECRET_WHY_MAX),
  /** A value already exists at this scope — the card says "replace". */
  exists: z.boolean(),
  /** When the card went up; a save must land after this to count. */
  requestedAt: z.number(),
});
export type SecretRequestPayload = z.infer<typeof SecretRequestPayloadSchema>;

/**
 * The secret payload on a permission row's input, or null for any other card.
 * Parsed, not cast, for the same reason as `readHumanReview`: rows are re-read
 * from disk for the life of the chat.
 */
export function readSecretRequest(input: Record<string, unknown>): SecretRequestPayload | null {
  const parsed = SecretRequestPayloadSchema.safeParse(input.secret);
  return parsed.success ? parsed.data : null;
}
