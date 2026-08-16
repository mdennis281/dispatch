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
// Whether we're installed is the same question the install card asks, so it
// gets the same answer — including `window-controls-overlay`, which this
// manifest requests FIRST, and iOS's pre-standard `navigator.standalone`. Two
// definitions of "installed" would disagree exactly where it matters.
import { isStandalone } from "../lib/pwaInstall.js";

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
  /**
   * `env(safe-area-inset-top)`. Non-zero means the viewport we were given
   * INCLUDES the status bar — which is what makes the same band missing from
   * `innerHeight` a double charge rather than an honest measurement.
   */
  safeTop: number;
  /** The height the shell is actually laid out at, fallbacks resolved. */
  shell: number;
  /** The physical screen, which nothing should be able to change. */
  screenHeight: number;
}

export function keyboardInset(
  shellHeight: number,
  windowHeight: number,
  vvHeight: number,
  vvOffsetTop: number,
): number {
  // What we want is the gap between the SHELL's bottom and the bottom of the
  // band you can actually see — which is where the shell has to stop. When iOS
  // scrolls the page to reveal the caret it moves that band DOWN the window
  // (`offsetTop`), so the gap below it shrinks by exactly that much; the shell
  // is anchored to the window's top and has scrolled with it.
  //
  // Two viewports, and the order matters. WHETHER anything is down there is a
  // question only the window can answer: `visualViewport` is expressed in
  // layout-viewport terms and can never exceed it, so it is blind to the band
  // the shell recovers BELOW the window and would report that band as covered
  // forever — a permanent phantom keyboard, which reads downstream as "the user
  // is typing" and takes the bottom nav off screen for good.
  const covered = Math.round(windowHeight - vvHeight - vvOffsetTop);
  // A pixel or two is rounding between two viewports, not a keyboard — and it
  // would be amplified into a whole status bar by the line below.
  if (covered <= 2) return 0;
  // Something IS down there, and a keyboard is drawn up from the bottom of the
  // SCREEN — so it covers the recovered band too. `visualViewport` can't see
  // that band, so it has to be added rather than measured.
  return Math.max(0, covered + Math.max(0, Math.round(shellHeight - windowHeight)));
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
  safeTop: 0,
  shell: 0,
  screenHeight: 0,
};

interface ViewportStore extends ViewportMetrics {
  /**
   * The tallest `innerHeight` seen at the current width — the shell's height in
   * a standalone PWA. See `standaloneShellHeight`.
   */
  maxInnerHeight: number;
  debug: boolean;
  toggleDebug: () => void;
  set: (m: ViewportMetrics, maxInnerHeight: number) => void;
}

export const useViewport = create<ViewportStore>((set) => ({
  ...EMPTY,
  maxInnerHeight: 0,
  // Not persisted: this is a "show me what's happening right now" switch, and a
  // diagnostic overlay that survives a reload is one you forget you left on.
  debug: false,
  toggleDebug: () => set((s) => ({ debug: !s.debug })),
  set: (m, maxInnerHeight) => set({ ...m, maxInnerHeight }),
}));

/**
 * How tall the shell should be, given everything seen so far.
 *
 * The iOS standalone bug shrinks `innerHeight` — and `100dvh` with it — by ~59px
 * the first time the keyboard opens, permanently. Nothing recovers it, and the
 * shell can't detect it in the moment because every number it can read moves
 * together. What DOESN'T move is the tallest value seen before the keyboard was
 * ever raised, so that becomes the height and the post-shrink readings are
 * discarded as the lie they are.
 *
 * Returns 0 when there's nothing to correct — the caller then leaves the shell
 * on plain `100dvh`, which is right everywhere the bug isn't.
 *
 * `standalone` decides whether a shrink is a bug at all: in a browser tab it
 * means the URL bar came back, which the shell must FOLLOW or the composer ends
 * up underneath it. Installed, there is no URL bar and nothing that can
 * legitimately take the height, so the same shrink is the WebKit bug.
 *
 * The SECOND correction is the status bar, and it is the one that left the band
 * of dead black under the bottom nav. With `black-translucent`, the web view
 * covers the whole screen and the status bar is described to us as an inset —
 * that is the entire meaning of `env(safe-area-inset-top)` being non-zero. But
 * WebKit also subtracts that same band from `innerHeight`/`100dvh`, so a shell
 * sized in `dvh` and then padded by `safe-area-inset-top` pays for the status
 * bar TWICE: once at the top as padding, once at the bottom as a shell that
 * stops short of the screen. Adding the top inset back is what makes the shell
 * reach the bottom of the display.
 *
 * The evidence for that double-charge is `safeTop` itself, so this is
 * self-limiting rather than a guess about a device: a UA that has already taken
 * the status bar out of the viewport reports a top inset of 0 and gets no
 * correction. `screenHeight` is the sanity check — the recovered band has to
 * actually exist between the window and the panel, or we'd pin the shell taller
 * than the screen and re-create the overflow #60 just removed.
 */
