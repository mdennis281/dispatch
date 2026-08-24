/**
 * The composer's `/` command menu.
 *
 * Opens when the message so far is JUST a slash token — `/`, `/rev`, `/gsd-p` —
 * and closes the moment it stops being one. That is a deliberately narrow
 * trigger: a slash command has to be the whole start of a message for the
 * runtime to expand it, so offering the menu mid-sentence would be offering
 * something that doesn't work. Typing a space commits the name and dismisses the
 * list, which is also how you get to the arguments.
 *
 * Rendered as a plain positioned panel rather than a `Popover` because the
 * anchor is a caret inside a contenteditable, not a button: a Popover traps
 * focus, and the whole point here is that focus never leaves the editor while
 * you arrow through the list.
 */
import { useEffect, useRef } from "react";
import type { SlashCommandInfo, SlashCommandSource } from "@dispatch/shared";
import { cn } from "../../lib/cn.js";

/** Short provenance label. `repo` and `builtin` are the two nobody can edit here. */
const SOURCE_LABEL: Record<SlashCommandSource, string> = {
  project: "project",
  global: "global",
  shipped: "dispatch",
  repo: "repo",
  builtin: "built-in",
};

export interface SlashMenuProps {
  commands: SlashCommandInfo[];
  /** Index of the highlighted row (owned by the composer, which drives the keys). */
  active: number;
  onHover: (index: number) => void;
  onPick: (command: SlashCommandInfo) => void;
  /**
   * False when no live session has ever reported the runtime's built-ins, so the
   * list holds skills only. Said out loud — a menu missing `/compact` looks
   * broken, and "send a message first" is a fixable explanation.
   */
  builtinsKnown: boolean;
}

export function SlashMenu({
  commands,
  active,
  onHover,
  onPick,
  builtinsKnown,
}: SlashMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the highlighted row in view as the arrow keys walk past the fold. The
  // keys are handled in the EDITOR, so nothing here ever receives focus and the
  // browser's own scroll-into-view on focus never fires.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!commands.length) return null;

  return (
    <div
      className="absolute bottom-full left-0 z-30 mb-1.5 w-full max-w-[min(28rem,100%)] overflow-hidden rounded-lg border border-line bg-panel shadow-lg"
      role="listbox"
      aria-label="Commands"
    >
      <div ref={listRef} className="cm-scroll max-h-64 overflow-y-auto p-1">
        {commands.map((cmd, i) => (
          <button
            key={`${cmd.source}:${cmd.name}`}
            type="button"
            data-index={i}
            role="option"
            aria-selected={i === active}
            // `onMouseDown` with preventDefault, not `onClick`: a click would
            // first blur the editor, and re-focusing it afterwards puts the
            // caret back at position 0 — so the inserted command lands behind
            // the text it was meant to replace.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(cmd);
            }}
            onMouseEnter={() => onHover(i)}
            className={cn(
              "flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left",
              i === active ? "bg-elevated" : "hover:bg-elevated/60",
            )}
          >
            <span className="cm-mono shrink-0 text-xs text-primary">/{cmd.name}</span>
            {cmd.argumentHint && (
              <span className="cm-mono shrink-0 text-2xs text-faint">{cmd.argumentHint}</span>
            )}
            {cmd.description && (
              <span className="min-w-0 flex-1 truncate text-xs text-muted">
                {cmd.description}
              </span>
            )}
            <span className="ml-auto shrink-0 pl-2 text-2xs text-faint">
              {SOURCE_LABEL[cmd.source]}
            </span>
          </button>
        ))}
      </div>
      {!builtinsKnown && (
        <div className="border-t border-line-soft px-2.5 py-1.5 text-2xs text-faint">
          Built-in commands appear once this chat has run a turn.
        </div>
      )}
    </div>
  );
}
