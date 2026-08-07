/**
 * Chat titles that can carry ONE piece of emphasis, written as markdown bold.
 *
 * A spawned chat's title reads `**MCP server**: testing creating an mcp chat` —
 * the category, then the ask. The category is the part that makes a sidebar of
 * a dozen chats scannable, so it gets the accent colour; the ask is the part you
 * actually read, so it stays plain. Encoding that in the title STRING rather
 * than in a second field is deliberate:
 *
 *   - it survives rename (you can type `**` yourself and get the same treatment
 *     on a hand-named chat),
 *   - it needs no schema migration and no join at render time,
 *   - and every existing title is already valid input, because a title with no
 *     `**` parses to one plain segment.
 *
 * The cost is that every place a title leaves the app has to strip the markers —
 * a webhook push, `document.title`, the rename input, the seed we hand the
 * title-generating model. That's what {@link stripTitleMarks} is for, and it is
 * cheaper than the alternative where only app-spawned chats can be emphasized.
 *
 * Only `**bold**` is recognized. Titles are not a markdown surface and never
 * should be — no italics, no code spans, no links.
 */

/** One run of title text, flagged for whether it takes the accent colour. */
export interface TitleSegment {
  text: string;
  accent: boolean;
}

/** Matches a non-empty `**…**` run that doesn't itself contain `*`. */
const MARK = /\*\*([^*]+)\*\*/g;

/**
 * Split a title into accented and plain runs, in order.
 *
 * Always returns at least one segment for a non-empty title, and never returns
 * empty-text segments, so a renderer can map straight over the result. An
 * unclosed `**` is not a mark — the literal characters survive into the text,
 * which is the right call for a field a human types into.
 */
export function parseTitleMarks(title: string): TitleSegment[] {
  const out: TitleSegment[] = [];
  let last = 0;
  for (const m of title.matchAll(MARK)) {
    const start = m.index;
    if (start > last) out.push({ text: title.slice(last, start), accent: false });
    out.push({ text: m[1]!, accent: true });
    last = start + m[0].length;
  }
  if (last < title.length) out.push({ text: title.slice(last), accent: false });
  return out;
}

/** The title as plain text — for anything that isn't rendering segments. */
export function stripTitleMarks(title: string): string {
  return title.replace(MARK, "$1");
}

/** True when the title carries at least one mark. */
export function hasTitleMarks(title: string): boolean {
  MARK.lastIndex = 0;
  return MARK.test(title);
}

/**
 * The leading `**prefix**: ` of a title, if it has one.
 *
 * Regenerating a title must not lose the category — the model is asked for a
 * name for the WORK, and prepending the prefix back is how "MCP server" survives
 * a regenerate. Only a mark at the very start followed by `:` counts; emphasis
 * anywhere else is just emphasis.
 */
export function titlePrefixOf(title: string): string | null {
  const m = /^\*\*([^*]+)\*\*\s*:\s*/.exec(title);
  return m ? m[1]! : null;
}

/** `**prefix**: rest` — the canonical shape a spawned chat's title takes. */
export function withTitlePrefix(prefix: string, rest: string): string {
  const body = stripTitleMarks(rest).trim();
  const p = stripTitleMarks(prefix).trim();
  if (!p) return body;
  return body ? `**${p}**: ${body}` : `**${p}**`;
}
