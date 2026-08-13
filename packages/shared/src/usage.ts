/**
 * Claude subscription usage — the 5-hour rolling window + weekly (7-day) window
 * the Claude Code `/usage` command shows. Sourced server-side from the account's
 * OAuth usage endpoint, cached, and pushed to clients via the `usage-update` wire
 * event. Purely informational: it drives the header usage meter, nothing gates on
 * it.
 */
import * as z from "zod";

/** One rate-limit window: how much of the quota is used + when it resets. */
export const UsageWindowSchema = z.object({
  /** Percent of the window's quota consumed (0–100; can momentarily exceed 100). */
  percent: z.number(),
  /** When this window resets, epoch ms (null when the source omits it). */
  resetsAt: z.number().int().nullable(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

/**
 * A point-in-time snapshot of the account's usage. `fiveHour`/`sevenDay` are null
 * when the source didn't report that window (or the fetch failed). `error` marks
 * why the last refresh couldn't produce fresh numbers; `stale` says the shown
 * windows are the last good ones, kept while a refresh is failing/backing off.
 */
export const UsageSnapshotSchema = z.object({
  fiveHour: UsageWindowSchema.nullable(),
  sevenDay: UsageWindowSchema.nullable(),
  /** When these numbers were fetched, epoch ms. */
  fetchedAt: z.number().int(),
  /** Last refresh failed (rate-limited / auth / network) — windows may be stale. */
  stale: z.boolean().optional(),
  /** Coarse failure reason: "unauthenticated" | "rate_limited" | "unavailable" | message. */
  error: z.string().optional(),
  provider: z.enum(["claude", "codex"]).optional(),
  primaryLabel: z.string().optional(),
  secondaryLabel: z.string().optional(),
  planType: z.string().optional(),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;

/* ------------------------------------------------- per-chat context window */

/** One category in the context-window breakdown (system prompt, tools, MCP…). */
export const ContextUsageCategorySchema = z.object({
  name: z.string(),
  tokens: z.number(),
  /** Swatch color the SDK assigns the category (hex); optional for our uses. */
  color: z.string().optional(),
});
export type ContextUsageCategory = z.infer<typeof ContextUsageCategorySchema>;

/**
 * A live snapshot of one chat's context-window occupancy, sourced from the SDK's
 * `getContextUsage()` control. `maxTokens` is the authoritative window for the
 * session's model (1M for the Opus 1M variant, 200k otherwise), so the composer
 * meter never has to assume a size. `categories` breaks the total down for the
 * meter's dropup. A superset of the SDK response, narrowed to what the UI uses.
 */
export const ContextUsageSchema = z.object({
  /** Tokens currently occupying the window. */
  totalTokens: z.number(),
  /** The model's usable context window (tokens) — the meter's denominator. */
  maxTokens: z.number(),
  /** Window before any safety headroom is subtracted (informational). */
  rawMaxTokens: z.number().optional(),
  /** Fill fraction as a percentage (0–100). */
  percentage: z.number(),
  /** Model id the window belongs to. */
  model: z.string().optional(),
  categories: z.array(ContextUsageCategorySchema).default([]),
});
export type ContextUsage = z.infer<typeof ContextUsageSchema>;
