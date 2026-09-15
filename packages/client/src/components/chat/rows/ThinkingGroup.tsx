import { memo, useState } from "react";
import { Brain, ChevronDown, RotateCcw, SlidersHorizontal } from "lucide-react";
import type { AssistantMessageRow } from "@dispatch/shared";
import { RowShell } from "./RowShell.js";
import { Button } from "../../ui/Button.js";
import { IconButton } from "../../ui/IconButton.js";
import { Tooltip } from "../../ui/Tooltip.js";
import { cn } from "../../../lib/cn.js";
import { clock } from "../../../lib/format.js";
import { actions } from "../../../lib/actions.js";
import { useHasCheckpoint } from "../../../stores/checkpoints.js";
import { SHELL_FILTER_OPTIONS, useShellFilter } from "../../../lib/shellFilter.js";
import { ShellFilterModal } from "../ShellFilterModal.js";

/**
 * One thought in the stack. A component of its own only because a thought can
 * be a rollback anchor (a thinking-only row is still an assistant message the
 * server may have checkpointed), and that is a per-row store subscription.
 */
function Thought({
  row,
  first,
  stacked,
}: {
  row: AssistantMessageRow;
  first: boolean;
  /** Part of a multi-thought stack, so each thought carries its own clock. */
  stacked: boolean;
}) {
  const canRollback = useHasCheckpoint(row.chatId, row.id);
  return (
    <div
      // A thinking-only row owns its id here; a row that also spoke keeps the
      // id on its text, which is where find-in-transcript should land.
      data-row-id={row.text.trim() ? undefined : row.id}
      className={cn("group/thought relative px-3 py-2", !first && "border-t border-line-soft/70")}
    >
      <p className="whitespace-pre-wrap text-sm italic leading-[1.55] text-muted">{row.thinking}</p>
      <div className={cn("flex items-center justify-end gap-1.5", (stacked || canRollback) && "mt-1")}>
        {canRollback && (
          <span className="opacity-0 transition-opacity focus-within:opacity-100 group-hover/thought:opacity-100">
            <Tooltip label="Roll back here — restores code + thread">
              <Button
                variant="link"
                size="sm"
                leftIcon={<RotateCcw />}
                onClick={() => actions.rollback(row.chatId, row.id)}
                className="!text-2xs text-faint"
              >
                Roll back
              </Button>
            </Tooltip>
          </span>
        )}
        {stacked && <span className="cm-mono !text-2xs text-faint">{clock(row.ts)}</span>}
      </div>
    </div>
  );
}

/**
 * A run of the model's reasoning, as one stacked block.
 *
 * Deliberately NOT an assistant message: no name, no avatar, no model chip.
 * Thinking is the agent working, not the agent speaking, and dressing it as
 * speech is what made a tool-heavy turn look like twenty empty replies. It
 * opens expanded — the reasoning is the interesting part of a long stretch of
 * tool calls — and the header folds it; the `thinking` filter category hides
 * the block entirely, with the same chat → project → app layering as the shell.
 */
export const ThinkingGroup = memo(function ThinkingGroup({ rows }: { rows: AssistantMessageRow[] }) {
  const [open, setOpen] = useState(true);
  const [filterOpen, setFilterOpen] = useState(false);
  const chatId = rows[0]?.chatId ?? "";
  const filter = useShellFilter(chatId);
  const hidden = !filter.enabled.includes("thinking");
  const count = rows.length;

  return (
    <>
      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-300 ease-[var(--ease-out)]",
          hidden ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <RowShell
            gutter={
              <span className="flex size-6 items-center justify-center rounded-md bg-inset text-muted ring-1 ring-line [&_svg]:size-3.5">
                <Brain />
              </span>
            }
          >
            <div className="overflow-hidden rounded-md border border-dashed border-line bg-inset/40">
              <div className="flex h-8 items-center gap-2 pl-1 pr-2.5">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={open}
                  onClick={() => setOpen((v) => !v)}
                  leftIcon={<ChevronDown className={cn("transition-transform", !open && "-rotate-90")} />}
                >
                  {count === 1 ? "Thought for a moment" : `Thought ${count} times`}
                </Button>
                {/* A stack dates each thought instead; one clock for a lone thought. */}
                {count === 1 && <span className="cm-mono !text-2xs text-faint">{clock(rows[0]!.ts)}</span>}
                <span className="ml-auto">
                  <IconButton
                    tip={`Transcript visibility · ${filter.enabled.length} of ${SHELL_FILTER_OPTIONS.length} shown`}
                    active={filter.enabled.length < SHELL_FILTER_OPTIONS.length}
                    onClick={() => setFilterOpen(true)}
                  >
                    <SlidersHorizontal />
                  </IconButton>
                </span>
              </div>
              <div
                className={cn(
                  "grid transition-[grid-template-rows] duration-200 ease-[var(--ease-out)]",
                  open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                )}
              >
                <div className="min-h-0 overflow-hidden">
                  <div className="border-t border-line-soft">
                    {rows.map((row, index) => (
                      <Thought key={row.id} row={row} first={index === 0} stacked={count > 1} />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </RowShell>
        </div>
      </div>
      <ShellFilterModal open={filterOpen} onClose={() => setFilterOpen(false)} chatId={chatId} resolved={filter} />
    </>
  );
});
