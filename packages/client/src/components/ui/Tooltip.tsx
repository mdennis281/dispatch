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
import {
  HOLD_IDLE,
  HOLD_MS,
  holdOpen,
  holdSwallowsClick,
  reduceHold,
  type HoldEvent,
  type HoldState,
} from "../../lib/pressHold.js";
import { usableTop } from "../../lib/windowControls.js";

export interface TooltipProps {
  label: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
  className?: string;
  triggerClassName?: string;
  /**
   * Also open on a touch HOLD — the only way to ask for a tooltip on a device
   * with no hover. Off by default and worth opting in only where the tooltip
   * is the sole copy of something, because the gesture costs the trigger the
   * click that ends it (`lib/pressHold.ts`). On a plain button that trade is
   * the wrong way round: a press held a beat too long would name the button
   * instead of pressing it.
   */
  holdToOpen?: boolean;
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
 * Hover/focus/hold tooltip. The bubble is rendered in a **portal** to
 * `document.body` and positioned to the trigger with viewport-collision
 * handling — so it is never clipped by an `overflow` ancestor (a header bar,
 * the CodeViewer modal header, a sidebar) or the viewport edge, and always
 * shows in full:
 *   - flips to the opposite side when the preferred one is cramped,
 *   - clamps the cross-axis into the viewport,
 *   - treats the window controls overlay's drag strip as NOT viewport — see
 *     `usableTop`,
 *   - reflows on scroll/resize while open.
 *
 * On touch there is no hover to open it with, so with `holdToOpen` a HOLD does
 * instead — see `lib/pressHold.ts` for the gesture's rules, why each one is
 * there, and why it is opt-in.
 */
export function Tooltip({
  label,
  side = "top",
  children,
  className,
  triggerClassName,
  holdToOpen = false,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);

  // The hold gesture lives in a REF, not state: `pointermove` fires at refresh
  // rate for the whole of a scroll, and re-rendering a sidebar row on each one
  // is a cost the row cannot pay. Only crossing into `held` — which is a
  // visible change — touches React.
  const hold = useRef<HoldState>(HOLD_IDLE);
  const holdTimer = useRef<ReturnType<typeof setTimeout>>();

  // Typed explicitly because the body calls itself: an un-annotated recursive
  // `const` arrow is TS7022 ("implicitly has type any").
  const dispatchHold = useCallback<(event: HoldEvent) => void>((event) => {
    if (!holdToOpen) return;
    const prev = hold.current;
    const next = reduceHold(prev, event);
    if (next === prev) return;
    hold.current = next;

    // The machine says whether the clock should be running; this keeps the one
    // real timer in step with it, so no path can leave a stray tooltip armed.
    if (next.phase !== "waiting" && holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = undefined;
    }
    if (next.phase === "waiting" && !holdTimer.current) {
      holdTimer.current = setTimeout(() => {
        holdTimer.current = undefined;
        dispatchHold({ kind: "elapsed" });
      }, HOLD_MS);
    }
    if (holdOpen(next) !== holdOpen(prev)) setOpen(holdOpen(next));
  }, [holdToOpen]);

  useEffect(() => () => clearTimeout(holdTimer.current), []);

  // `held` means "the bubble is up because of a hold", so a closed bubble must
  // not leave one behind. Only a pointer clears the phase otherwise, and every
  // other way the bubble can close — a mouse leaving a hybrid device's trigger,
  // a blur — would strand it as a latch that eats the trigger's next click.
  //
  // Never while a press is IN FLIGHT, though. Holding an open bubble's own
  // trigger again is one native `pointerdown` doing two things: the window
  // dismissal below closes the bubble, then this trigger's `onPointerDown`
  // re-arms. React 18 happens to flush this effect BETWEEN the two (measured:
  // `dismiss: held->idle` → `effect open=false phase=idle` → `down:
  // idle->waiting`), so it lands on `idle` and does nothing — but that is
  // passive-effect scheduling, not a contract. Were it to run a beat later it
  // would erase the `waiting` the press just established, and the second hold
  // would silently become a tap into the chat. `waiting` is never a latch, so
  // skipping it costs nothing and the ordering stops mattering.
  useEffect(() => {
    if (!open && hold.current.phase !== "waiting") hold.current = HOLD_IDLE;
  }, [open]);

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
    //
    // It is also what takes a held bubble away: on touch the finger has long
    // since lifted, so the next press anywhere is the only signal left. Capture
    // phase, so this runs BEFORE the trigger's own `pointerdown` — a second
    // hold on the same trigger dismisses and then re-arms, rather than being
    // dismissed by the press that started it.
    const onPress = () => {
      dispatchHold({ kind: "dismiss" });
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPress, true);
    return () => {
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("pointerdown", onPress, true);
    };
  }, [open, reposition, dispatchHold]);

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
      // On touch, NEVER a close. The browser fires `pointerleave` right after
      // `pointerup` — the touch pointer ceases to exist — so closing here would
      // take the bubble away the instant the finger lifts, which is the instant
      // you can finally see it. `cancel` only bites while the hold is still
      // pending, where the finger sliding off the trigger genuinely aborts it.
      onPointerLeave={(e) => {
        if (holdToOpen && e.pointerType === "touch") dispatchHold({ kind: "cancel" });
        else setOpen(false);
      }}
      onPointerDown={(e) =>
        dispatchHold({ kind: "down", pointerType: e.pointerType, x: e.clientX, y: e.clientY })
      }
      onPointerMove={(e) => {
        if (hold.current.phase !== "waiting") return;
        dispatchHold({ kind: "move", x: e.clientX, y: e.clientY });
      }}
      onPointerUp={() => dispatchHold({ kind: "up" })}
      onPointerCancel={() => dispatchHold({ kind: "cancel" })}
      // Android raises `contextmenu` from its own long-press at ~500ms, a beat
      // after ours has opened — the browser's "copy / select" sheet over the
      // answer the gesture just asked for. Suppressed only while a hold is in
      // flight, so a right-click still gets its menu.
      onContextMenu={(e) => {
        if (hold.current.phase !== "idle") e.preventDefault();
      }}
      // The click that ends a hold belongs to the gesture, not to whatever the
      // trigger sits inside — see `holdSwallowsClick`. Capture phase and both
      // halves: `stopPropagation` keeps it from the row button's React handler,
      // `preventDefault` from an anchor's navigation.
      onClickCapture={(e) => {
        if (!holdSwallowsClick(hold.current, e.detail)) return;
        e.preventDefault();
        e.stopPropagation();
      }}
      // KEYBOARD focus only. Most triggers wrap a real `<button>` and `focusin`
      // bubbles, so on a mouse click Chromium runs `pointerdown` (which the
      // dismissal above acts on) and then focuses the button as the default
      // action — reopening the bubble a frame after the press closed it, as a
      // visible blink that replays `cm-anim-rise`. Two native events, so React
      // does not batch them away. `:focus-visible` is exactly this distinction
      // and the browser already computes it: false for a click on a button,
      // true for a Tab. Safari never focuses buttons on click and so never had
      // the blink; this is correct there too rather than merely inert.
      onFocusCapture={(e) => {
        if (e.target instanceof Element && e.target.matches(":focus-visible")) setOpen(true);
      }}
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
