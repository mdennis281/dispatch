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
}: RowShellProps) {
  const right = align === "right";
  return (
    <div
      className={cn(
        "group/row relative flex gap-3 px-4 py-2",
        right && "flex-row-reverse",
        className,
      )}
    >
      <div className="flex w-7 shrink-0 flex-col items-center pt-0.5">{gutter}</div>
      <div className="min-w-0 flex-1">
        {(who || meta) && (
          <div className={cn("mb-1 flex items-center gap-2", right && "flex-row-reverse")}>
            {who && (
              <span
                className={cn(
                  "text-[12px] font-semibold tracking-tight",
                  tint === "assistant" ? "text-accent-hi" : "text-primary",
                )}
              >
                {who}
              </span>
            )}
            {meta}
            {ts !== undefined && (
              <span className="cm-mono !text-[10px] text-faint">{clock(ts)}</span>
            )}
            {rollback && (
              <span
                className={cn(
                  "opacity-0 transition-opacity group-hover/row:opacity-100",
                  right ? "mr-auto" : "ml-auto",
                )}
              >
                <Tooltip label="Roll back here — restores code + thread">
                  <button
                    onClick={onRollback}
                    className="inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10.5px] text-faint hover:bg-active hover:text-secondary [&_svg]:size-3"
                  >
                    <RotateCcw />
                    Roll back
                  </button>
                </Tooltip>
              </span>
            )}
          </div>
        )}
        <div className={cn("min-w-0", right && "text-right")}>{children}</div>
      </div>
    </div>
  );
}
