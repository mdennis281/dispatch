import { useEffect, useRef, type ReactNode } from "react";
import { FOCUSABLE } from "../../lib/focusable.js";
import { cn } from "../../lib/cn.js";
import { LAYER } from "../../lib/layers.js";
import { registerSwipePanel, type SwipePanelId } from "../../lib/swipeDrag.js";

export type DrawerSide = "left" | "right" | "bottom";

export interface DrawerProps {
  /** Whether the panel is on screen. Ignored while `enabled` is false. */
  open: boolean;
  /**
   * Whether this surface is a drawer AT ALL right now.
   *
   * At `lg` the sidebar and right panel are ordinary inline columns, and the
   * desktop layout has to stay pixel-identical — so when this is false the
   * wrapper renders `display: contents` and disappears from layout entirely,
   * handing the child straight back to the flex row as its own flex item. The
   * alternative (rendering `<Sidebar/>` bare in one branch and wrapped in the
   * other) changes the element type at that position, which REMOUNTS the child
   * on every breakpoint crossing and throws away its scroll position and
   * expanded groups.
   */
  enabled: boolean;
  onClose: () => void;
  side: DrawerSide;
  /**
   * Scrim + focus trap + Escape. False for a surface that is a PANE rather than
   * modal chrome — the phone-width right panel fills the main area and is
   * switched by the bottom nav, so trapping focus in it would be trapping focus
   * in the app.
   */
  modal?: boolean;
  /** Accessible name; also what the scrim's close action is described as. */
  label: string;
  /**
   * `absolute` confines the sheet (and its scrim) to the nearest positioned
   * ancestor instead of the viewport. The two side drawers use it so they slide
   * in UNDER the top bar rather than over it: the bar carries the connection dot
   * and the command palette, and a right-hand pane that swallowed both would
   * make "open Worktrees" also mean "lose the only way to tell you went offline".
   * The More sheet is genuinely viewport-level, so it stays `fixed`.
   */
  position?: "fixed" | "absolute";
  /**
   * Publishes this panel to the edge swipe so the gesture can drag it under the
   * finger instead of only flicking it open at the end. Omit for a drawer the
   * swipe never moves — the More sheet is the one the gesture dismisses but
   * does not travel, because a horizontal drag has nothing to say about a sheet
   * that arrives from the bottom.
   */
  swipeId?: SwipePanelId;
  /** Sizing + surface classes for the panel itself. */
  className?: string;
  children: ReactNode;
}

const HIDDEN: Record<DrawerSide, string> = {
  left: "-translate-x-full",
  right: "translate-x-full",
  bottom: "translate-y-full",
};

const ANCHOR: Record<DrawerSide, string> = {
  left: "inset-y-0 left-0",
  right: "inset-y-0 right-0",
  bottom: "inset-x-0 bottom-0",
};

/**
 * An off-canvas sheet that keeps its contents MOUNTED.
 *
 * Two things this deliberately does not do:
 *
 * 1. It does not unmount the panel when closed. `Sidebar` and `RightPanel` hold
 *    real state — scroll offset, which groups are expanded, a half-typed rename
 *    — and conditional rendering throws all of it away on every close.
 * 2. It animates `transform` and nothing else. The main area's box must not
 *    change during the slide: `Composer` runs a `ResizeObserver` on its toolbar
 *    to decide compact-vs-full, and animating a width or a margin would fire
 *    that observer on every frame of every drawer animation.
 *
 * Closed-but-mounted means the panel still holds tab stops behind the scrim, so
 * it is marked `inert` — set imperatively because React 18's JSX types don't
 * carry the attribute.
 */
