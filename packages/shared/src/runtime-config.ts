/**
 * App-wide agent-runtime configuration.
 *
 * Projects may still override the default harness, and chats may pin their own
 * runtime, but this is the bottom of the fallback chain. Keeping the shape in
 * shared prevents the settings modal, REST client, store, and broker from each
 * inventing a slightly different interpretation of "the Codex config".
 */
import * as z from "zod";
import { EffortSchema, HarnessKindSchema } from "./common.js";

/**
 * How many chats may hold an execution slot at once when nothing says otherwise.
 *
 * Shared because three places have to agree on the same number: the server's env
 * fallback, the broker's clamp, and the settings field's placeholder — which has
 * to name the effective default, or a blank box reads as "no cap" rather than
 * "the default one".
 */
export const DEFAULT_MAX_ACTIVE_SESSIONS = 6;

/** Defaults that only make sense inside one runtime's model catalogue. */
export const HarnessDefaultsSchema = z.object({
  /** Omitted means let the runtime choose its current recommended model. */
  model: z.string().trim().min(1).optional(),
  effort: EffortSchema.optional(),
});
export type HarnessDefaults = z.infer<typeof HarnessDefaultsSchema>;

/** Host-owned context budgets, independent of a model's physical window. */
export const HarnessContextLimitsSchema = z.object({
  /** Compact before a single live chat grows beyond this many tokens. */
  perChatTokens: z.number().int().positive().optional(),
  /** Admission budget for the sum of active chats' last-known context usage. */
  overallTokens: z.number().int().positive().optional(),
});
export type HarnessContextLimits = z.infer<typeof HarnessContextLimitsSchema>;

export const HarnessSettingsSchema = z.object({
  defaultHarness: HarnessKindSchema.default("claude"),
  defaults: z
    .object({
      claude: HarnessDefaultsSchema.optional(),
      codex: HarnessDefaultsSchema.optional(),
    })
    .default({}),
  contextLimits: HarnessContextLimitsSchema.optional(),
});
export type HarnessSettings = z.infer<typeof HarnessSettingsSchema>;
