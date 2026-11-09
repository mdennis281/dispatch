import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn.js";

/** An elevated, hairline-bordered surface. */
export function Panel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("cm-panel", className)} {...rest} />;
}

/** Uppercase micro-label used to head groups in the sidebar/panels. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "px-2 text-2xs font-semibold uppercase tracking-[0.09em] text-faint",
        className,
      )}
    >
      {children}
    </div>
  );
}
