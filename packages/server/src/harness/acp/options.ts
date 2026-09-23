/**
 * Dispatch's session vocabulary → ACP's.
 *
 * The interesting translation is permission posture. Dispatch (following Claude
 * Code) expresses it as ONE mode covering both "what will you ask me about" and
 * "what may you touch". ACP expresses it as a list of agent-declared MODES,
 * returned from `session/new` and switchable with `session/set_mode`. goose
 * declares four, verified against goose 1.51.0:
 *
 *   auto           "Automatically approve tool calls"
 *   approve        "Ask before every tool call"
 *   smart_approve  "Ask only for sensitive tool calls"
 *   chat           "Chat only, no tool calls"
 *
 * Two of those are better matches than anything Codex offers:
 *
 *   plan   → `chat`. A genuine no-tools mode, ENFORCED by the agent rather than
 *            requested of the model. Strictly stronger than Claude's plan mode,
 *            which relies on the model declining to act.
 *   default→ `approve`/`smart_approve`. ACP asks per TOOL CALL, not per command
 *            class, which is why this provider can advertise
 *            `toolPermissions: true` where Codex must advertise false.
 *
 * And one axis is genuinely missing: ACP cannot split approval BY TOOL KIND, so
 * "auto-approve edits but still ask about commands" has no spelling. Every
 * Dispatch mode that means that lands on `smart_approve` and the difference is
 * documented at the mapping rather than silently approximated.
 */
import type { Effort, PermissionMode } from "@dispatch/shared";

/** The mode ids goose declares. Other ACP agents may name these differently. */
export type AcpModeId = "auto" | "approve" | "smart_approve" | "chat";

/**
 * Dispatch permission mode → ACP mode id.
 *
 * `default`, `acceptEdits` and `auto` all collapse onto `smart_approve`
 * because ACP has no per-tool-kind axis to distinguish them. That is a real
 * loss of fidelity: on Claude, `acceptEdits` means edits pass silently while
 * commands still prompt. Here both are judged by the agent's own notion of
 * "sensitive". It is the closest honest mapping; the alternative — mapping
 * `acceptEdits` to `auto` — would silently auto-approve COMMANDS too, which is
 * a safety regression, so we bias toward asking.
 */
export function toAcpMode(mode: PermissionMode): AcpModeId {
  switch (mode) {
    case "plan":
      // Hard read-only: the agent refuses to call tools at all.
      return "chat";
    case "dontAsk":
    case "bypassPermissions":
      return "auto";
    case "acceptEdits":
    case "auto":
    case "default":
    default:
      return "smart_approve";
  }
}

/** One choice offered on an ACP permission request. */
export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

/**
 * Pick which offered option answers an allow/deny decision.
 *
 * goose offers four kinds — `allow_once`, `allow_always`, `reject_once`,
 * `reject_always`. Dispatch decides ONE tool call at a time (the broker re-asks
 * for the next one), so the `_once` variants are what we want: answering
 * `allow_always` would hand the agent a standing grant that outlives the
 * decision the human actually made, and Dispatch would never see the following
 * calls to apply its workflow guard to them.
 *
 * Matching is on `kind` first and `optionId` second because `kind` is the
 * protocol-level field; the id is an agent-chosen string that merely happens to
 * be identical in goose. Falls back to the first option of the right polarity
 * so an agent with a different vocabulary still gets a usable answer rather
 * than a hang.
 */
export function pickPermissionOption(
  options: AcpPermissionOption[],
  decision: "allow" | "deny",
): string | undefined {
  const want = decision === "allow" ? "allow" : "reject";
  const scored = options.filter((o) => {
    const k = `${o.kind ?? ""} ${o.optionId ?? ""}`.toLowerCase();
    return k.includes(want) || (want === "reject" && k.includes("deny"));
  });
  const once = scored.find((o) => `${o.kind ?? ""} ${o.optionId ?? ""}`.toLowerCase().includes("once"));
  return (once ?? scored[0] ?? options[0])?.optionId;
}

/**
 * Dispatch's system-prompt appends → the ACP field that carries them.
 *
 * ACP has no dedicated "append to your system prompt" slot: `session/prompt`
 * takes content blocks and that is all. So the appends are delivered as a
 * leading text block on the FIRST prompt of a session, which is the same shape
 * the Codex adapter's `developerInstructions` ends up with — layered on top of
 * the agent's own prompt rather than replacing it, so goose keeps its own tool
 * guidance and safety framing.
 *
 * Returns undefined when there is nothing to say, so a session with no policy
 * does not get an empty block.
 */
export function toInstructionBlock(appends: string[]): string | undefined {
  const joined = appends.filter((a) => a && a.trim()).join("\n\n");
  return joined || undefined;
}

/**
 * ACP has no reasoning-effort concept.
 *
 * There is no field for it on `initialize`, `session/new` or `session/prompt`,
 * and goose declares none. This exists so the omission is stated in code rather
 * than being an absence a reader has to notice: the provider advertises
 * `efforts: []`, the composer hides the control, and an effort that arrives on
 * a spec is dropped here deliberately.
 */
export function toAcpEffort(_effort: Effort): undefined {
  return undefined;
}
