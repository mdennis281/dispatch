import { parseSessionLimit, type AssistantMessageRow } from "@dispatch/shared";
import type { TranscriptItem, TranscriptThinkingItem } from "./toolPresentations.js";

/**
 * Is this text nothing but a usage-limit notice? Single-line, so a real answer
 * that merely mentions hitting a limit is never swallowed.
 *
 * Lives here because it decides which assistant rows render NOTHING, which is
 * exactly what {@link continuedAssistantIds} has to know to judge adjacency.
 */
export function isLimitSentence(text: string | undefined): boolean {
  const t = text?.trim();
  if (!t || t.includes("\n")) return false;
  return parseSessionLimit(t, Date.now()) !== null;
}

/** Same speaker, same badges — anything else deserves its own header. */
function sameSpeaker(a: AssistantMessageRow, b: AssistantMessageRow): boolean {
  return a.harness === b.harness && a.model === b.model && a.subagentType === b.subagentType;
}

/**
 * The assistant rows that should render WITHOUT a header — avatar, name, model
 * chip and clock — because they continue the message directly above them.
 *
 * Adjacency is VISUAL: a tool card, a shell run, a permission, a turn footer,
 * anything the reader can see between two messages brings the header back,
 * because their eye has left the speaker and needs telling who resumed. What
 * they cannot see must not: a usage-limit sentence is dropped from the
 * transcript (it reappears as the pause card), and an item the filter has
 * collapsed — a hidden shell run, a hidden thinking stack — is still in the
 * list but takes up no space, so a header after it would announce a speaker
 * who, on screen, never left.
 */
export function continuedAssistantIds(
  items: TranscriptItem[],
  isHidden: (item: TranscriptItem) => boolean = () => false,
): Set<string> {
  const ids = new Set<string>();
  let prev: AssistantMessageRow | null = null;
  for (const item of items) {
    const row = item.kind === "row" ? item.row : null;
    if (row?.kind === "assistant") {
      if (isLimitSentence(row.text)) continue;
      if (prev && sameSpeaker(prev, row)) ids.add(row.id);
      prev = row;
      continue;
    }
    if (isHidden(item)) continue;
    prev = null;
  }
  return ids;
}

/**
 * Merge thinking stacks that are separated only by items the reader cannot
 * see, moving the invisible items after the merged stack. `isHidden` is the
 * same predicate {@link continuedAssistantIds} takes — one definition of
 * "invisible" for both, so the two can never disagree about what is on screen.
 *
 * Thinking is almost never literally adjacent to more thinking: a turn thinks,
 * then calls a tool, then thinks again. So with every category shown the
 * stacks are singletons and this is a no-op — the honest sequence. But hide the
 * shell (the whole point of the filter, and how a long tool stretch is usually
 * read) and the transcript becomes thought / nothing / thought / nothing, which
 * should read as ONE run of reasoning. `groupTranscriptRows` cannot know that:
 * it is filter-agnostic, and the filter is a per-chat React subscription.
 *
 * The hidden items are kept, not dropped — they still render (collapsed and
 * animated by their own component), so un-hiding them later has something to
 * expand. They are pushed after the stack rather than left inside it, which
 * changes DOM order only while they are invisible.
 */
export function stackThinkingAcrossHidden(
  items: TranscriptItem[],
  isHidden: (item: TranscriptItem) => boolean,
): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  // Index in `out` of the stack the next thinking item may join, if everything
  // pushed since it was hidden.
  let open = -1;
  for (const item of items) {
    if (item.kind === "thinking") {
      if (open >= 0) {
        const stack = out[open] as TranscriptThinkingItem;
        out[open] = { kind: "thinking", rows: [...stack.rows, ...item.rows] };
      } else {
        out.push(item);
        open = out.length - 1;
      }
      continue;
    }
    out.push(item);
    if (!(open >= 0 && isHidden(item))) open = -1;
  }
  return out;
}

/**
 * The transcript positions that must NOT draw their bottom hairline: the item
 * directly above a continued assistant row. `continued` already drops that
 * row's avatar and header so the pair reads as one message — leaving the
 * divider in puts the seam back louder than the header ever was, which is how
 * a single turn ended up looking like six rules stacked down the page.
 *
 * Items the reader cannot see are walked THROUGH, not stopped at: the same
 * adjacency {@link continuedAssistantIds} judged by. Their own hairline goes
 * too, or a collapsed run would leave behind the rule it was hiding under.
 */
export function undividedItemIndices(
  items: TranscriptItem[],
  continued: Set<string>,
  isHidden: (item: TranscriptItem) => boolean = () => false,
): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.kind !== "row" || item.row.kind !== "assistant") continue;
    if (!continued.has(item.row.id)) continue;
    for (let j = i - 1; j >= 0; j--) {
      out.add(j);
      const above = items[j]!;
      const dropped =
        above.kind === "row" && above.row.kind === "assistant" && isLimitSentence(above.row.text);
      if (!isHidden(above) && !dropped) break;
    }
  }
  return out;
}
