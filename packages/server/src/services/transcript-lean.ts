/**
 * LEAN TRANSCRIPT PROJECTION — the wire shape for a chat's message history.
 *
 * A long chat's `messages.jsonl` is dominated by payloads the transcript does not
 * actually render: `tool_use.input` and `tool_result.content` are ~83% of a 9.5 MB
 * transcript, yet every ToolCallCard mounts COLLAPSED (only its name, one-line
 * command preview, duration and ok/failed chip are visible). Shipping those bytes
 * to draw a one-line header is what made opening a big chat slow.
 *
 * So `GET /api/chats/:id/messages` returns rows projected through {@link leanRow}:
 * everything the collapsed card renders is kept verbatim, the bulk is clipped to a
 * preview, and the row is flagged (`inputOmitted` / `contentOmitted`). Expanding a
 * card fetches the real row from `GET /api/chats/:id/messages/full?ids=`.
 *
 * Rules of the projection:
 *   - Small payloads pass through UNTOUCHED (no flag, nothing to hydrate) — the
 *     common case, so most cards still expand instantly with zero extra request.
 *   - Todo tools (TodoWrite/TaskCreate/TaskUpdate) keep their FULL input at any
 *     size: the client derives the live Tasks strip from it (see chat/todos.ts),
 *     so clipping it would silently break task tracking.
 *   - Everything the client reads off a collapsed row is whitelisted below. Adding
 *     a new field to a collapsed card means adding its key here.
 */
import { fileEditStat, fileResultStat, type ChatMessage } from "@dispatch/shared";

/** Inputs at or under this serialized size ship verbatim (no hydrate needed). */
const INPUT_INLINE_LIMIT = 4_096;
/** Tool results at or under this serialized size ship verbatim. */
const RESULT_INLINE_LIMIT = 2_048;
/** How much of a clipped tool result to keep as a readable head preview. */
const RESULT_PREVIEW_CHARS = 1_500;
/** How much of a clipped string input value to keep. */
const INPUT_STRING_PREVIEW_CHARS = 512;

/**
 * `tool_use.input` keys the client reads WITHOUT expanding the card. Keep this in
 * sync with: ToolCallCard (`command`), monaco/store.ts `toolFilePath`
 * (`file_path`/`filePath`/`notebook_path`/`path`), and SubagentCard
 * (`subagent_type`/`description`/`prompt`).
 */
const DISPLAY_INPUT_KEYS = [
  "command",
  "file_path",
  "filePath",
  "notebook_path",
  "path",
  "subagent_type",
  "description",
  "prompt",
  "pattern",
  "query",
  "url",
  // File rows: the read range a Read asked for (the fallback when its result
  // carries no line numbers) and the search scope a Grep/Glob narrowed to.
  "offset",
  "limit",
  "glob",
  "output_mode",
  "replace_all",
] as const;

/** Tools whose input drives the Tasks strip — never clipped, at any size. */
const TODO_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);

/** Byte size of a value's JSON form (0 when it isn't serializable). */
function jsonBytes(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 0;
  }
}

/** Clip a string to `max` chars with an ellipsis marker (identity when short). */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Project a large `tool_use.input` to just the keys a collapsed card renders,
 * each clipped. Nested/bulk keys (file contents, edit bodies, MCP blobs) drop out
 * entirely and come back on expand.
 */
function leanInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of DISPLAY_INPUT_KEYS) {
    const v = input[key];
    if (typeof v === "string") out[key] = clip(v, INPUT_STRING_PREVIEW_CHARS);
    else if (typeof v === "number" || typeof v === "boolean") out[key] = v;
  }
  return out;
}

/**
 * A result payload as plain text, for measuring it. Mirrors the client's
 * `resultText` for the two shapes a file tool actually returns; anything else
 * measures as empty, which yields no stat rather than a wrong one.
 */
function resultAsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && "text" in block && typeof block.text === "string"
          ? block.text
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** A readable head preview of a tool result payload of any shape. */
function previewContent(content: unknown): string {
  if (typeof content === "string") return clip(content, RESULT_PREVIEW_CHARS);
  try {
    return clip(JSON.stringify(content, null, 2) ?? "", RESULT_PREVIEW_CHARS);
  } catch {
    return "";
  }
}

/**
 * The wire form of one persisted row: verbatim when it's small, otherwise clipped
 * with the matching `*Omitted` flag set so the client knows to hydrate on expand.
 * Pure — never mutates the input row.
 */
export function leanRow(row: ChatMessage, toolName?: string): ChatMessage {
  switch (row.kind) {
    case "tool_use": {
      // The Tasks strip folds these inputs on every render — keep them whole.
      if (TODO_TOOLS.has(row.name)) return row;
      if (jsonBytes(row.input) <= INPUT_INLINE_LIMIT) return row;
      // The `+n −m` a file row shows is computed FROM the edit bodies we are
      // about to drop, so it has to be taken here or the row loses it until
      // someone expands the card — which is the one thing it must not need.
      const fileStat = fileEditStat(row.name, row.input) ?? undefined;
      return { ...row, input: leanInput(row.input), inputOmitted: true, fileStat };
    }

    case "tool_result": {
      const bytes = jsonBytes(row.content);
      if (bytes <= RESULT_INLINE_LIMIT) return row;
      // Same reason as above: a Read's line range lives in the numbering of the
      // very text the preview truncates. `name` is not persisted on result rows,
      // so it comes from the paired tool_use (see leanRows); when that row is
      // outside this page there is no stat and the client falls back.
      const name = row.name ?? toolName;
      return {
        ...row,
        content: previewContent(row.content),
        contentOmitted: true,
        contentBytes: bytes,
        fileStat: name ? fileResultStat(name, resultAsText(row.content)) ?? undefined : undefined,
      };
    }

    case "system": {
      // Only `data.model` is ever rendered (the "Session started" chip); an init
      // payload carries the whole tool/MCP inventory besides.
      if (jsonBytes(row.data) <= RESULT_INLINE_LIMIT) return row;
      const model = (row.data as { model?: unknown } | undefined)?.model;
      return {
        ...row,
        data: typeof model === "string" ? { model } : undefined,
        dataOmitted: true,
      };
    }

    default:
      // user / assistant / result / permission / notice rows ARE their content —
      // clipping them would change what the transcript says. Windowing bounds them.
      return row;
  }
}

/** Project a page of rows for the wire. */
export function leanRows(rows: ChatMessage[]): ChatMessage[] {
  // Result rows carry no tool name of their own, and a Read's line-range stat is
  // only computable while the full content is still here. Resolve the name from
  // the page's own tool_use rows first so the projection can take it.
  const names = new Map<string, string>();
  for (const row of rows) {
    if (row.kind === "tool_use") names.set(row.toolUseId, row.name);
  }
  return rows.map((row) =>
    leanRow(row, row.kind === "tool_result" ? names.get(row.toolUseId) : undefined),
  );
}
