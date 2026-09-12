import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn.js";
import { LAYER } from "../../lib/layers.js";

/** Gap between trigger and panel, and the margin it keeps from a window edge. */
const GAP = 6;
const MARGIN = 8;

/**
 * How long the panel survives the pointer leaving.
 *
 * There is a hole between the trigger and the panel — the 6px `GAP`, and in the
 * title bar a few more px of strip — and a pointer crossing it fires `leave`
 * before the panel's `enter`. Without the grace period the panel shuts the
 * instant you move toward it, which makes the whole thing feel broken rather
 * than merely fiddly.
 */
const CLOSE_GRACE_MS = 140;

export interface HoverCardProps {
  /** Accessible name: the trigger is glyphs and numbers, with no sentence in it. */
  label: string;
  /** The panel. A function so it can dismiss itself from a button inside. */
  card: (close: () => void) => ReactNode;
  width: number;
  /**
   * Told when the panel opens and closes.
   *
   * Both meters poll something expensive WHILE open (the process table, the
   * usage countdown), and that has to stay the consumer's effect rather than
   * move in here — the hover behaviour is generic, the polling is not.
   */
  onOpenChange?: (open: boolean) => void;
  /** Classes for the trigger button. */
  className?: string;
  children: ReactNode;
}

/**
 * A trigger that reveals a panel on hover, and the one place that behaviour is
 * written down.
 *
 * The usage meter and the resource meter each had their own copy of it —
 * openNow/closeSoon timers, a placement effect re-running on scroll and resize,
 * a portal with the same six classes — and the connection dot needed a third.
 * Three copies of a hover interaction is three chances for one of them to feel
 * different, and the near-miss is invisible in review because each is correct
 * on its own.
 *
 * PORTALLED to `document.body`, because the app shell is a fixed stacking
 * context and the panel's trigger now lives in a 33px title bar with
 * `overflow: hidden` on it. A panel rendered in place would be clipped to the
 * strip and reduced to a sliver.
 *
 * NOT the `Popover` component: that one is click-to-open, traps focus and owns
 * dismissal, which is right for a menu you act inside and wrong for a reading
 * you glance at. This never takes focus on hover and never blocks a click
 * behind it.
 */
export function HoverCard({
  label,
  card,
  width,
  onOpenChange,
  className,
  children,
}: HoverCardProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const change = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  const openNow = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    change(true);
  }, [change]);

  const closeSoon = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => change(false), CLOSE_GRACE_MS);
  }, [change]);

  const closeNow = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    change(false);
  }, [change]);

  // Glued to the trigger while open. `scroll` in CAPTURE so a scroll in any
  // container the trigger sits in reaches this, not just the window's.
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const vw = document.documentElement.clientWidth;
      // Aligned to the edge of the trigger it is NEAREST, then clamped into the
      // window. The gauges sit at the right end of the bar and want their panel
      // pulled left; the connection dot is the left-most thing in the app and
      // wants the opposite, and a fixed side left its card hanging off toward
      // x=0 with the dot floating over its far corner.
      const anchored = r.left < vw / 2 ? r.left : r.right - width;
      const left = Math.min(Math.max(MARGIN, anchored), vw - width - MARGIN);
      setPos({ top: r.bottom + GAP, left });
    };
    place();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeNow();
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, width, closeNow]);

  useEffect(() => () => void (closeTimer.current && clearTimeout(closeTimer.current)), []);

  return (
    <div className="relative inline-flex" onMouseEnter={openNow} onMouseLeave={closeSoon}>
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        // Click as well as hover, and `focus-visible` too: hover is not
        // available on a touch screen (the More sheet carries these on a phone,
        // but a narrow desktop window is still a pointer-less possibility) and
        // is not available to a keyboard at all.
        onClick={openNow}
        onFocus={(e) => {
          if (e.target.matches(":focus-visible")) openNow();
        }}
        onBlur={closeSoon}
        className={className}
      >
        {children}
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            onMouseEnter={openNow}
            onMouseLeave={closeSoon}
            style={{ zIndex: LAYER.popover, top: pos.top, left: pos.left, width }}
            className={cn(
              "fixed overflow-hidden rounded-md border border-line-strong",
              "bg-overlay/98 backdrop-blur-md shadow-[var(--shadow-pop)] cm-anim-rise",
            )}
          >
            {card(closeNow)}
          </div>,
          document.body,
        )}
    </div>
  );
}
