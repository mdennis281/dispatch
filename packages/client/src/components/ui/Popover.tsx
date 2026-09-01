import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn.js";
import { LAYER } from "../../lib/layers.js";

export interface PopoverProps {
  /** Render-prop trigger; receives the current open state + a toggle. */
  trigger: (o: { open: boolean; toggle: () => void }) => ReactNode;
  children:
    | ReactNode
    | ((close: () => void, closeAfter: (after: () => void) => void) => ReactNode);
  align?: "start" | "end" | "center";
  /**
   * `right` measures the nearest `data-popover-right-boundary` edge and opens
   * beyond it when the live viewport has room. When it does not, the same menu
   * falls back to the ordinary viewport-clamped dropdown placement.
   */
  side?: "top" | "bottom" | "right";
  className?: string;
  /**
   * Classes for the trigger's WRAPPER, not the trigger itself.
   *
   * The wrapper is `inline-flex`, so it shrink-wraps its content and a `w-full`
   * on the trigger inside it resolves against that shrink-to-fit box — i.e.
   * against itself, which is a no-op. A trigger that has to fill its container
   * (the sidebar's project row, which is a full-bleed band) needs the wrapper to
   * stretch too, and `className` above goes to the portalled menu.
   */
  triggerClassName?: string;
  width?: number;
}

/** Gap between trigger and menu, and safe-area from the viewport edge (px). */
const GAP = 6;
const MARGIN = 8;
/** The menu never collapses below this even if a side is fully cramped. */
const MIN_MENU_H = 96;

interface Placement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  side: "top" | "bottom" | "right";
}

type PopoverStyle = CSSProperties & {
  "--cm-popover-gap"?: string;
  "--cm-popover-animation-from"?: string;
};

/** Pure seam for the fit decision; kept exported so width regressions stay cheap to test. */
export function fitsToRight(
  boundaryRight: number,
  menuWidth: number,
  viewportWidth: number,
): boolean {
  return boundaryRight + GAP + menuWidth <= viewportWidth - MARGIN;
}

/**
 * Click-to-open floating menu. The panel is rendered in a **portal** to
 * `document.body` and positioned to the trigger with viewport-collision
 * handling — so it is never clipped by an `overflow` ancestor (modal body,
 * composer bar, sidebar) and always shows every option:
 *   - flips above the trigger when there's no room below (and vice-versa),
 *   - clamps left/top into the viewport,
 *   - matches the trigger width as a floor (or the explicit `width`),
 *   - caps its height to the available room and scrolls internally,
 *   - closes on outside-click and Escape.
 */
