/**
 * Is the window controls overlay actually up right now?
 *
 * The manifest ASKS for `window-controls-overlay` (first in `display_override`),
 * which settles nothing: the same bundle runs in a browser tab, in a plain
 * standalone window on a browser that never implemented the feature, and in an
 * installed Chromium window that did. Only the last one has no title bar, and
 * only the last one should spend a row on being a title bar.
 *
 * `(display-mode: window-controls-overlay)` is the signal because it reports what
 * the window IS, not what the manifest wanted — false in a tab, false where the
 * feature is unsupported, and false in fullscreen, where the mode flips to
 * `fullscreen` and the buttons go away. So every fallback collapses the row
 * without any of them being special-cased here.
 *
 * Deliberately NOT `navigator.windowControlsOverlay.visible`: that reads the same
 * fact through a Chromium-only object, and its `geometrychange` event fires at
 * scroll frequency during a window resize — a debounce and a re-render per frame
 * to learn something a media query already tracks for free. The GEOMETRY, which
 * is the part that genuinely changes on resize, is consumed as `env()` in CSS
 * (see `--cm-titlebar-*` in index.css), where the UA updates it without telling
 * us anything at all.
 */
import { useEffect, useState } from "react";

const WCO_QUERY = "(display-mode: window-controls-overlay)";

export function isWindowControlsOverlay(): boolean {
  // Guarded like `isStandalone`: these run in a node-environment vitest too.
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(WCO_QUERY).matches;
}

/**
 * The y below which the window is ours to draw on.
 *
 * With the overlay up, the top of the window is a drag strip with the system's
 * buttons painted over it (see `TitleBar` in components/layout/TopBar). Anything
 * that positions itself against the viewport — a tooltip flipping to the side
 * with more room, a popover clamping to the edge — will happily use that band,
 * because as far as `clientHeight` is concerned it is just more page. It isn't:
 * a bubble there reads as floating in the OS chrome, and it lands on top of the
 * window controls.
 *
 * MEASURED off the strip's own rect rather than computed from
 * `env(titlebar-area-height)`. `getComputedStyle` on a custom property hands back
 * the unresolved `env(...)` token rather than a length (the same reason
 * stores/viewport measures with probes), and reading the element that IS the band
 * also means this answers 0 in every case where the strip isn't rendered —
 * browser tab, unsupported browser, fullscreen — without repeating the condition
 * that decides it.
 */
export function usableTop(): number {
  if (typeof document === "undefined") return 0;
  const strip = document.querySelector(".cm-titlebar");
  return strip ? Math.round(strip.getBoundingClientRect().bottom) : 0;
}

/** Live `isWindowControlsOverlay` — re-renders on entering/leaving fullscreen. */
export function useWindowControlsOverlay(): boolean {
  const [overlay, setOverlay] = useState(isWindowControlsOverlay);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(WCO_QUERY);
    const read = () => setOverlay(mql.matches);
    mql.addEventListener("change", read);
    // Re-read on mount rather than trusting the initial state: the query can
    // have flipped between the first render and this effect (the app mounts
    // behind an auth gate, and fullscreen is one keystroke away).
    read();
    return () => mql.removeEventListener("change", read);
  }, []);
  return overlay;
}
