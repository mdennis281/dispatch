/**
 * Plugin approval requests (`ctx.approvals.request`, capability `approvals`):
 * a plugin putting ONE decision in front of the human — "run
 * `sudo installer -pkg …` on CVX Mac?" — on the same card, Attention Queue
 * entry and push notification a tool-call permission gets.
 *
 * What lives here is the part both halves read: the pseudo tool name the card
 * is filed under and the payload it renders. The server owns everything that
 * decides anything (docs/plugins.md → "Approval requests").
 */
import * as z from "zod";

/**
 * The `toolName` a plugin approval's permission card carries.
 *
 * Deliberately not a name any tool can have — a colon is legal in no
 * harness's tool names — so a real tool call can never be dressed up as a
 * plugin approval in the transcript, and an "Always allow" rule can never be
 * written for it (the server refuses `remember` on these regardless).
 * The SERVER never trusts it as an identifier: it marks the pending entry
 * itself, so only the client's choice of card keys off this string.
 */
export const PLUGIN_APPROVAL_TOOL = "dispatch:plugin-approval";

/** Default wait before an unanswered approval resolves `timeout`. */
export const PLUGIN_APPROVAL_DEFAULT_TIMEOUT_SECONDS = 300;
/** Longest wait a plugin may ask for. An hour: past that, nobody is coming. */
export const PLUGIN_APPROVAL_MAX_TIMEOUT_SECONDS = 3600;

/** Field caps. The card is a decision, not a log viewer. */
export const PLUGIN_APPROVAL_LIMITS = {
  title: 200,
  detail: 4000,
  command: 8000,
  cwd: 1000,
  machine: 200,
} as const;

/**
 * What the card renders, stored on the permission row's `input` under
 * `pluginApproval`. Every field is the plugin's own words EXCEPT `pluginId`
 * and `pluginName`, which the host fills from the manifest — a plugin cannot
 * ask in another plugin's name.
 */
export const PluginApprovalCardSchema = z.object({
  pluginId: z.string(),
  pluginName: z.string(),
  title: z.string(),
  detail: z.string().optional(),
  /** The exact command, already shell-quoted by the plugin. Shown verbatim, never edited. */
  command: z.string().optional(),
  cwd: z.string().optional(),
  /** Where it will run, as the plugin labels it ("CVX Mac"). */
  machine: z.string().optional(),
  /** Epoch ms after which it resolves `timeout`. */
  expiresAt: z.number().int(),
});
export type PluginApprovalCard = z.infer<typeof PluginApprovalCardSchema>;

/**
 * The approval payload on a permission row, or null when the row is anything
 * else. Parsed rather than cast, and keyed on BOTH the tool name and the
 * payload: a row is re-read from disk for as long as the chat exists, and a
 * malformed one must fall back to the generic card rather than throw.
 */
export function readPluginApproval(toolName: string, input: Record<string, unknown>): PluginApprovalCard | null {
  if (toolName !== PLUGIN_APPROVAL_TOOL) return null;
  const parsed = PluginApprovalCardSchema.safeParse(input.pluginApproval);
  return parsed.success ? parsed.data : null;
}

/** How a plugin approval ended. `timeout` and `cancelled` are a no, said by nobody. */
export const PLUGIN_APPROVAL_DECISIONS = ["approved", "denied", "timeout", "cancelled"] as const;
export type PluginApprovalDecision = (typeof PLUGIN_APPROVAL_DECISIONS)[number];

/**
 * How a settled approval ended, from its persisted row's `input.outcome`. The
 * row's own `decision` is only allow/deny — the permission channel's words —
 * and "deny" would say a person refused when nobody answered at all.
 */
export function readPluginApprovalOutcome(input: Record<string, unknown>): PluginApprovalDecision | undefined {
  const o = input.outcome;
  return typeof o === "string" && (PLUGIN_APPROVAL_DECISIONS as readonly string[]).includes(o)
    ? (o as PluginApprovalDecision)
    : undefined;
}

/**
 * The transcript line a decision leaves behind — "Approved by Michael: `sudo
 * installer -pkg …` on CVX Mac". Shared so the server's notice and any test
 * that asserts on it say the same sentence.
 */
export function pluginApprovalNotice(
  card: Pick<PluginApprovalCard, "pluginName" | "title" | "command" | "machine">,
  decision: PluginApprovalDecision,
  by?: string,
): string {
  const what = card.command ? `\`${oneLine(card.command, 300)}\`` : oneLine(card.title, 200);
  const where = card.machine ? ` on ${card.machine}` : "";
  const subject = `${what}${where} (asked by ${card.pluginName})`;
  switch (decision) {
    case "approved":
      return `Approved${by ? ` by ${by}` : ""}: ${subject}`;
    case "denied":
      return `Denied${by ? ` by ${by}` : ""}: ${subject}`;
    case "timeout":
      return `Not approved — nobody answered in time: ${subject}`;
    case "cancelled":
      return `Approval request withdrawn: ${subject}`;
  }
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
