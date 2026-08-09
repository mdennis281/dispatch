import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn.js";

/** An elevated, hairline-bordered surface. */
export function Panel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("cm-panel", className)} {...rest} />;
}

export interface PanelHeaderProps {
  title: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** A dense section header used inside panels and cards. */
export function PanelHeader({ title, icon, actions, className }: PanelHeaderProps) {
  return (
    <div
      className={cn(
        "flex h-9 shrink-0 items-center gap-2 px-3 cm-hairline-b",
        className,
      )}
    >
      {icon && <span className="text-secondary [&_svg]:size-3.5">{icon}</span>}
      <span className="text-sm font-semibold tracking-tight text-primary">{title}</span>
      {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
    </div>
  );
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
