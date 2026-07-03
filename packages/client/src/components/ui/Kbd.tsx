import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";

/** A keyboard-key cap for shortcut hints. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-line-strong " +
          "bg-white/[0.04] px-1 text-[10px] font-medium text-muted cm-mono !text-[10px]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
