/**
 * The live truth about how big the window actually is.
 *
 * Every number a mobile browser gives you about its own size disagrees with the
 * others while a soft keyboard is up, and on iOS some of them disagree even
 * after it's gone. This store reads all of them, derives the one the shell
 * cares about (`inset` — how much is covered), publishes it as `--cm-kb`, and
 * keeps the raw readings so `ViewportDebug` can put them on screen. There is no
 * remote Web Inspector for an iPhone from Windows, so an on-screen readout is
 * the only way to see these on the device where they misbehave.
 */
import { create } from "zustand";

export interface ViewportMetrics {
  /** What the shell subtracts — see `keyboardInset`. */
  inset: number;
  /** The window, ignoring the keyboard (but tracking mobile Safari's URL bar). */
  innerHeight: number;
  /** The band you can actually see. Shrinks under the keyboard. */
  vvHeight: number;
  /** How far the visible band has been pushed down the window. */
  vvOffsetTop: number;
  vvScale: number;
  /** The LAYOUT viewport — what `position: fixed` resolves against. */
  clientHeight: number;
  /** What `100dvh` currently evaluates to, measured with a probe element. */
  dvh: number;
  /** `env(safe-area-inset-bottom)`, likewise measured rather than guessed. */
  safeBottom: number;
  /** The physical screen, which nothing should be able to change. */
  screenHeight: number;
}

export function keyboardInset(innerHeight: number, vvHeight: number, vvOffsetTop: number): number {
  // What we want is the gap between the window's bottom and the bottom of the
  // band you can actually see — which is where the shell has to stop. When iOS
  // scrolls the page to reveal the caret it moves that band DOWN the window
  // (`offsetTop`), so the gap below it shrinks by exactly that much; the shell
  // is anchored to the window's top and has scrolled with it.
  return Math.max(0, Math.round(innerHeight - vvHeight - vvOffsetTop));
}

const EMPTY: ViewportMetrics = {
  inset: 0,
  innerHeight: 0,
  vvHeight: 0,
  vvOffsetTop: 0,
  vvScale: 1,
  clientHeight: 0,
  dvh: 0,
  safeBottom: 0,
  screenHeight: 0,
};

interface ViewportStore extends ViewportMetrics {
  /** Highest `innerHeight` seen this session — see `ViewportDebug`. */
  maxInnerHeight: number;
  debug: boolean;
  toggleDebug: () => void;
  set: (m: ViewportMetrics) => void;
}

export const useViewport = create<ViewportStore>((set) => ({
  ...EMPTY,
  maxInnerHeight: 0,
  // Not persisted: this is a "show me what's happening right now" switch, and a
  // diagnostic overlay that survives a reload is one you forget you left on.
  debug: false,
  toggleDebug: () => set((s) => ({ debug: !s.debug })),
  set: (m) => set((s) => ({ ...m, maxInnerHeight: Math.max(s.maxInnerHeight, m.innerHeight) })),
}));

/**
 * A hidden element whose only job is to be measured.
 *
 * `100dvh` and `env(safe-area-inset-bottom)` are only readable in CSS —
 * `getComputedStyle` on a custom property hands back the unresolved `env(...)`
 * token, not a length. Laying out a box that IS those values and reading its
 * height is the only way to learn what the engine currently thinks they are,
 * which is exactly the thing in dispute on iOS.
 */
function makeProbe(height: string): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText = `position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;height:${height}`;
  el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el);
  return el;
}

export function startViewportTracking(): () => void {
  const vv = window.visualViewport;
  const dvhProbe = makeProbe("100dvh");
  const safeProbe = makeProbe("env(safe-area-inset-bottom, 0px)");

  let frame = 0;
  let lastInset = -1;

  const apply = () => {
    // Cancel rather than just forget: the burst loop calls `apply` directly, so
    // clearing the id without cancelling would leave a live rAF nothing is
    // tracking — one that fires after teardown and re-sets `--cm-kb` on a
    // document the app has already left.
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    const innerHeight = window.innerHeight;
    const vvHeight = vv?.height ?? innerHeight;
    const vvOffsetTop = vv?.offsetTop ?? 0;
    const inset = keyboardInset(innerHeight, vvHeight, vvOffsetTop);

    if (inset !== lastInset) {
      // Sub-pixel churn during the keyboard animation would otherwise write a
      // new value every frame and, through the shell's height, feed the
      // Composer's ResizeObserver-driven toolbar compaction. Zero is exempt:
      // it's the resting state, and a keyboard that dismissed from 1px would
      // otherwise leave the shell permanently a pixel short.
      if (inset === 0 || Math.abs(inset - lastInset) >= 2) {
        lastInset = inset;
        document.documentElement.style.setProperty("--cm-kb", `${inset}px`);
      }
    }

    useViewport.getState().set({
      inset: lastInset < 0 ? inset : lastInset,
      innerHeight,
      vvHeight: Math.round(vvHeight),
      vvOffsetTop: Math.round(vvOffsetTop),
      vvScale: vv?.scale ?? 1,
      clientHeight: document.documentElement.clientHeight,
      dvh: Math.round(dvhProbe.getBoundingClientRect().height),
      safeBottom: Math.round(safeProbe.getBoundingClientRect().height),
      screenHeight: window.screen.height,
    });
  };

  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(apply);
  };

  /**
   * Sample every frame for a while, rather than once.
   *
   * iOS slides the keyboard in over ~250ms and reports NOTHING during the
   * slide: `visualViewport` fires resize once, early, with a height that is
   * already stale by the time it lands. A single reading taken on focus is a
   * reading of the wrong moment — the shell settles to a size that was true
   * mid-animation and then sits there. Sampling across the whole animation and
   * a little past it is what makes the final value the settled one.
   */
  let burstUntil = 0;
  let burstFrame = 0;
  const burst = () => {
    burstFrame = 0;
    apply();
    if (performance.now() < burstUntil) burstFrame = requestAnimationFrame(burst);
  };
  const scheduleBurst = () => {
    burstUntil = performance.now() + 600;
    if (!burstFrame) burstFrame = requestAnimationFrame(burst);
  };

  apply();
  vv?.addEventListener("resize", schedule);
  vv?.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  document.addEventListener("focusin", scheduleBurst);
  document.addEventListener("focusout", scheduleBurst);

  return () => {
    if (frame) cancelAnimationFrame(frame);
    if (burstFrame) cancelAnimationFrame(burstFrame);
    vv?.removeEventListener("resize", schedule);
    vv?.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("orientationchange", schedule);
    document.removeEventListener("focusin", scheduleBurst);
    document.removeEventListener("focusout", scheduleBurst);
    dvhProbe.remove();
    safeProbe.remove();
    document.documentElement.style.removeProperty("--cm-kb");
  };
}
