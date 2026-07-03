import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { Badge } from "./Chip.js";

export interface TabDef {
  id: string;
  label: string;
  icon?: ReactNode;
  count?: number;
}

export interface TabsProps {
  tabs: TabDef[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
}

/** A dense, underline-free segmented tab strip (Zed-style). */
export function Tabs({ tabs, value, onChange, className }: TabsProps) {
  return (
    <div
      role="tablist"
      className={cn("flex items-center gap-0.5 px-1", className)}
    >
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={cn(
              "group relative inline-flex h-9 items-center gap-1.5 rounded-none px-2.5 text-[12px] font-medium " +
                "transition-colors duration-150 ease-[var(--ease-out)]",
              active ? "text-primary" : "text-muted hover:text-secondary",
            )}
          >
            {t.icon && <span className="[&_svg]:size-3.5">{t.icon}</span>}
            {t.label}
            {t.count !== undefined && t.count > 0 && (
              <span className="ml-0.5">
                <Badge count={t.count} tone={active ? "accent" : "warn"} />
              </span>
            )}
            {active && (
              <span className="absolute inset-x-1.5 -bottom-px h-0.5 rounded-full bg-accent" />
            )}
          </button>
        );
      })}
    </div>
  );
}
