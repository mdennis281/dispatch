import type { HarnessKind, ModelOption } from "@dispatch/shared";

/**
 * Best-known context window for a catalog row, or `undefined` when we can't say.
 *
 * Neither runtime's model list reports a window — Claude Code's `ModelInfo` has
 * no such field and Codex's `model/list` doesn't either; the authoritative
 * number only arrives on a turn's usage. So this is a table, and it answers
 * `undefined` rather than guess for a provider whose models span 8k to 1M (an
 * ACP agent on Ollama), because a slider whose max is wrong either can't reach
 * the real limit or offers thresholds the model will never get to.
 */
export function modelContextWindow(
  kind: HarnessKind,
  m: Pick<ModelOption, "value" | "resolvedModel">,
): number | undefined {
  const ids = `${m.value} ${m.resolvedModel ?? ""}`;
  if (kind === "claude") return /\[1m\]/i.test(ids) ? 1_000_000 : 200_000;
  // `context_window` for every listed row in ~/.codex/models_cache.json. The
  // runtime keeps 5% back (it reports 258,400 as the usable window), so a
  // threshold in that last sliver behaves the same as "max".
  if (kind === "codex") return 272_000;
  return undefined;
}
