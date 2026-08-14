/**
 * The shell's breakpoint sensor.
 *
 * Three modes, and the boundaries are about what the chrome COSTS, not about
 * device names: the shell is a row of fixed columns (260px sidebar + 360px right
 * panel), so 620px of it is not the content.
 *
 *   sm  <768   — both side columns go off-canvas; a bottom nav replaces them.
 *   md  768–1279 — the sidebar fits inline; the right panel does not, so it's a drawer.
 *   lg  >=1280 — everything fits side by side. This is today's layout, unchanged.
 *
 * `matchMedia`, not `window.innerWidth` + resize. iOS Safari fires `resize` on
 * every URL-bar collapse during a scroll, so a width-polling listener re-renders
 * the whole shell while you're reading a transcript. A media query only fires
 * when the answer actually changes.
 *
 * This module is the SENSOR, not the accessor: it owns the queries and nothing
 * else. The value lives in `stores/layout.ts` (which subscribes here once at
 * module load) and components read it with `useLayoutMode()`. One-way, so there
 * is no import cycle and no second opinion about what mode we're in.
 */

export type LayoutMode = "sm" | "md" | "lg";

const MD_QUERY = "(min-width: 768px)";
const LG_QUERY = "(min-width: 1280px)";

/**
 * `undefined` under the client's vitest config, which is a plain node runner
 * with no DOM. Everything below degrades to `lg` there — the desktop layout is
 * the one a headless render should produce.
 */
function mq(query: string): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(query)
    : null;
}

/** ONE pair for the whole app — a query per subscriber is a listener per subscriber. */
const md = mq(MD_QUERY);
const lg = mq(LG_QUERY);

export function currentMode(): LayoutMode {
  if (!md || !lg) return "lg";
  if (lg.matches) return "lg";
  return md.matches ? "md" : "sm";
}

/**
 * Call `onChange` whenever the mode changes. Registered once at startup rather
 * than from a component effect: the mode is a document-level fact, and a
 * per-subscriber listener would fire the store's mode-transition rules (which
 * close drawers and reset panes) once per mounted component.
 */
export function watchBreakpoint(onChange: (mode: LayoutMode) => void): void {
  if (!md || !lg) return;
  const emit = () => onChange(currentMode());
  md.addEventListener("change", emit);
  lg.addEventListener("change", emit);
}
