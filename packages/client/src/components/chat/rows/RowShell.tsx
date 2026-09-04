import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "../../../lib/cn.js";
import { clock } from "../../../lib/format.js";
import { Tooltip } from "../../ui/Tooltip.js";

export interface RowShellProps {
  gutter: ReactNode;
  ts?: number;
  who?: string;
  meta?: ReactNode;
  /** Show the hover "roll back here" affordance (assistant/user turns). */
  rollback?: boolean;
  onRollback?: () => void;
  children: ReactNode;
  className?: string;
  tint?: "user" | "assistant" | "plain";
  /** Row orientation: "left" (default) or "right" (avatar + content hug the right). */
  align?: "left" | "right";
  /**
   * This row continues the one directly above it — same speaker, nothing in
   * between. Drops the avatar and the whole header so the pair reads as one
   * message instead of two, and moves the clock + roll-back action into a hover
   * overlay: a continuation must not be the one row you cannot roll back to.
   */
  continued?: boolean;
}

/**
 * The transcript row skeleton: a fixed gutter (avatar/icon) + a content column
 * with a header (who · time) and hover actions (roll back here).
 */
export function RowShell({
  gutter,
  ts,
  who,
  meta,
  rollback,
  onRollback,
  children,
  className,
  tint = "plain",
  align = "left",
  continued = false,
}: RowShellProps) {
  const right = align === "right";
  const rollbackButton = (
    <Tooltip label="Roll back here — restores code + thread">
      <button
        onClick={onRollback}
        className="inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-2xs text-faint hover:bg-active hover:text-secondary [&_svg]:size-3"
      >
        <RotateCcw />
        Roll back
      </button>
    </Tooltip>
  );
  return (
    <div
      className={cn(
        "group/row relative flex gap-3 px-4",
        // The gap a header would have occupied is exactly what makes two
        // messages look like two, so a continuation closes it up top.
        continued ? "pb-2 pt-0" : "py-2",
        right && "flex-row-reverse",
        className,
      )}
    >
      <div className="flex w-7 shrink-0 flex-col items-center pt-0.5">
        {continued ? null : gutter}
      </div>
      {continued && (ts !== undefined || rollback) && (
        <div
          className={cn(
            "absolute top-0 z-10 flex items-center gap-1.5 rounded-[5px] border border-line bg-panel px-1 py-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100",
            right ? "left-4" : "right-4",
          )}
        >
          {ts !== undefined && <span className="cm-mono !text-2xs text-faint">{clock(ts)}</span>}
          {rollback && rollbackButton}
        </div>
      )}
      <div className="min-w-0 flex-1">
        {!continued && (who || meta) && (
          <div className={cn("mb-1 flex items-center gap-2", right && "flex-row-reverse")}>
            {who && (
              <span
                className={cn(
                  "text-sm font-semibold tracking-tight",
                  tint === "assistant" ? "text-accent-hi" : "text-primary",
                )}
              >
                {who}
              </span>
            )}
            {meta}
            {ts !== undefined && (
              <span className="cm-mono !text-2xs text-faint">{clock(ts)}</span>
            )}
            {rollback && (
              <span
                className={cn(
                  "opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100",
                  right ? "mr-auto" : "ml-auto",
                )}
              >
                {rollbackButton}
              </span>
            )}
          </div>
        )}
        <div className={cn("min-w-0", right && "text-right")}>{children}</div>
      </div>
    </div>
  );
}
