/**
 * Subsequence fuzzy matching, shared by the command palette and the sidebar's
 * project switcher.
 *
 * Lifted out of `CommandPalette` when the switcher grew a search box: two
 * scorers that disagree about what "wor" matches would mean the same query finds
 * a project in one box and not the other.
 */

export interface FuzzyMatch {
  score: number;
  /** Indices into `text` of the characters that matched, ascending. */
  indices: number[];
}

/**
 * null when `query` isn't a subsequence of `text`, else a score that rewards
 * contiguous runs and word-boundary hits. Empty query → score 0 with no indices
 * (keep everything in its natural order via a stable sort).
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  if (!query) return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  let last = -2;
  const indices: number[] = [];
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      streak = last === ti - 1 ? streak + 1 : 0;
      const prev = ti > 0 ? t[ti - 1] : undefined;
      const boundary = prev === undefined || /[\s\-_/.]/.test(prev);
      score += 1 + streak * 2 + (boundary ? 3 : 0);
      last = ti;
      indices.push(ti);
      qi++;
    }
  }
  return qi === q.length ? { score, indices } : null;
}

/** {@link fuzzyMatch}'s score alone. */
export function fuzzyScore(query: string, text: string): number | null {
  return fuzzyMatch(query, text)?.score ?? null;
}
