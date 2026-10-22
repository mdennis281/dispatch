/**
 * Turns a streamed assistant reply into things worth saying.
 *
 * A TTS engine wants sentences: feed it token deltas and it either speaks
 * half-words or waits for the whole reply, and both are the "talking to a
 * machine" feel voice mode exists to avoid. So the host buffers deltas here
 * and hands the engine a sentence each time one completes, then the tail on
 * flush.
 *
 * Two conventions, both from voice mode (docs/plugins.md → "Client host"):
 *
 *   - The SPOKEN part of a reply precedes a horizontal rule. A voice-mode
 *     prompt keeps the forward-facing answer short above `---` and puts the
 *     detail below it; the chunker stops at the first rule and ignores the
 *     rest, so a code dump never gets read aloud.
 *   - Markdown is stripped lightly — emphasis, inline code, headings, link
 *     syntax, list bullets — because "asterisk asterisk bold asterisk
 *     asterisk" is what a synthesizer says otherwise. Fenced code blocks are
 *     dropped whole.
 *
 * Pure — no DOM, no engine — so the boundary rules are unit-testable.
 */

/** A line that is only a markdown rule: `---`, `***`, `___`, three or more, spaces allowed. */
const RULE_LINE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/**
 * Where a sentence ends: terminal punctuation (optionally wrapped in a closing
 * quote or bracket) followed by whitespace, or a line break. The whitespace
 * is the part that matters for streaming — `3.` at the end of a delta may be
 * the start of `3.14`, and nothing says a sentence has ended until the next
 * character arrives and is a space.
 */
const BOUNDARY = /([.!?…]+["'”’)\]]*)(\s+)|(\n+)/g;

const FENCE = /```[\s\S]*?```/g;

/** Light markdown removal for speech. Exported for the tests. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(FENCE, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "")
    .replace(/^[ \t]*\d+[.)][ \t]+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, "$2")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export class SentenceChunker {
  private buf = "";
  private stopped = false;

  /**
   * Append a delta and return every sentence that is now complete, in order.
   * Returns nothing once a horizontal rule has been seen.
   */
  feed(delta: string): string[] {
    if (this.stopped) return [];
    this.buf += delta;
    const out: string[] = [];
    // Everything up to a complete rule line is still sentences — split them
    // the normal way, then stop. Scanning the rule first rather than letting
    // the boundary loop reach it means the rule's own line never becomes
    // "part" of a sentence.
    const rule = this.findRule();
    let text = rule === null ? this.buf : this.buf.slice(0, rule);
    for (;;) {
      BOUNDARY.lastIndex = 0;
      const m = BOUNDARY.exec(text);
      if (!m) break;
      const end = m.index + (m[1]?.length ?? 0) + (m[2]?.length ?? 0) + (m[3]?.length ?? 0);
      const sentence = cleanForSpeech(text.slice(0, end));
      text = text.slice(end);
      if (sentence) out.push(sentence);
    }
    if (rule === null) {
      this.buf = text;
    } else {
      const last = cleanForSpeech(text);
      if (last) out.push(last);
      this.buf = "";
      this.stopped = true;
    }
    return out;
  }

  /** Nothing more is coming: the unfinished tail, if any. Resets for the next reply. */
  flush(): string | null {
    const tail = this.stopped ? "" : this.buf;
    this.buf = "";
    this.stopped = false;
    // A trailing rule with no newline after it (the reply ended on `---`)
    // is still a rule.
    const lines = tail.split("\n");
    const cut = lines.findIndex((l) => RULE_LINE.test(l));
    const kept = cut === -1 ? tail : lines.slice(0, cut).join("\n");
    const text = cleanForSpeech(kept);
    return text || null;
  }

  /** Forget everything, including a stop. */
  reset(): void {
    this.buf = "";
    this.stopped = false;
  }

  /** True once a rule has been seen for this reply. */
  get stoppedAtRule(): boolean {
    return this.stopped;
  }

  /**
   * The offset of the first complete rule line, or null. A rule line is only
   * complete once its newline has arrived: `---` at the end of the buffer may
   * still become `----` or `--- not a rule`, so it waits for `flush`.
   */
  private findRule(): number | null {
    let start = 0;
    for (;;) {
      const nl = this.buf.indexOf("\n", start);
      if (nl === -1) return null;
      const line = this.buf.slice(start, nl);
      if (RULE_LINE.test(line)) return start;
      start = nl + 1;
    }
  }
}
