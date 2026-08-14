export interface TranscriptMatch {
  range: Range;
  row: HTMLElement;
}

interface TextSegment {
  node: Text;
  start: number;
  end: number;
}

/**
 * Find case-insensitive matches in rendered transcript rows, including phrases
 * split across Markdown elements (for example text interrupted by `code`).
 */
export function findTranscriptMatches(root: HTMLElement, query: string): TranscriptMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];

  const matches: TranscriptMatch[] = [];
  for (const row of root.querySelectorAll<HTMLElement>("[data-row-id]")) {
    const segments: TextSegment[] = [];
    let text = "";
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest("[data-transcript-search-ignore]")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node = walker.nextNode() as Text | null;
    while (node) {
      const start = text.length;
      text += node.data;
      segments.push({ node, start, end: text.length });
      node = walker.nextNode() as Text | null;
    }

    const haystack = text.toLocaleLowerCase();
    let from = 0;
    while (from <= haystack.length - needle.length) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      const end = at + needle.length;
      const first = segments.find((segment) => segment.end > at);
      const last = segments.findLast((segment) => segment.start < end);
      if (first && last) {
        const range = document.createRange();
        range.setStart(first.node, at - first.start);
        range.setEnd(last.node, end - last.start);
        matches.push({ range, row });
      }
      from = at + Math.max(needle.length, 1);
    }
  }
  return matches;
}
