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

export interface PopoverProps {
  /** Render-prop trigger; receives the current open state + a toggle. */
  trigger: (o: { open: boolean; toggle: () => void }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "start" | "end" | "center";
  side?: "top" | "bottom";
  className?: string;
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
  side: "top" | "bottom";
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
  width,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const close = useCallback(() => setOpen(false), []);

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

    // vertical placement + flip toward the roomier side when cramped.
    const spaceBelow = vh - t.bottom - GAP - MARGIN;
    const spaceAbove = t.top - GAP - MARGIN;
    const needed = menuEl.scrollHeight;
    let resolved: "top" | "bottom" = side;
    if (side === "bottom" && needed > spaceBelow && spaceAbove > spaceBelow) {
      resolved = "top";
    } else if (side === "top" && needed > spaceAbove && spaceBelow > spaceAbove) {
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
    if (!open) {
      setPlacement(null);
      return;
    }
    reposition();
  }, [open, reposition]);

  // Keep the menu glued to the trigger + close on outside-click / Escape.
  useEffect(() => {
    if (!open) return;

    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
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
      setOpen(false);
    };
    const onReflow = () => reposition();

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onReflow);
    // capture so scrolls in any ancestor container reposition the menu too.
    window.addEventListener("scroll", onReflow, true);

    const ro = new ResizeObserver(onReflow);
    if (menuRef.current) ro.observe(menuRef.current);

    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
      ro.disconnect();
    };
  }, [open, reposition]);

  return (
    <div ref={triggerRef} className="relative inline-flex">
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className={cn(
              "fixed cm-scroll overflow-y-auto overflow-x-hidden rounded-md border " +
                "border-line-strong bg-overlay/98 backdrop-blur-md shadow-[var(--shadow-pop)] cm-anim-rise",
              className,
            )}
            style={
              placement
                ? {
                    zIndex: LAYER.popover,
                    left: placement.left,
                    top: placement.top,
                    width: placement.width,
                    maxHeight: placement.maxHeight,
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
            }
          >
            {typeof children === "function" ? children(close) : children}
          </div>,
          document.body,
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
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  hint?: ReactNode;
  /** Native tooltip for detail too long to sit inline (e.g. a model's blurb). */
  title?: string;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] text-secondary " +
          "transition-colors hover:bg-white/[0.06] hover:text-primary",
        active && "text-primary",
        className,
      )}
    >
      {icon && <span className="text-muted [&_svg]:size-3.5">{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-[10.5px] text-faint">{hint}</span>}
    </button>
  );
}
