/**
 * Derive the CURRENT todo list for a chat from its transcript.
 *
 * The agent surfaces its plan as `tool_use` rows (see docs/agent-sdk-notes.md):
 *  - `TodoWrite` carries the WHOLE list each call (`input.todos`) and REPLACES it.
 *  - `TaskCreate` / `TaskUpdate` are the incremental variants (append / patch-by-id).
 *
 * We fold every todo-tool row in transcript order, so the last snapshot wins and
 * any trailing incremental edits apply on top. No backend change is needed: the
 * broker already forwards each tool_use with its full `input` as a `ToolUseRow`.
 */
import type { ChatMessage } from "@cm/shared";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  /** Stable-ish key for React lists (explicit id, else positional). */
  key: string;
  /** Imperative description ("Fix the bug"). */
  content: string;
  /** Present-continuous form shown while active ("Fixing the bug"). */
  activeForm?: string;
  status: TodoStatus;
}

export interface TodoSummary {
  todos: Todo[];
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  /** The first in-progress todo (what the agent is doing right now), if any. */
  active?: Todo;
  /** Every todo is completed (and there is at least one). */
  allDone: boolean;
}

/** Tool names that mutate the todo list. */
const TODO_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);

const EMPTY: TodoSummary = {
  todos: [],
  total: 0,
  completed: 0,
  inProgress: 0,
  pending: 0,
  allDone: false,
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Coerce any status-ish value into one of the three canonical states. */
function normStatus(v: unknown): TodoStatus {
  const s = typeof v === "string" ? v.toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (s === "in_progress" || s === "active" || s === "doing" || s === "started") {
    return "in_progress";
  }
  if (s === "completed" || s === "complete" || s === "done" || s === "finished") {
    return "completed";
  }
  return "pending";
}

interface Raw {
  id?: string;
  content: string;
  activeForm?: string;
  status: TodoStatus;
}

/** A partial patch (TaskUpdate) — every field optional, no content requirement. */
interface RawPatch {
  id?: string;
  content?: string;
  activeForm?: string;
  status?: TodoStatus;
}

/** Probe the common per-item shapes (`content` | `text` | `title` | …). */
function toRaw(item: unknown): Raw | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const content =
    str(o.content) ?? str(o.text) ?? str(o.title) ?? str(o.task) ?? str(o.description);
  if (!content) return null;
  return {
    id: str(o.id) ?? str(o.taskId),
    content,
    activeForm: str(o.activeForm) ?? str(o.active_form),
    status: normStatus(o.status),
  };
}

/**
 * Probe a TaskUpdate patch: only the fields actually present are carried, so a
 * status-only flip (`{ id, status:"completed" }`) survives instead of being
 * dropped by the content-gated {@link toRaw}. Returns null when there's nothing
 * to apply.
 */
function toPatch(item: unknown): RawPatch | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const patch: RawPatch = {
    id: str(o.id) ?? str(o.taskId),
    content: str(o.content) ?? str(o.text) ?? str(o.title) ?? str(o.task) ?? str(o.description),
    activeForm: str(o.activeForm) ?? str(o.active_form),
    status: o.status !== undefined ? normStatus(o.status) : undefined,
  };
  if (
    patch.id === undefined &&
    patch.content === undefined &&
    patch.activeForm === undefined &&
    patch.status === undefined
  ) {
    return null;
  }
  return patch;
}

/**
 * Fold the transcript into the current todo list. Pure + cheap so it can run in
 * a `useMemo` on every new message without touching the store or the network.
 */
export function deriveTodos(messages: ChatMessage[]): TodoSummary {
  const order: Raw[] = [];
  const byId = new Map<string, number>();

  const reset = () => {
    order.length = 0;
    byId.clear();
  };

  // Patch-by-id when the id is known, otherwise append. A re-put that omits a
  // field (e.g. no activeForm) must NOT wipe the existing value, so merge only
  // the fields this row actually carries.
  const put = (r: Raw) => {
    if (r.id !== undefined && byId.has(r.id)) {
      const i = byId.get(r.id)!;
      const prev = order[i]!;
      order[i] = {
        id: prev.id,
        content: r.content,
        activeForm: r.activeForm ?? prev.activeForm,
        status: r.status,
      };
      return;
    }
    if (r.id !== undefined) byId.set(r.id, order.length);
    order.push(r);
  };

  // Apply a TaskUpdate patch: merge only the present fields onto a known id (so a
  // status-only flip completes the task); a patch with an unknown id + content
  // creates the row, otherwise it's a no-op.
  const applyPatch = (p: RawPatch) => {
    if (p.id !== undefined && byId.has(p.id)) {
      const i = byId.get(p.id)!;
      const prev = order[i]!;
      order[i] = {
        id: prev.id,
        content: p.content ?? prev.content,
        activeForm: p.activeForm ?? prev.activeForm,
        status: p.status ?? prev.status,
      };
      return;
    }
    if (p.content === undefined) return; // can't create a contentless row
    put({ id: p.id, content: p.content, activeForm: p.activeForm, status: p.status ?? "pending" });
  };

  let sawAny = false;
  for (const row of messages) {
    // Only fold the TOP-LEVEL agent's todo tools. A Task-subagent's TodoWrite
    // (parentToolUseId set) would otherwise reset() and clobber the main strip.
    if (
      row.kind !== "tool_use" ||
      row.parentToolUseId != null ||
      !TODO_TOOLS.has(row.name)
    ) {
      continue;
    }
    const input = (row.input ?? {}) as Record<string, unknown>;
    if (row.name === "TodoWrite") {
      const arr = Array.isArray(input.todos)
        ? input.todos
        : Array.isArray(input.tasks)
          ? input.tasks
          : [];
      reset();
      sawAny = true;
      for (const it of arr) {
        const r = toRaw(it);
        if (r) put(r);
      }
    } else if (row.name === "TaskCreate") {
      const items = Array.isArray(input.tasks) ? input.tasks : [input];
      for (const it of items) {
        const r = toRaw(it);
        if (r) {
          sawAny = true;
          put(r);
        }
      }
    } else if (row.name === "TaskUpdate") {
      const items = Array.isArray(input.tasks) ? input.tasks : [input];
      for (const it of items) {
        const p = toPatch(it);
        if (p) {
          sawAny = true;
          applyPatch(p);
        }
      }
    }
  }

  if (!sawAny) return EMPTY;

  const todos: Todo[] = order.map((r, i) => ({
    key: r.id ?? `t${i}`,
    content: r.content,
    activeForm: r.activeForm,
    status: r.status,
  }));

  let completed = 0;
  let inProgress = 0;
  let pending = 0;
  let active: Todo | undefined;
  for (const t of todos) {
    if (t.status === "completed") completed += 1;
    else if (t.status === "in_progress") {
      inProgress += 1;
      if (!active) active = t;
    } else pending += 1;
  }

  return {
    todos,
    total: todos.length,
    completed,
    inProgress,
    pending,
    active,
    allDone: todos.length > 0 && completed === todos.length,
  };
}