export function Popover({
  trigger,
  children,
  align = "end",
  side = "bottom",
  className,
  triggerClassName,
  width,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const afterCloseRef = useRef<(() => void) | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [animationFrom, setAnimationFrom] = useState<string | null>(null);
  const mounted = open || closing;

  // The fixed app shell is a stacking context. A flyout portalled straight to
  // `body` sits above that WHOLE context, so no z-index on the nested sidebar
  // can mask it. Right flyouts stay inside the shell instead, where their 39/40
  // ordering against the sidebar is real. Ordinary popovers remain body-level.
  const portalRoot =
    mounted && typeof document !== "undefined"
      ? placement?.side === "right"
        ? (triggerRef.current?.closest<HTMLElement>("[data-popover-layer-root]") ??
          document.body)
        : document.body
      : null;

  // Direction changes must start at the compositor's current position. Starting
  // the opposite keyframe at its declared endpoint makes a quick toggle jump
  // fully behind/outside the sidebar before travelling the other way.
  const readFlyoutTransform = useCallback(
    () =>
      placement?.side === "right" && menuRef.current
        ? getComputedStyle(menuRef.current).transform
        : null,
    [placement?.side],
  );

  // Every dismissal path lands here — trigger toggle, menu choice, outside
  // press, Escape. Keep the portal mounted until its own exit animation ends;
  // callers that would unmount the trigger (inline rename is one) can use
  // `closeAfter` so that action cannot cut the animation short.
  const close = useCallback(() => {
    if (closing) return;
    setAnimationFrom(readFlyoutTransform());
    setOpen(false);
    setClosing(true);
  }, [closing, readFlyoutTransform]);

  const closeAfter = useCallback(
    (after: () => void) => {
      afterCloseRef.current = after;
      close();
    },
    [close],
  );

  const finishClose = useCallback(() => {
    setClosing(false);
    setPlacement(null);
    setAnimationFrom(null);
    const after = afterCloseRef.current;
    afterCloseRef.current = null;
    after?.();
  }, []);

  const reposition = useCallback(() => {
    const trigEl = triggerRef.current;
    const menuEl = menuRef.current;
    if (!trigEl || !menuEl) return;

    const t = trigEl.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    // width: explicit prop else natural content; never below the trigger,
    // never wider than the viewport safe-area.
    const maxW = vw - MARGIN * 2;
    const natural = width ?? menuEl.offsetWidth;
    const menuW = Math.min(maxW, Math.max(natural, Math.round(t.width)));

    // A sidebar flyout is allowed only after BOTH live widths have been read.
    // The boundary can resize independently of its row (desktop split/layout
    // changes), while natural menu width can move as labels and counts change.
    const boundaryEl =
      side === "right"
        ? trigEl.closest<HTMLElement>("[data-popover-right-boundary]")
        : null;
    const boundaryRight = boundaryEl?.getBoundingClientRect().right ?? t.right;
    if (side === "right" && fitsToRight(boundaryRight, menuW, vw)) {
      const needed = menuEl.scrollHeight;
      const maxHeight = Math.max(MIN_MENU_H, vh - MARGIN * 2);
      const usedH = Math.min(needed, maxHeight);
      const top = Math.max(MARGIN, Math.min(t.top, vh - usedH - MARGIN));
      const left = boundaryRight + GAP;

      setPlacement((prev) =>
        prev &&
        prev.left === left &&
        prev.top === top &&
        prev.width === menuW &&
        prev.maxHeight === maxHeight &&
        prev.side === "right"
          ? prev
          : { left, top, width: menuW, maxHeight, side: "right" },
      );
      return;
    }

    // Ordinary dropdown placement + flip toward the roomier vertical side.
    // `right` deliberately falls through here on a phone or cramped desktop.
    const spaceBelow = vh - t.bottom - GAP - MARGIN;
    const spaceAbove = t.top - GAP - MARGIN;
    const needed = menuEl.scrollHeight;
    let resolved: "top" | "bottom" = side === "right" ? "bottom" : side;
    if (resolved === "bottom" && needed > spaceBelow && spaceAbove > spaceBelow) {
      resolved = "top";
    } else if (resolved === "top" && needed > spaceAbove && spaceBelow > spaceAbove) {
      resolved = "bottom";
    }
    const room = resolved === "bottom" ? spaceBelow : spaceAbove;
    const maxHeight = Math.max(MIN_MENU_H, room);
    const usedH = Math.min(needed, maxHeight);

    let top = resolved === "bottom" ? t.bottom + GAP : t.top - GAP - usedH;
    top = Math.max(MARGIN, Math.min(top, vh - usedH - MARGIN));

    // horizontal align + clamp into the viewport.
    let left =
      align === "start"
        ? t.left
        : align === "center"
          ? t.left + t.width / 2 - menuW / 2
          : t.right - menuW;
    left = Math.max(MARGIN, Math.min(left, vw - menuW - MARGIN));

    setPlacement((prev) =>
      prev &&
      prev.left === left &&
      prev.top === top &&
      prev.width === menuW &&
      prev.maxHeight === maxHeight &&
      prev.side === resolved
        ? prev
        : { left, top, width: menuW, maxHeight, side: resolved },
    );
  }, [align, side, width]);

  // Position synchronously before paint so there's no flash at the wrong spot.
  useLayoutEffect(() => {
    if (!mounted) {
      setPlacement(null);
      return;
    }
    reposition();
  }, [mounted, reposition]);

  // Keep the menu glued to the trigger + close on outside-click / Escape.
  useEffect(() => {
    if (!mounted) return;

    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Dismiss ONLY this menu, not a surrounding layer (e.g. the Modal a Select
      // is opened inside). Registered in the CAPTURE phase — which runs before any
      // bubble-phase `document` keydown listener (the Modal's) — so stopping
      // propagation here halts Escape before that listener can also close the
      // dialog and discard in-progress edits. Only Escape is swallowed; every
      // other key still propagates.
      e.stopPropagation();
      close();
    };
    const onReflow = () => reposition();

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onReflow);
    // capture so scrolls in any ancestor container reposition the menu too.
    window.addEventListener("scroll", onReflow, true);

    const ro = new ResizeObserver(onReflow);
    if (menuRef.current) ro.observe(menuRef.current);
    if (triggerRef.current) ro.observe(triggerRef.current);
    const boundary = triggerRef.current?.closest<HTMLElement>("[data-popover-right-boundary]");
    if (boundary) ro.observe(boundary);

    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
      ro.disconnect();
    };
  }, [close, mounted, reposition]);

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    // A second trigger press during the retract reverses back to open.
    afterCloseRef.current = null;
    setAnimationFrom(closing ? readFlyoutTransform() : null);
    setClosing(false);
    setOpen(true);
  };

  return (
    <div ref={triggerRef} className={cn("relative inline-flex", triggerClassName)}>
      {trigger({ open: mounted, toggle })}
      {mounted &&
        portalRoot &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            data-placement={placement?.side}
            data-closing={closing || undefined}
            onAnimationEnd={(event) => {
              if (event.target !== event.currentTarget) return;
              if (closing) {
                finishClose();
              } else {
                setAnimationFrom(null);
              }
            }}
            className={cn(
              "fixed cm-scroll overflow-y-auto overflow-x-hidden rounded-md border " +
                "border-line-strong bg-overlay/98 backdrop-blur-md shadow-[var(--shadow-pop)]",
              placement?.side === "right"
                ? closing
                  ? "cm-anim-slide-left"
                  : "cm-anim-slide-right"
                : closing
                  ? "cm-anim-popover-out"
                  : "cm-anim-rise",
              className,
            )}
            style={(
              placement
                ? {
                    // A right flyout physically starts behind the opaque
                    // sidebar. Other placements stay above every dialog as
                    // ordinary popovers, including the mobile fallback.
                    zIndex:
                      placement.side === "right" ? LAYER.sidebarFlyout : LAYER.popover,
                    left: placement.left,
                    top: placement.top,
                    width: placement.width,
                    maxHeight: placement.maxHeight,
                    pointerEvents: closing ? "none" : undefined,
                    "--cm-popover-gap": `${GAP}px`,
                    "--cm-popover-animation-from": animationFrom ?? undefined,
                  }
                : {
                    zIndex: LAYER.popover,
                    // pre-measure pass: render off-screen-invisible at natural
                    // size so we can read scrollHeight/offsetWidth.
                    left: 0,
                    top: 0,
                    width,
                    visibility: "hidden",
                    pointerEvents: "none",
                  }
            ) as PopoverStyle}
          >
            {typeof children === "function" ? children(close, closeAfter) : children}
          </div>,
          portalRoot,
        )}
    </div>
  );
}

