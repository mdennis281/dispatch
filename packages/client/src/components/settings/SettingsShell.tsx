/**
 * SettingsShell — the page layout both settings surfaces are built out of.
 *
 * Both of these used to be `Modal`s, and both had outgrown one. Project config
 * was an 880px box with a fixed 168px rail and no `sm` fallback, so on a phone
 * the rail and the detail pane fought over ~340px and neither won. App settings
 * was a 480px single column that had grown to seven unrelated concerns stacked
 * end to end — theme, auth, model defaults, token limits, webhooks, updates,
 * and a button that stops the server — with no way to jump to one.
 *
 * So: a page with a section rail, and one behaviour that changes with width.
 *
 *   - `md`/`lg` — rail and detail side by side, the way the modal wanted to be.
 *   - `sm` — a DRILL-DOWN. You land on the rail as a full-width index, tap a
 *     section, and the detail replaces it with a back button. This is the
 *     native settings idiom on a phone, and it's the only one that gives each
 *     subpage the whole screen. A rail squeezed beside a detail pane at 390px
 *     gives you two things you can't read instead of one you can.
 *
 * The shell owns the drill-down state and NOTHING else. Which section is
 * selected lives in the view store (see stores/view), so the command palette can
 * address a subpage directly and the choice survives a trip to a chat and back.
 */
import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, type LucideIcon } from "lucide-react";
import { Chip } from "../ui/Chip.js";
import { IconButton } from "../ui/IconButton.js";
import { ScrollArea } from "../ui/ScrollArea.js";
import { useLayoutMode } from "../../stores/layout.js";
import { cn } from "../../lib/cn.js";

export interface ShellSection<Id extends string> {
  id: Id;
  icon: LucideIcon;
  label: string;
  /** One line, under the label on the index and in the rail tooltip. */
  blurb: string;
  /** Right-aligned tally. `null`/omitted for sections that aren't a list. */
  count?: number | null;
  /** Shows the unsaved-changes dot on this section's rail row. */
  dirty?: boolean;
}

export function SettingsShell<Id extends string>({
  icon,
  title,
  subtitle,
  sections,
  active,
  onSelect,
  actions,
  indexFooter,
  footer,
  children,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  sections: ShellSection<Id>[];
  active: Id;
  onSelect: (id: Id) => void;
  /** Header-right controls, shown on every subpage. */
  actions?: ReactNode;
  /** Page-level actions, parked under the rail rather than in the header — at
   *  `sm` the rail IS the index page, which is exactly where they belong. */
  indexFooter?: ReactNode;
  /** Sticky bottom bar. Render nothing here when there's nothing to say. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const compact = useLayoutMode() === "sm";
  // Only consulted at `sm`. You arrive on the index, because arriving on
  // whichever subpage you last opened hides the fact that there are others.
  const [showIndex, setShowIndex] = useState(true);
  // Coming back from a wide layout, the index is the honest starting point
  // again — the detail you were on was reached from a rail that no longer exists.
  useEffect(() => {
    if (compact) setShowIndex(true);
  }, [compact]);

  const activeSection = sections.find((s) => s.id === active) ?? sections[0];
  const showRail = !compact || showIndex;
  const showDetail = !compact || !showIndex;

  const rail = (
    <nav
      className={cn(
        "flex shrink-0 flex-col",
        compact ? "w-full" : "w-[212px] border-r border-line bg-surface",
      )}
      aria-label={`${title} sections`}
    >
      <ScrollArea className="min-h-0 flex-1 p-2">
        <div className="space-y-0.5">
          {sections.map((s) => {
            const Icon = s.icon;
            const selected = !compact && s.id === active;
            return (
              <button
                key={s.id}
                type="button"
                title={s.blurb}
                onClick={() => {
                  onSelect(s.id);
                  setShowIndex(false);
                }}
                className={cn(
                  // 44px minimum on the index, where these are thumb targets.
                  "flex w-full items-center gap-2.5 rounded-md px-2.5 text-left transition-colors [&_svg]:size-4",
                  compact ? "min-h-11 py-2" : "py-1.5",
                  selected
                    ? "bg-accent-ghost text-accent"
                    : "text-secondary hover:bg-panel-2 hover:text-primary",
                )}
              >
                <Icon className={cn("shrink-0", selected ? "text-accent" : "text-muted")} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{s.label}</span>
                  {/* The blurb only earns its line on the index, where the row
                      is the whole screen wide and there's nothing beside it to
                      explain what the label means. */}
                  {compact && (
                    <span className="block truncate text-2xs text-faint">{s.blurb}</span>
                  )}
                </span>
                {s.count != null && (
                  <Chip tone={s.count ? "accent" : "muted"} mono>
                    {s.count}
                  </Chip>
                )}
                {s.dirty && <span className="size-1.5 shrink-0 rounded-full bg-warn" />}
              </button>
            );
          })}
        </div>
        {indexFooter && (
          <div className="mt-3 border-t border-line-soft pt-3">{indexFooter}</div>
        )}
      </ScrollArea>
    </nav>
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      {/* toolbar — same 48px band as the Git and Memory views */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        {compact && !showIndex ? (
          <>
            <IconButton size="sm" tip="All sections" onClick={() => setShowIndex(true)}>
              <ChevronLeft />
            </IconButton>
            <span className="min-w-0 flex-1 truncate text-base font-semibold text-primary">
              {activeSection?.label ?? title}
            </span>
          </>
        ) : (
          <>
            <span className="shrink-0 text-muted [&_svg]:size-4">{icon}</span>
            <span className="min-w-0 truncate text-base font-semibold text-primary">
              {title}
            </span>
            {subtitle && (
              <span className="hidden min-w-0 truncate text-xs text-faint md:block">
                {subtitle}
              </span>
            )}
          </>
        )}
        {actions && <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>

      <div className="flex min-h-0 flex-1">
        {showRail && rail}
        {showDetail && (
          <ScrollArea className="min-h-0 min-w-0 flex-1">
            <div className="mx-auto max-w-3xl p-4">{children}</div>
          </ScrollArea>
        )}
      </div>

      {/* Sticky, not floating: it is the app column's last row, so the space it
          takes and the space it's given are the same measurement. */}
      {footer && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-surface px-3 py-2">
          {footer}
        </div>
      )}
    </div>
  );
}
