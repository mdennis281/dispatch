import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";

/**
 * The selectable list row every Memory section uses — project memories, house
 * rules scopes, Claude memory files. One bare button element for all three (see the
 * raw-button ratchet in `ui/rawButtons.test.ts`): a two-line, full-width row is
 * not a shape `Button` has.
 */
export function MemoryListRow({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md border px-2.5 py-2 text-left transition-colors",
        active
          ? "border-line-strong bg-accent-ghost"
          : "border-transparent hover:border-line hover:bg-panel-2/50",
      )}
    >
      {children}
    </button>
  );
}