/** A row inside a popover menu. */
export function MenuItem({
  icon,
  children,
  onClick,
  active,
  hint,
  title,
  className,
  disabled,
  dense = true,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  hint?: ReactNode;
  /** Native tooltip for detail too long to sit inline (e.g. a model's blurb). */
  title?: string;
  className?: string;
  /**
   * Greys the item out and stops the click. For an action that exists but has
   * nothing to act on right now — "Kill this chat's processes" with none
   * running. Hiding it instead would make the menu's shape flicker between
   * openings, which is worse to aim at than a dimmed row.
   */
  disabled?: boolean;
  /**
   * Off gives a 44px row — the minimum a thumb can reliably hit, and what the
   * composer's phone-width sheet uses. On by default because every menu in the
   * app was laid out against the 29px row; flipping the default would move all
   * of them to fix the handful that are touched.
   */
  dense?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm text-left text-secondary " +
          "transition-colors hover:bg-active hover:text-primary",
        dense ? "px-2 py-1.5 text-sm" : "min-h-11 px-3 py-2 text-base",
        active && "text-primary",
        disabled && "pointer-events-none opacity-40",
        className,
      )}
    >
      {icon && <span className="text-muted [&_svg]:size-3.5">{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-2xs text-faint">{hint}</span>}
    </button>
  );
}
