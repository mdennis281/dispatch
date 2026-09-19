/**
 * The two shapes a compaction "focus" takes on the wire, kept in one place so
 * the SDK slash command and Codex's injected note can't drift apart from what
 * the broker persists in its "Compacting context…" notice.
 */

/** Collapse whitespace and drop an empty focus, so `/compact ` is never sent. */
export function normalizeCompactFocus(focus: string | undefined): string | undefined {
  const trimmed = focus?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Claude Code's native `/compact [instructions]`. A newline inside the argument
 * would be read as a second user line, hence the whitespace collapse.
 */
export function compactCommand(focus?: string): string {
  const f = normalizeCompactFocus(focus);
  return f ? `/compact ${f}` : "/compact";
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
    `${focus}. This note is guidance for the summary only — it is not a new request.`
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
  return undefined;
}
