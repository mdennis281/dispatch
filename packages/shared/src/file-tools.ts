/**
 * FILE-TOOL STATS — the numbers a file row shows without being expanded.
 *
 * A transcript is mostly file work, and "Edit / ok" says nothing about what
 * happened. What a reader actually wants is the git-shaped summary: which file,
 * and `+12 −3`. Producing that means diffing `old_string` against `new_string`
 * (or counting the numbered lines a Read returned) — over payloads the lean
 * projection deliberately drops before they reach the browser.
 *
 * So the arithmetic lives HERE, in shared, and runs on whichever side still has
 * the bytes: the client computes it from a verbatim row, and the server computes
 * it from the full row just before clipping it (see services/transcript-lean.ts)
 * and ships the answer as `fileStat`. Same function, so the two can't disagree.
 */
import * as z from "zod";

/** Tools that create/replace a whole file. */
export const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "NotebookEdit"]);
/** Tools that patch part of a file. */
export const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Update"]);
/** Tools that read a file's contents. */
export const FILE_READ_TOOLS: ReadonlySet<string> = new Set(["Read", "NotebookRead"]);
/** Tools that search across files rather than opening one. */
export const FILE_SEARCH_TOOLS: ReadonlySet<string> = new Set(["Grep", "Glob"]);

export type FileToolAction = "write" | "edit" | "read" | "search";

/** Which flavour of file work a tool does, or null when it does none. */
export function fileToolAction(name: string): FileToolAction | null {
  if (FILE_WRITE_TOOLS.has(name)) return "write";
  if (FILE_EDIT_TOOLS.has(name)) return "edit";
  if (FILE_READ_TOOLS.has(name)) return "read";
  if (FILE_SEARCH_TOOLS.has(name)) return "search";
  return null;
}

/**
 * The pre-computed summary a file row renders. Every field is optional because
 * one shape serves four tools: writes/edits fill `added`/`removed`, reads fill
 * the line range, searches fill `count`.
 */
export const FileToolStatSchema = z.object({
  /** Lines this call introduced. */
  added: z.number().int().optional(),
  /** Lines this call removed. */
  removed: z.number().int().optional(),
  /** 1-based first line a read returned. */
  startLine: z.number().int().optional(),
  /** 1-based last line a read returned (inclusive). */
  endLine: z.number().int().optional(),
  /** How many lines a read returned. */
  lines: z.number().int().optional(),
  /** How many hits a search returned. */
  count: z.number().int().optional(),
});
export type FileToolStat = z.infer<typeof FileToolStatSchema>;

/* --------------------------------------------------------------- line diff */

/** Split into lines, discarding the empty tail a trailing newline produces. */
function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Past this many lines on either side we report raw counts instead of a real
 * diff. The LCS below is O(n·m); an edit body that large is a rewrite anyway, so
 * the exact overlap is not worth a million comparisons per transcript row.
 */
const DIFF_LINE_CAP = 600;

/** Added/removed line counts, matching what `git diff --numstat` would report. */
function lineDiff(before: readonly string[], after: readonly string[]): FileToolStat {
  // Trimming the shared head and tail first is what keeps the LCS small: a real
  // Edit is a few changed lines wrapped in identical context on both sides.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const b = before.slice(start, endBefore);
  const a = after.slice(start, endAfter);
  if (!b.length || !a.length || b.length > DIFF_LINE_CAP || a.length > DIFF_LINE_CAP) {
    return { added: a.length, removed: b.length };
  }

  // Longest common subsequence length over two rolling rows.
  let prev = new Array<number>(a.length + 1).fill(0);
  for (let i = 1; i <= b.length; i++) {
    const cur = new Array<number>(a.length + 1).fill(0);
    for (let j = 1; j <= a.length; j++) {
      cur[j] = b[i - 1] === a[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    prev = cur;
  }
  const common = prev[a.length]!;
  return { added: a.length - common, removed: b.length - common };
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

/* ------------------------------------------------------------ input stats */

/**
 * The `+added −removed` summary for one write/edit call, from its verbatim
 * input. Returns null when the input carries nothing to count — including a
 * lean row whose bodies were already clipped away.
 */
export function fileEditStat(name: string, input: Record<string, unknown>): FileToolStat | null {
  const action = fileToolAction(name);

  if (action === "write") {
    // A Write states the new contents and nothing about what it replaced, so
    // there is no honest removal count — reporting 0 is the truthful reading of
    // "this call added these lines", not a claim the file was empty before.
    const content = str(input, "content") ?? str(input, "new_source");
    if (content === undefined) return null;
    if (str(input, "edit_mode") === "delete") return { removed: splitLines(content).length };
    return { added: splitLines(content).length };
  }

  if (action !== "edit") return null;

  const edits = input.edits;
  if (Array.isArray(edits)) {
    let added = 0;
    let removed = 0;
    let counted = false;
    for (const edit of edits) {
      if (!edit || typeof edit !== "object") continue;
      const one = edit as Record<string, unknown>;
      const before = str(one, "old_string");
      const after = str(one, "new_string");
      if (before === undefined && after === undefined) continue;
      const stat = lineDiff(splitLines(before ?? ""), splitLines(after ?? ""));
      added += stat.added ?? 0;
      removed += stat.removed ?? 0;
      counted = true;
    }
    return counted ? { added, removed } : null;
  }

  const before = str(input, "old_string");
  const after = str(input, "new_string");
  if (before === undefined && after === undefined) return null;
  const stat = lineDiff(splitLines(before ?? ""), splitLines(after ?? ""));
  // `replace_all` applies the same patch at every occurrence, so one match's
  // counts undersell it. We do not know the occurrence count without the file.
  return stat;
}

/* ----------------------------------------------------------- result stats */

/** A `cat -n`-style numbered output line: leading spaces, the number, a tab. */
const NUMBERED_LINE = /^\s*(\d+)\t/;

/**
 * The line range a read actually returned, or the hit count a search found,
 * from its verbatim result text.
 */
export function fileResultStat(name: string, text: string): FileToolStat | null {
  const action = fileToolAction(name);
  if (action === "read") {
    let startLine: number | undefined;
    let endLine: number | undefined;
    let lines = 0;
    for (const line of text.split(/\r?\n/)) {
      const match = NUMBERED_LINE.exec(line);
      if (!match) continue;
      const n = Number(match[1]);
      if (!Number.isFinite(n)) continue;
      if (startLine === undefined) startLine = n;
      endLine = n;
      lines++;
    }
    // An unnumbered read (an image, a notebook, a provider that formats its own
    // output) still has a useful size — just not a range to jump to.
    if (!lines) {
      const plain = text.split(/\r?\n/).filter((line) => line.trim()).length;
      return plain ? { lines: plain } : null;
    }
    return { startLine, endLine, lines };
  }

  if (action !== "search") return null;
  if (/^\s*No (?:files|matches|results)\b/i.test(text)) return { count: 0 };
  // Grep prefixes its listing with its own tally. Trust that over counting rows,
  // which would be off by the header and by any "(results truncated)" footer.
  const tally = /^\s*Found (\d+) /i.exec(text);
  if (tally) return { count: Number(tally[1]) };
  const hits = text.split(/\r?\n/).filter((line) => line.trim()).length;
  return { count: hits };
}
