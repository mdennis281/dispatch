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
 * Shared because the server's env fallback, the broker's clamp and the settings
 * field all need the same floor. It is only the floor: `DISPATCH_MAX_ACTIVE_SESSIONS`
 * moves the effective default above it, which is why the field asks the server
 * (`GET /api/settings/defaults`) what to print rather than printing this — a blank
 * box has to name the number actually in force, not the one shipped.
 */
export const DEFAULT_MAX_ACTIVE_SESSIONS = 6;

/**
 * Minutes a chat may sit idle before its subprocess is retired.
 *
 * The tree behind an idle chat is ~1.3 GB and nothing used to take it back, so
 * fifteen chats opened over a morning ran the machine out of commit. Purging is
 * cheap because `SessionBroker.stop()` re-arms `resumeSessionId`: the next
 * message resumes the SDK session with its context, so what a purge costs is
 * that message's spin-up, not the conversation.
 *
 * Thirty minutes rather than something aggressive, because the chats worth
 * keeping warm are the ones you are cycling through, and those are rarely quiet
 * for half an hour. `0` switches the sweep off entirely.
 */
export const DEFAULT_IDLE_SESSION_MINUTES = 30;

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