export function standaloneShellHeight(
  standalone: boolean,
  innerHeight: number,
  maxInnerHeight: number,
  safeTop: number,
  screenHeight: number,
): number {
  if (!standalone) return 0;
  // A 1-2px wobble is rounding, not the bug, and pinning the shell a pixel
  // taller than the window would make the document scrollable for no reason.
  const shrunk = maxInnerHeight - innerHeight > 4;
  const base = shrunk ? maxInnerHeight : innerHeight;
  // `- 2` for the same rounding: these are two independently rounded CSS
  // lengths and an exact-equality gate would fail on a half-pixel.
  const statusBar = safeTop > 0 && screenHeight - base >= safeTop - 2 ? safeTop : 0;
  if (!statusBar) return shrunk ? base : 0;
  return base + statusBar;
}

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
  const safeTopProbe = makeProbe("env(safe-area-inset-top, 0px)");

  const standalone = isStandalone();
  let frame = 0;
  let lastInset = -1;
  let lastVh = -1;
  // Reset per width: a rotation swaps the dimensions, so a portrait maximum is
  // not a landscape one and carrying it over would pin the shell taller than
  // the screen.
  let maxWidth = window.innerWidth;
  let maxInnerHeight = 0;

  const apply = () => {
    // Cancel rather than just forget: the burst loop calls `apply` directly, so
    // clearing the id without cancelling would leave a live rAF nothing is
    // tracking — one that fires after teardown and re-sets `--cm-kb` on a
    // document the app has already left.
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    // iOS scrolls the DOCUMENT to bring the focused caret into view, and it does
    // it whether or not there is anything to scroll — the shell is `fixed`, so
    // what actually moves is the layout viewport out from under it, taking the
    // top bar up behind the status bar and leaving the app looking like it has
    // been dragged. Nothing here is ever legitimately scrolled, so the honest
    // resting position is 0 and we put it back.
    if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);

    const innerHeight = window.innerHeight;
    const vvHeight = vv?.height ?? innerHeight;
    const vvOffsetTop = vv?.offsetTop ?? 0;
    const dvh = Math.round(dvhProbe.getBoundingClientRect().height);
    const safeTop = Math.round(safeTopProbe.getBoundingClientRect().height);

    if (window.innerWidth !== maxWidth) {
      maxWidth = window.innerWidth;
      maxInnerHeight = 0;
    }
    maxInnerHeight = Math.max(maxInnerHeight, innerHeight);

    // `--cm-vh` is the shell's height, and it is DELIBERATELY absent unless the
    // window has demonstrably shrunk under us: `height: var(--cm-vh, 100dvh)`
    // then falls back to the unit that is correct everywhere the bug isn't.
    const vh = standaloneShellHeight(
      standalone,
      innerHeight,
      maxInnerHeight,
      safeTop,
      window.screen.height,
    );
    // What the shell is ACTUALLY laid out at — the CSS fallback resolved here,
    // because that is the edge the keyboard has to be measured against.
    const inset = keyboardInset(vh || dvh || innerHeight, innerHeight, vvHeight, vvOffsetTop);
    if (vh !== lastVh) {
      lastVh = vh;
      if (vh > 0) document.documentElement.style.setProperty("--cm-vh", `${vh}px`);
      else document.documentElement.style.removeProperty("--cm-vh");
    }

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

    useViewport.getState().set(
      {
        inset: lastInset < 0 ? inset : lastInset,
        innerHeight,
        vvHeight: Math.round(vvHeight),
        vvOffsetTop: Math.round(vvOffsetTop),
        vvScale: vv?.scale ?? 1,
        clientHeight: document.documentElement.clientHeight,
        dvh,
        safeBottom: Math.round(safeProbe.getBoundingClientRect().height),
        safeTop,
        shell: vh || dvh || innerHeight,
        screenHeight: window.screen.height,
      },
      maxInnerHeight,
    );
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
  // Not for the metrics — this is how the scroll reset above gets a chance to
  // run at all. iOS's focus scroll fires no resize, so without this the shell
  // sits displaced until something else happens to schedule a frame.
  window.addEventListener("scroll", schedule, { passive: true });
  document.addEventListener("focusin", scheduleBurst);
  document.addEventListener("focusout", scheduleBurst);

  return () => {
    if (frame) cancelAnimationFrame(frame);
    if (burstFrame) cancelAnimationFrame(burstFrame);
    vv?.removeEventListener("resize", schedule);
    vv?.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("orientationchange", schedule);
    window.removeEventListener("scroll", schedule);
    document.removeEventListener("focusin", scheduleBurst);
    document.removeEventListener("focusout", scheduleBurst);
    dvhProbe.remove();
    safeProbe.remove();
    safeTopProbe.remove();
    document.documentElement.style.removeProperty("--cm-kb");
    document.documentElement.style.removeProperty("--cm-vh");
  };
}
