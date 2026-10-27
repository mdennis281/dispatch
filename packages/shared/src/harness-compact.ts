/**
 * The two shapes a compaction "focus" takes on the wire, kept in one place so
 * the SDK slash command and Codex's injected note can't drift apart from what
 * the broker persists in its "Compacting context…" notice.
 */

import type { HarnessCompactedEvent } from "./harness.js";

/**
 * Trim a focus and drop an empty one, KEEPING its line structure — the
 * Settings textarea invites a list, and the system-prompt section that carries
 * the standing focus has no single-line constraint. Only the two wire shapes
 * below flatten, because they must.
 */
export function normalizeCompactFocus(focus: string | undefined): string | undefined {
  const trimmed = focus?.trim();
  return trimmed ? trimmed : undefined;
}

/** One line, for the places a newline would change meaning. */
export function oneLineFocus(focus: string): string {
  return focus.replace(/\s+/g, " ").trim();
}

/**
 * Claude Code's native `/compact [instructions]`. A newline inside the argument
 * would be read as a second user line, hence the whitespace collapse.
 */
export function compactCommand(focus?: string): string {
  const f = normalizeCompactFocus(focus);
  return f ? `/compact ${oneLineFocus(f)}` : "/compact";
}

/**
 * Codex's `thread/compact/start` takes no argument, so the focus goes in as the
 * last user item in model-visible history right before the summarizer runs —
 * phrased as an instruction to the summary, not to the agent, so it doesn't
 * read as a new task once the turn resumes.
 */
export function codexCompactNote(focus: string): string {
  return (
    "Context is about to be compacted. When writing the summary, make sure it preserves: " +
    `${oneLineFocus(focus)}. This note is guidance for the summary only — it is not a new request.`
  );
}

/** Strip a context-window suffix so "claude-opus-4-8[1m]" and "claude-opus-4-8" compare equal. */
function bareModel(id: string): string {
  return id.replace(/\[[^\]]*\]$/, "");
}

/**
 * The per-model threshold for `modelId`, matched the way `findModel` matches
 * picker rows: exact id first, then ids that differ only by a `[1m]`-style
 * suffix. Settings keys are whatever the picker offered ("opus[1m]"), while a
 * live session may report the resolved wire id — either must hit.
 */
export function perModelThreshold(
  perModel: Record<string, number>,
  modelId: string,
): number | undefined {
  const exact = perModel[modelId];
  if (exact) return exact;
  const bare = bareModel(modelId);
  for (const [key, value] of Object.entries(perModel)) {
    if (bareModel(key) === bare) return value;
  }
  // A chat pinned to a wire id ("claude-fable-5-1", which is what spawn_chat
  // pins) has no picker row of its own when the catalogue only offers it as
  // the "fable" alias — so the slider the user set never matched, and those
  // chats ran to 637k past a 485k threshold. Fall back to the family alias.
  // Spelled as `<vendor>-<family>-…` rather than naming Claude: this module is
  // every provider's, and an id whose second segment is a version number
  // ("gpt-5.6-sol") never matches, so it costs the others nothing.
  const family = /^[a-z]+-([a-z]+)-/.exec(bare)?.[1];
  if (family) {
    for (const [key, value] of Object.entries(perModel)) {
      if (bareModel(key) === family) return value;
    }
  }
  return undefined;
}

/**
 * Read Claude Code's `compact_boundary` metadata into the neutral event. The
 * SDK types it snake_case; anything missing or non-numeric is left out rather
 * than guessed, so the meter keeps its last real reading.
 */
export function compactedEvent(meta: Record<string, unknown> | undefined): HarnessCompactedEvent {
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
  const trigger = meta?.trigger === "auto" || meta?.trigger === "manual" ? meta.trigger : undefined;
  return {
    type: "compacted",
    ...(trigger ? { trigger } : {}),
    ...(num(meta?.pre_tokens) !== undefined ? { preTokens: num(meta?.pre_tokens) } : {}),
    ...(num(meta?.post_tokens) !== undefined ? { postTokens: num(meta?.post_tokens) } : {}),
  };
}

function kTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** The transcript line for a compaction: "Context compacted · 720k → 15k". */
export function compactedText(e: Omit<HarnessCompactedEvent, "type">): string {
  const base = e.trigger === "auto" ? "Context auto-compacted" : "Context compacted";
  if (e.preTokens === undefined) return `${base}.`;
  if (e.postTokens === undefined) return `${base} at ${kTokens(e.preTokens)} tokens`;
  return `${base} · ${kTokens(e.preTokens)} → ${kTokens(e.postTokens)} tokens`;
}
