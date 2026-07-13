import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Minimal, dependency-free FLIP animation for a reordering list. After every
 * commit it measures each `[data-flip-id]` child's position (scroll-independent
 * `offsetTop`) and, when a row has moved since the previous commit, plays it
 * from its old spot to the new one with a short transform transition. Rows that
 * appeared or were removed don't animate. Deliberately "minor": a ~220ms ease,
 * `transform`-only (no layout cost, respects `prefers-reduced-motion` below).
 *
 * Pass the container ref; tag each animating child with `data-flip-id={id}`.
 */
export function useFlipReorder(containerRef: RefObject<HTMLElement | null>): void {
  const prev = useRef<Map<string, number>>(new Map());

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const rows = el.querySelectorAll<HTMLElement>("[data-flip-id]");
    const next = new Map<string, number>();
    rows.forEach((row) => next.set(row.dataset.flipId!, row.offsetTop));

    if (!reduce) {
      rows.forEach((row) => {
        const id = row.dataset.flipId!;
        const was = prev.current.get(id);
        const now = next.get(id)!;
        if (was === undefined || was === now) return;
        const dy = was - now;
        if (Math.abs(dy) < 1) return;
        // Invert: jump back to the old position with no transition…
        row.style.transition = "none";
        row.style.transform = `translateY(${dy}px)`;
        void row.offsetHeight; // force reflow so the start position sticks
        // …then Play to the new position.
        requestAnimationFrame(() => {
          row.style.transition = "transform 220ms cubic-bezier(0.2,0.8,0.2,1)";
          row.style.transform = "";
        });
      });
    }
    prev.current = next;
  });
}
