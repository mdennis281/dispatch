import { useState, type ReactNode } from "react";
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
  /**
   * Name the tabs in a fixed text slot beside the strip: the HOVERED tab's
   * label, falling back to the active one.
   *
   * Collapsing to icons kept the strip reachable but deleted the vocabulary
   * with it — the word "Terminals" stopped appearing anywhere in the app, and
   * the repo's own author didn't know some of these panels existed. Per-tab
   * tooltips were already there and hadn't fixed it: a tooltip costs a hover
   * PLUS a dwell delay, per tab, so nobody pays it five times.
   *
   * A slot that tracks hover names the whole strip in one sweep of the mouse
   * and reads at a fixed spot, and — unlike labelling the active tab inline —
   * it costs no layout: nothing to its left or right moves when the text
   * changes, so the icon you were aiming at stays where it was. Budget: the
   * five collapsed tabs are 196px (8px padding + 5×36px + 4×2px gap) inside a
   * 360px column, so the ~60px the longest label needs is already paid for.
   */
  labelSlot?: boolean;
}

/** A dense, underline-free segmented tab strip (Zed-style). */
export function Tabs({ tabs, value, onChange, className, iconOnly, labelSlot }: TabsProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const named = tabs.find((t) => t.id === hovered) ?? tabs.find((t) => t.id === value);

  const strip = (
    <div
      role="tablist"
      className={cn("flex shrink-0 items-center gap-0.5 px-1", className)}
      onMouseLeave={() => setHovered(null)}
    >
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
            onMouseEnter={() => setHovered(t.id)}
            onFocus={() => setHovered(t.id)}
            onBlur={() => setHovered(null)}
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

        // With a label slot the plain tooltip is the same word twice on the same
        // hover, so keep a tooltip only where it still says something the slot
        // can't — i.e. an explicit `tip` breaking a summed badge down.
        const tooltip = labelSlot
          ? t.tip
          : (t.tip ?? (count > 0 ? `${t.label} · ${count}` : t.label));

        return collapsed && tooltip ? (
          <Tooltip key={t.id} label={tooltip} side="bottom">
            {button}
          </Tooltip>
        ) : (
          button
        );
      })}
    </div>
  );

  if (!labelSlot) return strip;

  return (
    <div className="flex min-w-0 items-center">
      {strip}
      {/* aria-hidden: every collapsed tab already carries the same string as its
          accessible name, so announcing it again would just double up. */}
      <span
        aria-hidden
        className="min-w-0 truncate pl-1.5 text-[12px] font-medium text-secondary transition-colors duration-150"
      >
        {named?.label}
      </span>
    </div>
  );
}
