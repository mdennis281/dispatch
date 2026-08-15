import { useViewport, isStandalone, standaloneShellHeight } from "../../stores/viewport.js";
import { LAYER } from "../../lib/layers.js";

/**
 * Every viewport number the browser will admit to, on screen, live.
 *
 * This exists because an iPhone cannot be inspected remotely from Windows, and
 * the bugs it is for only happen in the installed standalone PWA — the one
 * context with no console, no inspector and no URL bar to add a query flag to.
 * Two attempts at fixing the bottom of the mobile shell were built on inferred
 * numbers and both missed, so this reads them out instead.
 *
 * Toggled from the More sheet, off by default, never persisted.
 *
 * What to look for:
 *  - `inner` dropping below `max` and staying there is the WebKit standalone
 *    bug: the viewport shrinks on first keyboard open and never recovers.
 *  - `dvh` ≠ `inner` means `100dvh` — which sizes the whole shell — disagrees
 *    with the window, so no amount of correct layout maths can help.
 *  - `off` non-zero with the keyboard DOWN is the iOS 26 offsetTop regression,
 *    and it skews `kb` directly.
 *  - `kb` staying 0 while the keyboard is visibly up means the shell is never
 *    being told to shrink at all.
 */
export function ViewportDebug() {
  // Subscribes to `debug` ALONE. The tracker writes the store every frame for
  // 600ms after each focus change, and this component is mounted for everyone —
  // subscribing to the whole store would re-render the app's last child on
  // every one of those frames to render null.
  const debug = useViewport((s) => s.debug);
  return debug ? <ViewportReadout /> : null;
}

function ViewportReadout() {
  const m = useViewport();

  const shrunk = m.maxInnerHeight - m.innerHeight;
  const vh = standaloneShellHeight(isStandalone(), m.innerHeight, m.maxInnerHeight);
  const rows: Array<[string, string, boolean]> = [
    // What the shell is ACTUALLY sized to, and why — the one line that says
    // whether the correction is engaged.
    ["shell", vh > 0 ? `${vh} (fixed)` : `${m.dvh} (dvh)`, vh > 0],
    ["kb", `${m.inset}`, m.inset > 0],
    ["inner", `${m.innerHeight}${shrunk > 2 ? ` (-${shrunk} of ${m.maxInnerHeight})` : ""}`, shrunk > 2],
    ["vv", `${m.vvHeight}`, false],
    ["off", `${m.vvOffsetTop}`, m.vvOffsetTop !== 0],
    ["dvh", `${m.dvh}`, Math.abs(m.dvh - m.innerHeight) > 2],
    ["client", `${m.clientHeight}`, false],
    ["safe-b", `${m.safeBottom}`, false],
    ["screen", `${m.screenHeight}`, false],
    ["scale", m.vvScale.toFixed(2), Math.abs(m.vvScale - 1) > 0.01],
  ];

  return (
    <div
      // `fixed` to the LAYOUT viewport on purpose: this readout must not move
      // with the thing it is measuring, or it can't be trusted to report it.
      // Above `shutdown`, the current ceiling: a diagnostic you can't read
      // because the thing you're diagnosing is covering it is no diagnostic.
      style={{ zIndex: LAYER.shutdown + 1 }}
      className="pointer-events-none fixed left-1 top-[max(var(--cm-safe-top),0.25rem)] rounded border border-line-strong bg-black/80 px-1.5 py-1 font-mono text-2xs leading-tight text-white backdrop-blur-sm"
    >
      {rows.map(([k, v, warn]) => (
        <div key={k} className="flex gap-1.5">
          <span className="w-11 shrink-0 text-white/45">{k}</span>
          <span className={warn ? "text-amber-300" : "text-white/90"}>{v}</span>
        </div>
      ))}
    </div>
  );
}
