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
  /**
   * `env(safe-area-inset-bottom)`, likewise measured rather than guessed.
   *
   * Careful: iOS reports the insets against the SCREEN, and in an installed PWA
   * the layout viewport can be ~59px shorter than the screen. When it is, the
   * home indicator this describes is below the viewport entirely and the 34px
   * is clearing something that isn't there. `screenHeight - clientHeight` is
   * how you tell. See docs/ios-pwa-viewport-findings.md §1.2.
   */
  safeBottom: number;
  /**
   * `env(safe-area-inset-top)` — how much of the top of the viewport the status
   * bar covers, which is what a top bar has to pad around. It describes the
   * SCREEN, not the (possibly shrunk) layout viewport: see `safeBottom`.
   */
  safeTop: number;
  /** The height the shell is actually laid out at, fallbacks resolved. */
  shell: number;
  /**
   * Where the shell's bottom edge actually LANDS, read off the element.
   *
   * `shell` above is arithmetic — the same expression that sets the height — so
   * a readout derived from it can only ever confirm that the formula ran. That
   * is how four PRs shipped against a `dead` of 0 while the bar was visibly
   * wrong. This one is `getBoundingClientRect().bottom` on the real box, so it
   * disagrees whenever the box does not get the height it asked for.
   */
  shellBottom: number;
  /** The physical screen, which nothing should be able to change. */
  screenHeight: number;
}

export function keyboardInset(
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
  // The shell IS the window (`height: 100dvh`), so this is the whole story.
  // There used to be a second term adding back however much the shell had been
  // pinned ABOVE the window height, on the theory that the keyboard covers that
  // recovered band too — it went with the pinning that created the band. See
  // docs/ios-pwa-viewport-findings.md.
  const covered = Math.round(windowHeight - vvHeight - vvOffsetTop);
  // A pixel or two is rounding between two viewports, not a keyboard.
  if (covered <= 2) return 0;
  return Math.max(0, covered);
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
  shellBottom: 0,
  screenHeight: 0,
};

interface ViewportStore extends ViewportMetrics {
  /**
   * The tallest `innerHeight` seen at the current width. DIAGNOSTIC ONLY — the
   * readout shows `inner` against it so the iOS standalone shrink is visible as
   * it happens.
   *
   * It used to SIZE the shell, which is what cut the bottom off every window
   * you made shorter: an installed desktop PWA is `standalone` too, and
   * dragging the bottom edge up leaves the width — and therefore this maximum —
   * untouched, so the shell stayed pinned at the height you no longer had.
   */
  maxInnerHeight: number;
  /** How the shrink heal is going — see `healViewport`. Diagnostic. */
  heal: HealStats;
  debug: boolean;
  toggleDebug: () => void;
  set: (m: ViewportMetrics, maxInnerHeight: number, heal: HealStats) => void;
}

export interface HealStats {
  /** Times the display toggle was run. */
  attempts: number;
  /** Times the window grew back afterwards. */
  wins: number;
  /** What the most recent attempt did — "" before any has run. */
  last: "" | "ok" | "miss";
}

const NO_HEALS: HealStats = { attempts: 0, wins: 0, last: "" };

export const useViewport = create<ViewportStore>((set) => ({
  ...EMPTY,
  maxInnerHeight: 0,
  heal: NO_HEALS,
  // Not persisted: this is a "show me what's happening right now" switch, and a
  // diagnostic overlay that survives a reload is one you forget you left on.
  debug: false,
  toggleDebug: () => set((s) => ({ debug: !s.debug })),
  set: (m, maxInnerHeight, heal) => set({ ...m, maxInnerHeight, heal }),
}));

/**
 * Is the window shorter than the screen for no reason we can see?
 *
 * The iOS standalone shrink (docs/ios-pwa-viewport-findings.md §1.1) leaves the
 * layout viewport ~59px short of the glass with NO keyboard up — `innerHeight`,
 * `visualViewport.height` and `100dvh` all agree on the short number, so the
 * only thing left that still knows the true height is `screen.height`. A
 * keyboard also makes the window look short, but it shows up as a visual
 * viewport smaller than the window (`keyboardInset`) or pushed down it
 * (`offsetTop`), and both of those mean "wait", not "heal".
 *
 * Pure so it can be pinned in tests; the caller is responsible for only asking
 * on a platform where a short window is a bug rather than a URL bar.
 */
