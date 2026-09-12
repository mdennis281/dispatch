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

/**
 * Does a blur mean focus has genuinely LEFT the card?
 *
 * The panel is portalled to `document.body`, so it is a DOM sibling of the
 * trigger rather than a child: focusing a control inside it really does blur the
 * trigger, and React's portal bubbling does not help because the portal is a
 * sibling in the React tree too. So a naive `onBlur={close}` dismissed the card
 * exactly when someone reached into it — click the usage gauge, move onto the
 * panel, press Refresh, and the panel vanished ~140ms later with the spinner
 * still on screen. Same mechanism swallowed "Break down by chat".
 *
 * `null` counts as STAYING. A blur with no `relatedTarget` is focus going
 * nowhere focusable — a click on the panel's own text, or the window losing
 * focus — and for a card driven by hover the safe failure is to stay up: the
 * pointer is still over it, and `mouseleave` will close it the moment that
 * stops being true.
 *
 * Exported because it is the whole of the bug: the client's vitest runs in a
 * `node` environment (see vitest.config.ts) with no DOM to fire a real blur in,
 * and a pure predicate over `contains` is the part worth pinning down.
 */
export function blurLeavesCard(
  related: EventTarget | null,
  trigger: Node | null,
  panel: Node | null,
): boolean {
  if (!related) return false;
  const node = related as Node;
  if (trigger && (trigger === node || trigger.contains(node))) return false;
  if (panel && (panel === node || panel.contains(node))) return false;
  return true;
}

export interface HoverCardProps {
  /** Accessible name: the trigger is glyphs and numbers, with no sentence in it. */
  label: string;
  /** The panel. Takes a `close` so a control inside it can dismiss the card. */
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
 * KEYBOARD, despite the name. The trigger is a real button, so Enter opens it —
 * and because the panel is at the end of `<body>`, Tab from the trigger would
 * walk past it into the rest of the bar, leaving a card open that its owner
 * could never reach. So a card opened from the keyboard takes focus itself
 * (`tabIndex={-1}`), which puts its own controls next in the tab order, and
 * Escape closes it and hands focus back to the trigger.
 *
 * NOT the `Popover` component: that one is click-to-open, traps focus and owns
 * dismissal, which is right for a menu you act inside and wrong for a reading
 * you glance at. This never takes focus from a pointer and never blocks a click
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
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Was this opened by a keyboard? Only then does the panel take focus. */
  const byKeyboard = useRef(false);

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
      if (e.key !== "Escape") return;
      // Hand focus back if it is inside the card — Escape must not drop a
      // keyboard user on `<body>` with no idea where they were.
      if (panelRef.current?.contains(document.activeElement)) btnRef.current?.focus();
      closeNow();
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

  // The panel only mounts once it has been placed, so `pos` is part of the
  // condition rather than just `open`: focusing on the open render would find
  // nothing there.
  useEffect(() => {
    if (!open) {
      byKeyboard.current = false;
      return;
    }
    if (byKeyboard.current) panelRef.current?.focus();
  }, [open, pos]);

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
          if (!e.target.matches(":focus-visible")) return;
          byKeyboard.current = true;
          openNow();
        }}
        onBlur={(e) => {
          if (blurLeavesCard(e.relatedTarget, btnRef.current, panelRef.current)) closeSoon();
        }}
        className={className}
      >
        {children}
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            // Focusable only programmatically: the keyboard path above moves
            // focus here so the card's own controls come next in the tab order.
            tabIndex={-1}
            onMouseEnter={openNow}
            onMouseLeave={closeSoon}
            // A press or a focus landing inside also cancels a pending close.
            // `mouseenter` fires once on the way in and cannot fire again, so
            // without these a close armed by the trigger's blur runs anyway —
            // which is what ate the Refresh click.
            onMouseDown={openNow}
            onFocusCapture={openNow}
            onBlur={(e) => {
              if (blurLeavesCard(e.relatedTarget, btnRef.current, panelRef.current)) closeSoon();
            }}
            style={{ zIndex: LAYER.popover, top: pos.top, left: pos.left, width }}
            className={cn(
              "fixed overflow-hidden rounded-md border border-line-strong outline-none",
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
