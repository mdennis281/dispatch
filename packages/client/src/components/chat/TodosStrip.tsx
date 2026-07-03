import { useMemo, useState } from "react";
import { ListChecks, Circle, CircleCheck, ChevronDown } from "lucide-react";
import type { ChatMessage } from "@cm/shared";
import { Spinner } from "../ui/Spinner.js";
import { cn } from "../../lib/cn.js";
import { deriveTodos, type Todo } from "./todos.js";

/** Per-todo leading glyph: pending ring · live spinner · done check. */
function TodoIcon({ status }: { status: Todo["status"] }) {
  if (status === "completed") {
    return <CircleCheck className="size-3.5 shrink-0 text-success" />;
  }
  if (status === "in_progress") {
    return <Spinner size={13} className="shrink-0" />;
  }
  return <Circle className="size-3.5 shrink-0 text-faint" />;
}

function TodoRow({ todo }: { todo: Todo }) {
  const label =
    todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content;
  return (
    <li className="flex items-start gap-2 py-[3px]">
      <span className="mt-px">
        <TodoIcon status={todo.status} />
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 text-[12px] leading-snug",
          todo.status === "completed" && "text-muted line-through decoration-line-strong",
          todo.status === "in_progress" && "font-medium text-primary",
          todo.status === "pending" && "text-secondary",
        )}
      >
        {label}
      </span>
    </li>
  );
}

/**
 * A compact, collapsible "Tasks" strip for the chat header area. Renders the
 * agent's live todo list (derived from TodoWrite/TaskCreate/TaskUpdate tool_use
 * rows) and updates in place as new rows stream in. Renders nothing until the
 * agent writes a first todo.
 */
export function TodosStrip({ messages }: { messages: ChatMessage[] }) {
  const summary = useMemo(() => deriveTodos(messages), [messages]);
  const [open, setOpen] = useState(true);

  if (summary.total === 0) return null;

  const { todos, total, completed, active, allDone } = summary;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="shrink-0 border-b border-line bg-surface/70">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors hover:bg-white/[0.02]"
      >
        <ListChecks
          className={cn("size-3.5 shrink-0", allDone ? "text-success" : "text-accent-hi")}
        />
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-secondary">
          Tasks
        </span>
        <span className="shrink-0 cm-mono !text-[10px] tabular-nums text-faint">
          {completed}/{total}
        </span>
        <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-line">
          <span
            className={cn(
              "block h-full rounded-full transition-[width] duration-300",
              allDone ? "bg-success" : "bg-accent",
            )}
            style={{ width: `${pct}%` }}
          />
        </span>
        {/* Collapsed → surface what the agent is doing right now (or "all done"). */}
        {!open && active && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-accent-hi">
            {active.activeForm ?? active.content}
          </span>
        )}
        {!open && !active && allDone && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-success">All tasks done</span>
        )}
        <ChevronDown
          className={cn(
            "ml-auto size-3.5 shrink-0 text-faint transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <ul className="cm-anim-rise cm-scroll max-h-44 overflow-auto px-4 pb-2 pt-0.5">
          {todos.map((t) => (
            <TodoRow key={t.key} todo={t} />
          ))}
        </ul>
      )}
    </div>
  );
}
