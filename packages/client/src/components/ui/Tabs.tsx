import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { Badge } from "./Chip.js";
import { Tooltip } from "./Tooltip.js";

export interface TabDef {
  id: string;
  label: string;
  icon?: ReactNode;
  count?: number;
  /**
   * Overrides the collapsed tooltip's whole text. For a badge that sums two
   * different things (Apps counts running sub-apps AND orphaned ports), the
   * default `label · count` can't say which is which.
   */
  tip?: string;
}

export interface TabsProps {
  tabs: TabDef[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
  /**
   * Collapse each tab to its icon, with the label moved into a tooltip. Use when
   * the strip has to live in a fixed-width column that the labels have outgrown —
   * five labelled tabs need ~400px, and the right panel is 360px, so they were
   * being cut off. Icons fit ~8 in the same space.
   *
   * Requires every tab to have an `icon`; a tab without one keeps its label so it
   * degrades to something readable instead of an empty square.
   */
  iconOnly?: boolean;
}

/** A dense, underline-free segmented tab strip (Zed-style). */
export function Tabs({ tabs, value, onChange, className, iconOnly }: TabsProps) {
  return (
    <div role="tablist" className={cn("flex items-center gap-0.5 px-1", className)}>
      {tabs.map((t) => {
        const active = t.id === value;
        const collapsed = Boolean(iconOnly && t.icon);
        const count = t.count ?? 0;

        const button = (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            // Collapsed tabs have no visible text, and the tooltip lives in a
            // portal this button isn't associated with — so name it explicitly.
            {...(collapsed ? { "aria-label": t.label } : {})}
            onClick={() => onChange(t.id)}
            className={cn(
              "group relative inline-flex h-9 items-center rounded-none text-[12px] font-medium " +
                "transition-colors duration-150 ease-[var(--ease-out)]",
              collapsed ? "w-9 justify-center" : "gap-1.5 px-2.5",
              active ? "text-primary" : "text-muted hover:text-secondary",
            )}
          >
            {t.icon && <span className="[&_svg]:size-3.5">{t.icon}</span>}
            {!collapsed && t.label}
            {count > 0 &&
              (collapsed ? (
                // Corner badge: inline would defeat the point of collapsing.
                <span className="pointer-events-none absolute right-0.5 top-1">
                  <Badge count={count} tone={active ? "accent" : "warn"} />
                </span>
              ) : (
                <span className="ml-0.5">
                  <Badge count={count} tone={active ? "accent" : "warn"} />
                </span>
              ))}
            {active && (
              <span
                className={cn(
                  "absolute -bottom-px h-0.5 rounded-full bg-accent",
                  collapsed ? "inset-x-2" : "inset-x-1.5",
                )}
              />
            )}
          </button>
        );

        return collapsed ? (
          <Tooltip
            key={t.id}
            label={t.tip ?? (count > 0 ? `${t.label} · ${count}` : t.label)}
            side="bottom"
          >
            {button}
          </Tooltip>
        ) : (
          button
        );
      })}
    </div>
  );
}
