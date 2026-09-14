/**
 * Claude subscription usage — the 5-hour rolling window + weekly (7-day) window
 * the Claude Code `/usage` command shows. Sourced server-side from the account's
 * OAuth usage endpoint, cached, and pushed to clients via the `usage-update` wire
 * event. Purely informational: it drives the header usage meter, nothing gates on
 * it.
 */
import * as z from "zod";
import { HarnessKindSchema } from "./common.js";

/** One rate-limit window: how much of the quota is used + when it resets. */
export const UsageWindowSchema = z.object({
  /** Percent of the window's quota consumed (0–100; can momentarily exceed 100). */
  percent: z.number(),
  /** When this window resets, epoch ms (null when the source omits it). */
  resetsAt: z.number().int().nullable(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

/** A window with its own name — the provider-neutral unit the usage card draws. */
export const TitledUsageWindowSchema = UsageWindowSchema.extend({
  /** As the provider names it: "5-hour session", "Weekly", "3-day window". */
  title: z.string(),
});
export type TitledUsageWindow = z.infer<typeof TitledUsageWindowSchema>;

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
  provider: HarnessKindSchema.optional(),
  /**
   * Whose windows these are. Limits belong to an ACCOUNT, not a provider, so a
   * snapshot without this is ambiguous the moment there are two Claude logins.
   */
  subscriptionId: z.string().optional(),
  primaryLabel: z.string().optional(),
  secondaryLabel: z.string().optional(),
  planType: z.string().optional(),
  /**
   * Every window this account has, when the provider reports more (or other)
   * than the two named slots above. Absent means read `fiveHour`/`sevenDay` —
   * see {@link usageWindowsOf}, the one place that decides.
   */
  windows: z.array(TitledUsageWindowSchema).optional(),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;

/**
 * A snapshot's windows as a list, in the provider's order.
 *
 * `fiveHour`/`sevenDay` are Claude's two windows given slot names, and every
 * consumer used to hard-code exactly those two rows. A list is what lets Codex
 * show its one window and a future provider its N without the card changing.
 */
export function usageWindowsOf(snapshot: UsageSnapshot): TitledUsageWindow[] {
  if (snapshot.windows) return snapshot.windows;
  const out: TitledUsageWindow[] = [];
  if (snapshot.fiveHour) {
    out.push({ ...snapshot.fiveHour, title: snapshot.primaryLabel ?? "5-hour session" });
  }
  if (snapshot.sevenDay) {
    out.push({ ...snapshot.sevenDay, title: snapshot.secondaryLabel ?? "Weekly" });
  }
  return out;
}

/** One account's usage, as the usage card stacks it. */
export const SubscriptionUsageSchema = z.object({
  subscriptionId: z.string(),
  /** Display name — the account's own, or its provider's for an implicit one. */
  name: z.string(),
  provider: HarnessKindSchema,
  planType: z.string().optional(),
  windows: z.array(TitledUsageWindowSchema),
  fetchedAt: z.number().int(),
  stale: z.boolean().optional(),
  error: z.string().optional(),
});
export type SubscriptionUsage = z.infer<typeof SubscriptionUsageSchema>;

/** Every logged-in account's usage at once — `GET /api/usage/subscriptions`. */
export const UsageOverviewSchema = z.object({
  fetchedAt: z.number().int(),
  subscriptions: z.array(SubscriptionUsageSchema),
});
export type UsageOverview = z.infer<typeof UsageOverviewSchema>;

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
