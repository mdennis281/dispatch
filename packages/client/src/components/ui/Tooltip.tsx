import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn.js";
import { LAYER } from "../../lib/layers.js";
import { usableTop } from "../../lib/windowControls.js";

export interface TooltipProps {
  label: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
  className?: string;
  triggerClassName?: string;
}

type Side = NonNullable<TooltipProps["side"]>;

/** Gap between trigger and bubble, and safe-area from the viewport edge (px). */
const GAP = 6;
const MARGIN = 8;

interface Pos {
  left: number;
  top: number;
  side: Side;
}

/**
 * Hover/focus tooltip. The bubble is rendered in a **portal** to `document.body`
 * and positioned to the trigger with viewport-collision handling — so it is
 * never clipped by an `overflow` ancestor (a header bar, the CodeViewer modal
 * header, a sidebar) or the viewport edge, and always shows in full:
 *   - flips to the opposite side when the preferred one is cramped,
 *   - clamps the cross-axis into the viewport,
 *   - treats the window controls overlay's drag strip as NOT viewport — see
 *     `usableTop`,
 *   - reflows on scroll/resize while open.
 */
export function Tooltip({ label, side = "top", children, className, triggerClassName }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);

  const reposition = useCallback(() => {
    const trigEl = triggerRef.current;
    const tipEl = tipRef.current;
    if (!trigEl || !tipEl) return;

    const t = trigEl.getBoundingClientRect();
    const w = tipEl.offsetWidth;
    const h = tipEl.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    // Not every pixel above the trigger is ours to use: with the window controls
    // overlay the top band of the window is a drag strip with the system's close
    // button on it. Measuring it here rather than assuming 0 is what stops a
    // header tooltip from flipping UP into the OS chrome — which is exactly what
    // it started doing when the strip gave it just enough room to "fit".
    const top0 = usableTop();

    // Resolve the side, flipping to the opposite edge when the preferred one
    // can't fit the bubble and the far side has more room.
    const roomTop = t.top - top0;
    const roomBottom = vh - t.bottom;
    const roomLeft = t.left;
    const roomRight = vw - t.right;
    const needV = h + GAP + MARGIN;
    const needH = w + GAP + MARGIN;
    let resolved: Side = side;
    if (side === "top" && roomTop < needV && roomBottom > roomTop) resolved = "bottom";
    else if (side === "bottom" && roomBottom < needV && roomTop > roomBottom) resolved = "top";
    else if (side === "left" && roomLeft < needH && roomRight > roomLeft) resolved = "right";
    else if (side === "right" && roomRight < needH && roomLeft > roomRight) resolved = "left";

    let left: number;
    let top: number;
    if (resolved === "top" || resolved === "bottom") {
      left = t.left + t.width / 2 - w / 2;
      left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN));
      top = resolved === "top" ? t.top - GAP - h : t.bottom + GAP;
      // Clamped to the strip's bottom edge, not to 0 — otherwise a bubble too
      // tall to fit anywhere gets pinned INTO the band this just stopped it
      // choosing.
      top = Math.max(top0 + MARGIN, Math.min(top, vh - h - MARGIN));
    } else {
      top = t.top + t.height / 2 - h / 2;
      top = Math.max(top0 + MARGIN, Math.min(top, vh - h - MARGIN));
      left = resolved === "left" ? t.left - GAP - w : t.right + GAP;
      left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN));
    }

    setPos((prev) =>
      prev && prev.left === left && prev.top === top && prev.side === resolved
        ? prev
        : { left, top, side: resolved },
    );
  }, [side]);

  // Position synchronously before paint so there's no flash at the wrong spot.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    reposition();
  }, [open, reposition]);

  // Keep the bubble glued to the trigger while it's shown.
  useEffect(() => {
    if (!open) return;
    const onReflow = () => reposition();
    window.addEventListener("resize", onReflow);
    // capture so scrolls in any ancestor container reposition the bubble too.
    window.addEventListener("scroll", onReflow, true);
    // Any press anywhere dismisses. A tooltip is a HOVER affordance, and the
    // moment a pointer goes down the user has moved on to acting — but the real
    // reason is that `mouseleave` is not guaranteed to arrive: a trigger inside
    // the mobile `Drawer` is still MOUNTED after the drawer slides shut (it
    // animates `transform` and marks the panel `inert`), so it can never
    // receive the pointer event that would close its own bubble. The bubble is
    // `position: fixed` on the body, outside that transform, so it does not
    // leave with the drawer — and `Drawer`'s synthetic `resize` on transitionend
    // then repositions it against a trigger that has slid off-screen, where the
    // cross-axis clamp parks it over the transcript you just opened.
    const onPress = () => setOpen(false);
    window.addEventListener("pointerdown", onPress, true);
    return () => {
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("pointerdown", onPress, true);
    };
  }, [open, reposition]);

  return (
    <span
      ref={triggerRef}
      className={cn("relative inline-flex", triggerClassName)}
      // `pointerenter`, not `mouseenter`, so the pointer TYPE is available: a
      // tap fires the mouse-compatibility sequence, and opening on it puts a
      // hover bubble on a device that has no hover to end it. Pen still opens —
      // a stylus can hover, and its `pointerleave` is real.
      onPointerEnter={(e) => {
        if (e.pointerType !== "touch") setOpen(true);
      }}
      onPointerLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => setOpen(false)}
    >
      {children}
      {open &&
        createPortal(
          <span
            ref={tipRef}
            role="tooltip"
            className={cn(
              "pointer-events-none fixed whitespace-nowrap rounded-sm border border-line-strong " +
                "bg-overlay px-2 py-1 text-xs font-medium text-primary shadow-[var(--shadow-pop)] cm-anim-rise",
              className,
            )}
            style={
              pos
                ? { zIndex: LAYER.tooltip, left: pos.left, top: pos.top }
                : // pre-measure pass: render off-screen-invisible at natural
                  // size so we can read offsetWidth/offsetHeight for placement.
                  { zIndex: LAYER.tooltip, left: 0, top: 0, visibility: "hidden" }
            }
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
}
