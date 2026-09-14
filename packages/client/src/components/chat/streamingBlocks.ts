/**
 * Split a still-growing markdown buffer into the blocks that can no longer
 * change and the one that still can.
 *
 * WHY. A streaming reply was re-parsed from its first character on every
 * render — and it rendered per token AND per animation frame of the typewriter
 * trail, so a 12 kB answer cost ~35 ms of micromark + syntax highlighting up to
 * 60 times a second: one renderer pinned past a full core for as long as the
 * agent kept talking (see the profile in the PR that added this). The text
 * above the last paragraph break is finished prose; parsing it again buys
 * nothing. Splitting it off lets the caller memoise each settled block and pay
 * for the tail alone, which is a paragraph, not a document.
 *
 * WHAT COUNTS AS A BOUNDARY. A blank line outside a fenced code block, where
 * the next line has already started and starts at column 0. Two of those
 * conditions are there for correctness, not tidiness:
 *
 *   • Inside a fence a blank line is content, not a break. Splitting there
 *     would close the block early and render the rest as prose.
 *   • An INDENTED next line is a continuation — a list item's second
 *     paragraph, a nested item — and belongs to the block above. Which is why
 *     the split waits for the next line's first character to arrive: a buffer
 *     ending in "\n\n" cannot yet say whether what follows is indented.
 *
 * And one for the eye: a list item followed by a blank line and another list
 * item is one loose list, not two. Cut there and the second `1.` would print
 * as `1.` again until the turn settled, because the `ol` renderer ignores the
 * `start` attribute.
 *
 * Anything this misses (a link-reference definition at the end of a message, a
 * fence the model never closed) is a transient: the finalised row re-renders
 * the whole text through one parser and every edge case resolves itself. The
 * split only has to be right for as long as the cursor is blinking.
 */
export interface StreamingSplit {
  /** Finished blocks, in order, each renderable as a standalone document. */
  settled: string[];
  /** The block still being written to. May be empty. */
  tail: string;
}

const EMPTY: StreamingSplit = { settled: [], tail: "" };

/** ``` or ~~~ (three or more) after at most three spaces — a fence line. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A bullet or ordered list marker followed by whitespace. */
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s/;

function closesFence(line: string, open: string): boolean {
  const m = FENCE.exec(line);
  if (!m) return false;
  const run = m[1]!;
  return run[0] === open[0] && run.length >= open.length && line.slice(m[0].length).trim() === "";
}

/**
 * Pure and non-incremental: a linear scan of the buffer. At 60 fps over a 50 kB
 * reply that is still microseconds, which is nothing next to the parse it
 * replaces — and it keeps the function trivially testable.
 */
export function splitStreaming(text: string): StreamingSplit {
  if (!text) return EMPTY;
  const settled: string[] = [];
  let blockStart = 0;
  let fence: string | null = null;
  // Position just past the newline that ends the current line.
  let lineStart = 0;
  while (lineStart < text.length) {
    const nl = text.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(lineStart, lineEnd);
    const next = nl === -1 ? text.length : nl + 1;

    if (fence) {
      if (closesFence(line, fence)) fence = null;
    } else if (FENCE.test(line)) {
      fence = FENCE.exec(line)![1]!;
    } else if (line.trim() === "" && nl !== -1 && lineStart > blockStart) {
      // A blank line. Walk over any further blank lines to the first character
      // of whatever comes next; if that character hasn't arrived, stop here.
      let probe = next;
      while (probe < text.length && text[probe] === "\n") probe += 1;
      const nextLineEnd = text.indexOf("\n", probe);
      const nextLine = text.slice(probe, nextLineEnd === -1 ? text.length : nextLineEnd);
      if (probe >= text.length) break;
      if (nextLine.trim() === "") {
        // Whitespace-only line still being typed (or a run of them).
        lineStart = next;
        continue;
      }
      const indented = /^\s/.test(nextLine);
      const block = text.slice(blockStart, lineStart);
      const continuesList = LIST_ITEM.test(block) && LIST_ITEM.test(nextLine);
      if (!indented && !continuesList) {
        settled.push(block);
        blockStart = probe;
        lineStart = probe;
        continue;
      }
    }
    lineStart = next;
  }
  return { settled, tail: text.slice(blockStart) };
}