export function viewportShrunk(
  innerHeight: number,
  vvHeight: number,
  vvOffsetTop: number,
  screenHeight: number,
): boolean {
  if (keyboardInset(innerHeight, vvHeight, vvOffsetTop) !== 0) return false;
  if (Math.round(vvOffsetTop) !== 0) return false;
  // A pixel or two is rounding; the shrink is a status bar.
  return screenHeight - innerHeight >= 4;
}

/**
 * Only an installed iOS app has a window that is short of the screen by
 * mistake. A Safari tab is short by the URL bar, an installed DESKTOP window is
 * whatever size it was dragged to, and Android's `screen.height` counts the
 * system bars — on every one of those a heal would toggle the whole app off
 * and on for nothing, forever.
 */
function isStandaloneIOS(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  const ios =
    /iP(hone|ad|od)/.test(nav.userAgent) ||
    // iPadOS asks for the desktop site and calls itself a Mac; the touch
    // points give it away.
    (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
  const standalone =
    nav.standalone === true ||
    (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches);
  return ios && standalone;
}

/**
 * Make WebKit re-measure the window.
 *
 * After the first soft-keyboard raise an installed iOS app's layout viewport
 * shrinks by the status bar's height and stays that way for the life of the
 * process — nothing the page does with `scrollTo`, `visualViewport` or the
 * viewport meta gets it back, and everything past the short edge is simply
 * never painted, so the bottom nav sat ~59px above the home indicator with a
 * black band under it. What DOES get it back is a full-viewport-height element
 * leaving and rejoining layout: WebKit recomputes the viewport on the way back
 * and hands the missing band over. (Found by the author of the write-up linked
 * from docs/ios-pwa-viewport-findings.md, who noticed a route change in their
 * SPA snapped the window back; this is the same recompute without the
 * navigation.) The flip is synchronous, so no frame is painted without the
 * app in it.
 *
 * `display: none` throws away every scroll position under it, so those are put
 * back by hand — the chat you were reading must not jump to the top because
 * the keyboard went away.
 *
 * Whether it WORKED cannot be read here: the new height arrives from the UI
 * process a frame or two later. The caller watches `innerHeight` afterwards.
 */
function healViewport(root: HTMLElement): void {
  const scrolled: Array<[Element, number, number]> = [];
  for (const el of root.querySelectorAll("*")) {
    if (el.scrollTop || el.scrollLeft) scrolled.push([el, el.scrollTop, el.scrollLeft]);
  }
  const was = root.style.display;
  root.style.display = "none";
  // Force the layout that makes the element actually leave; without it the two
  // writes collapse into no change at all.
  void root.offsetHeight;
  root.style.display = was;
  for (const [el, top, left] of scrolled) {
    el.scrollTop = top;
    el.scrollLeft = left;
  }
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

  let frame = 0;
  let lastInset = -1;
  // Diagnostic only — nothing is SIZED from this any more (see the note on
  // `maxInnerHeight`). Reset per width so a rotation's portrait maximum isn't
  // reported against a landscape window.
  let maxWidth = window.innerWidth;
  let maxInnerHeight = 0;
  // Cached: `apply` runs every frame for 600ms after each focus change, and a
  // `querySelector` per frame is a real cost paid by every user for a number
  // only the debug readout reads. `isConnected` is the re-lookup trigger — the
  // shell unmounts and remounts across an auth gate, and a stale detached node
  // measures 0 forever.
  let shellEl: Element | null = null;
  const shellRect = (): number => {
    if (!shellEl?.isConnected) shellEl = document.querySelector("[data-cm-shell]");
    return shellEl ? Math.round(shellEl.getBoundingClientRect().bottom) : 0;
  };

  const healable = isStandaloneIOS();
  let heal: HealStats = NO_HEALS;
  // The window height the last heal was trying to grow, or -1 with none
  // outstanding. Compared against every subsequent reading: the moment the
  // window is taller than this, the heal took.
  let healFrom = -1;
  // When focus last moved. The heal must not run while the keyboard is still
  // sliding away — the visual viewport reports its final height early, so
  // `inset` reads 0 before the retraction finishes, and a re-measure taken
  // mid-slide can settle on a mid-slide number.
  let focusChangedAt = 0;
  const HEAL_SETTLE_MS = 140;

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

    if (healFrom >= 0 && innerHeight > healFrom) {
      healFrom = -1;
      heal = { ...heal, wins: heal.wins + 1, last: "ok" };
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
        shell: dvh || innerHeight,
        // Read, not derived — see `shellBottom`. Absent element (first frame,
        // or a test that never mounts App) reports 0 rather than a fake edge.
        shellBottom: shellRect(),
        screenHeight: window.screen.height,
      },
      maxInnerHeight,
      heal,
    );
  };

  /**
   * Run the heal if this frame is one it can be trusted on. Called from the
   * burst so it sees a settled reading, never from a lone frame.
   */
  const maybeHeal = () => {
    if (!healable || healFrom >= 0) return;
    // Three misses and never a hit means this is not the bug we know, and a
    // reflow of the entire app on every blur is not a price worth paying to
    // keep checking.
    if (heal.wins === 0 && heal.attempts >= 3) return;
    if (performance.now() - focusChangedAt < HEAL_SETTLE_MS) return;
    // A field still focused means the keyboard is up or on its way — the
    // short window is the keyboard's, and healing under it would re-measure
    // a window we are about to lose anyway.
    const active = document.activeElement;
    if (active && active !== document.body && active.matches("input, textarea, [contenteditable]")) return;
    const innerHeight = window.innerHeight;
    if (!viewportShrunk(innerHeight, vv?.height ?? innerHeight, vv?.offsetTop ?? 0, window.screen.height)) return;
    const root = document.getElementById("root");
    if (!root) return;
    healFrom = innerHeight;
    heal = { ...heal, attempts: heal.attempts + 1, last: "miss" };
    healViewport(root);
    // Keep sampling: the grown window lands a frame or two out, and `apply`
    // has to see it to publish the new `--cm-kb` baseline and score the heal.
    burstUntil = Math.max(burstUntil, performance.now() + 600);
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
    maybeHeal();
    if (performance.now() < burstUntil) {
      burstFrame = requestAnimationFrame(burst);
    } else if (healFrom >= 0) {
      // The burst ran out without the window growing: that attempt missed.
      healFrom = -1;
    }
  };
  const scheduleBurst = () => {
    burstUntil = performance.now() + 600;
    if (!burstFrame) burstFrame = requestAnimationFrame(burst);
  };
  const onFocusChange = () => {
    focusChangedAt = performance.now();
    scheduleBurst();
  };

  apply();
  // The shrink is sticky across relaunches too — quit and reopen without
  // force-quitting and the app cold-starts into a window that is already
  // short. One burst on start gives the heal a look at that case; it is a
  // no-op when the window is already the screen.
  const startupBurst = window.setTimeout(scheduleBurst, 400);
  vv?.addEventListener("resize", schedule);
  vv?.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  // Not for the metrics — this is how the scroll reset above gets a chance to
  // run at all. iOS's focus scroll fires no resize, so without this the shell
  // sits displaced until something else happens to schedule a frame.
  window.addEventListener("scroll", schedule, { passive: true });
  document.addEventListener("focusin", onFocusChange);
  document.addEventListener("focusout", onFocusChange);

  return () => {
    clearTimeout(startupBurst);
    if (frame) cancelAnimationFrame(frame);
    if (burstFrame) cancelAnimationFrame(burstFrame);
    vv?.removeEventListener("resize", schedule);
    vv?.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("orientationchange", schedule);
    window.removeEventListener("scroll", schedule);
    document.removeEventListener("focusin", onFocusChange);
    document.removeEventListener("focusout", onFocusChange);
    dvhProbe.remove();
    safeProbe.remove();
    safeTopProbe.remove();
    document.documentElement.style.removeProperty("--cm-kb");
  };
}
