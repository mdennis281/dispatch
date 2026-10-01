/**
 * The boot splash's mark, rendered from inside the app.
 *
 * The splash is a loading indicator that took a lot of tuning, and until now it
 * could only ever be seen for the three and a half seconds of a cold boot. The
 * two screens that are also "Dispatch is working on it, wait" — `ConnectingScreen`
 * and `UpdatingScreen` — had a pulsing lucide glyph instead. They get the real
 * thing now.
 *
 * ── WHAT IS AND IS NOT HERE ─────────────────────────────────────────────────
 *
 * No CSS, and no animation. Every rule that drives this lives in the `<style>`
 * in index.html's <head>, alongside the splash's own — which is why the loop
 * rules there are written as bare `.boot-splash__*` class selectors rather than
 * being scoped under `#boot-splash`. Two copies of those keyframes, one in the
 * bundle and one in the document, is the failure mode worth designing out: they
 * would drift, and the splash is the one surface where a drift is invisible
 * until somebody boots cold and watches carefully.
 *
 * IT DOES NOT MEAN BOTH MARKS RUN OFF THE SAME CLOCK, which is what this said
 * for a while and is the bug it cost. A CSS animation starts when it is APPLIED
 * TO AN ELEMENT, not at the document's time origin — so a `BootMark` mounted
 * forty minutes into a session starts its cycle at 0%, while the splash's
 * started at 0% forty minutes ago. `--boot-phase` is what closes that; see the
 * note on `.boot-splash__pan` in index.html for why the colours depend on it.
 *
 * The exit (`[data-done]`, the ball, the aperture) is scoped to `#boot-splash`
 * and deliberately not reachable from here. This mark does not resolve into
 * anything; it just keeps going until whatever it is reporting on is over.
 *
 * ── THE HOLD ────────────────────────────────────────────────────────────────
 *
 * The colour rotation is driven by the inline script in <head>, which stops
 * ticking once nothing is showing the mark — the splash releases its own hold
 * when it lifts. Without a hold of our own, a `BootMark` on a connecting screen
 * would render in whatever three colours happened to be set when the splash
 * went away, frozen, forever.
 *
 * Optional at runtime and typed as such: the script is inline in index.html and
 * so is always there in a real page, but a vitest render of a component that
 * happens to contain this has no <head> at all.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { BootMarkArt } from "./BootMarkArt.js";
// For the `Window.__dispatchBootMark` declaration, which lives with the module
// that owns the splash's lifetime.
import "../../lib/bootSplash.js";

/** Default box. Bigger than the 48px icon chips it replaces, because the mark is
 *  a strip that moves rather than a glyph that sits, and it needs the room. */
const DEFAULT_SIZE = 72;

/** The loop's period, from `--boot-beat`. Duplicated because CSS cannot hand a
 *  number to JS, and pinned against index.html by bootMarkPhase.test.ts. */
const PERIOD_MS = 2_400;

export function BootMark({ size = DEFAULT_SIZE }: { size?: number }) {
  useEffect(() => window.__dispatchBootMark?.hold(), []);

  const host = useRef<HTMLDivElement>(null);

  /*
   * JOIN THE LOOP ALREADY IN PROGRESS.
   *
   * A negative `animation-delay` starts an animation partway through, and the
   * part to skip is however far into the current cycle the document already is.
   * With it, this mark's 0% and the splash's are the same instant — which is
   * what the colour rotation's whole schedule assumes, since it reads the phase
   * off `performance.now()` and dyes each piece during a window in which that
   * piece is off screen. Without it every tick lands somewhere arbitrary in this
   * mark's cycle and you watch the mark change colour.
   *
   * `useLayoutEffect`, so the correction is in before the first paint rather
   * than a frame of the wrong phase after it.
   *
   * ON MOUNT AND SIZE ONLY, NEVER ON EVERY RENDER — the dependency array is
   * load-bearing and dropping it would reintroduce the bug it fixes. The delay
   * is measured from the moment the animation STARTED, so re-stamping it later
   * against a start time that has not moved shifts the mark by the difference.
   * Mount is when the animations begin; a size change is when the canvas effect
   * below tears its canvas down, un-hides the SVG and so starts them again.
   *
   * It is read by the rules in index.html, not here: the delay belongs to the
   * animations, which are not ours. `document.timeline` rather than
   * `performance.now()` because it is the clock those animations are on, and on
   * the one browser where they could differ it is the animations that matter.
   */
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const now = Number(document.timeline?.currentTime ?? performance.now());
    el.style.setProperty("--boot-phase", `${-(now % PERIOD_MS)}ms`);
  }, [size]);

  /*
   * THE CANVAS RENDERER, NOT JUST THE SVG.
   *
   * The SVG loop is main-thread-only by construction (see the note at the top
   * of index.html's worker script), and the two screens that show this mark are
   * precisely the two where the main thread is not idle: a connect, and an
   * update whose installer is saturating the disk while the SPA polls through
   * it. Those are wait-of-unknown-length screens, so a frozen mark is worse
   * than no mark — it reads as the app having hung.
   *
   * The canvas is CREATED HERE rather than rendered, because
   * `transferControlToOffscreen` is a one-way door per element: a remount
   * (StrictMode's double-effect, a size change) handing back the same element
   * would throw. A fresh one every time is the only version that is always
   * right. Until the worker has a frame up, `data-canvas` is unset and the SVG
   * is what you are watching — and if there is no worker to be had it stays
   * that way for good.
   */
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const canvas = document.createElement("canvas");
    canvas.className = "boot-mark__canvas";
    canvas.setAttribute("aria-hidden", "true");
    el.appendChild(canvas);
    const handle = window.__dispatchBootMark?.attachCanvas?.(canvas, size, () =>
      el.setAttribute("data-canvas", ""),
    );
    return () => {
      el.removeAttribute("data-canvas");
      handle?.stop();
      canvas.remove();
    };
  }, [size]);

  // The host carries the box, because the SVG leaves the flow once the canvas
  // takes over. `--boot-mark-size` is what `.boot-splash__mark` reads for its
  // own; the splash leaves it unset and gets the 116px default.
  return (
    <div ref={host} className="boot-mark" style={{ width: size, height: size }}>
      <BootMarkArt style={{ ["--boot-mark-size" as string]: `${size}px` }} />
    </div>
  );
}