export function Drawer({
  open,
  enabled,
  onClose,
  side,
  modal = true,
  label,
  position = "fixed",
  swipeId,
  className,
  children,
}: DrawerProps) {
  const pos = position === "fixed" ? "fixed" : "absolute";
  const panelRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const shown = enabled && open;

  // Only while this really IS a drawer: at `lg` the wrapper is `display:
  // contents` and there is no panel element at all, so a stale registration
  // would hand the gesture a node that is no longer in the layout. The scrim is
  // read lazily rather than captured, because `modal` can change it out from
  // under a registration that is otherwise still correct.
  useEffect(() => {
    const el = panelRef.current;
    if (!swipeId || !enabled || !el) return;
    return registerSwipePanel(swipeId, {
      panel: el,
      scrim: () => scrimRef.current,
      side: side === "right" ? "right" : "left",
    });
  }, [swipeId, enabled, side]);

  // `inert` removes the whole subtree from the tab order and the a11y tree while
  // it's parked off-canvas. Without it, tabbing out of the composer walks
  // invisibly through every chat row in a closed sidebar.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    el.toggleAttribute("inert", !shown);
  }, [shown]);

  // Escape, and focus handling. Only for a modal drawer — a pane isn't something
  // you dismiss, it's something you switch away from.
  useEffect(() => {
    if (!shown || !modal) return;

    restoreTo.current = document.activeElement as HTMLElement | null;
    // Focus the panel itself rather than its first control: the first control in
    // the sidebar is the project switcher, and opening a drawer should not look
    // like you're about to change projects.
    //
    // `preventScroll`, because at this moment the panel is still parked at
    // `translate-x-full` — outside the shell. A transformed box counts toward
    // its container's scrollable overflow, and the shell's `overflow: hidden`
    // is still programmatically scrollable, so a plain `focus()` scrolled the
    // whole shell 360px sideways to "reveal" the md right panel. The main column
    // slid out of frame for the length of the animation, then snapped back when
    // the finished transform stopped overflowing and the scroll offset clamped.
    panelRef.current?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const el = panelRef.current;
      if (!el) return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (n) => n.offsetParent !== null,
      );
      if (items.length === 0) {
        e.preventDefault();
        el.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      // Wrap at both ends, and pull focus back in if it has escaped to the page
      // behind (which it can, since the page behind is not `inert`).
      if (e.shiftKey && (active === first || active === el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (!el.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      restoreTo.current?.focus?.();
    };
  }, [shown, modal, onClose]);

  /**
   * A `Popover` opened from inside the drawer portals to `document.body` and
   * positions itself with `position: fixed` against the trigger's rect, which it
   * only re-reads on scroll and resize. A drawer slide is neither, so a menu
   * left open across one detaches from its trigger and floats mid-screen.
   * Synthesizing a `resize` at the end of the transition is the cheapest way to
   * reach every such menu without either side importing the other.
   */
  const onTransitionEnd = (e: React.TransitionEvent) => {
    if (e.propertyName !== "transform") return;
    window.dispatchEvent(new Event("resize"));
  };

  if (!enabled) {
    // `contents`: the wrapper has no box, so the child is the flex item its
    // `w-[260px] shrink-0` was written for. This is what keeps `lg` untouched.
    return <div className="contents">{children}</div>;
  }

  return (
    <>
      {modal && (
        <div
          ref={scrimRef}
          aria-hidden
          onClick={onClose}
          style={{ zIndex: LAYER.drawerScrim }}
          className={cn(
            pos,
            "inset-0 bg-scrim backdrop-blur-[2px] transition-opacity duration-200 ease-[var(--ease-out)]",
            shown ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        />
      )}
      <div
        ref={panelRef}
        role={modal ? "dialog" : "group"}
        aria-modal={modal || undefined}
        // A drawer is shell CHROME, not somebody else's screen. The edge-swipe
        // gesture refuses to start inside any `aria-modal` subtree — the code
        // viewer, the annotator, the file picker all own the window while they
        // are up — and every drawer in the app is a surface that same gesture
        // navigates BETWEEN (chat → picker → home), so each one opts back in.
        // See `startsInHorizontalScroller` in lib/useEdgeSwipe.
        data-swipe-nav=""
        aria-label={label}
        tabIndex={-1}
        style={{ zIndex: LAYER.drawer }}
        onTransitionEnd={onTransitionEnd}
        className={cn(
          pos,
          "flex outline-none transition-transform duration-200 ease-[var(--ease-out)]",
          // `motion-reduce` rather than a JS check: the drawer must still ARRIVE
          // instantly, and the class variant is the only form that can't get out
          // of sync with the media query.
          "motion-reduce:transition-none",
          ANCHOR[side],
          shown ? "translate-x-0 translate-y-0" : HIDDEN[side],
          className,
        )}
      >
        {children}
      </div>
    </>
  );
}
