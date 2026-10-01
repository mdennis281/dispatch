/**
 * The splash screen you see for the first second of every load.
 *
 * ── Why it lives in index.html and not in React ──────────────────────────────
 *
 * The markup and the stylesheet for this are STATIC, in `index.html` — the SVG
 * block is written there by `scripts/generate-brand.mjs` from the same
 * `dispatchMark.ts` geometry the component uses, and the CSS is hand-written in
 * `<head>`. This module only decides WHEN it goes away.
 *
 * That split is the whole point. A React splash cannot paint until the bundle
 * has been fetched, parsed and mounted, which on a cold load is exactly the
 * window it exists to cover — you would get the browser's blank page, then a
 * splash, then the app: two transitions where there should be one. Markup in the
 * document paints on the FIRST frame, before a byte of JavaScript runs, so the
 * app is never on screen in an unready state and never flashes.
 *
 * It also subsumes the two "Starting Dispatch…" placeholders (`AuthGate`, and
 * `App`'s `setupPending === null` branch). Those still exist and are still
 * correct — they are what you'd see if boot took longer than `MAX_MS` — but in
 * the normal case this covers them, so a load no longer shows a bare grey line
 * of text before the shell appears.
 *
 * ── Why it waits for the data, not just for a timer ──────────────────────────
 *
 * The animation is the loading budget. `MIN_MS` is how long the entrance takes
 * to play out; `isBootReady` is whether the app behind it has something honest
 * to show. We dismiss at the LATER of the two, so the screen the splash uncovers
 * is finished rather than mid-hydrate — and a fast local boot still pays only
 * the animation, because the data is long since in.
 *
 * "SOMETHING HONEST TO SHOW" USED TO MEAN LESS THAN IT DOES. It was: auth has
 * answered, and `/api/setup` has answered. Both are true a long way before the
 * shell has any content — the sidebar's projects, its chats, the attention
 * queue and the runner roster all arrive on the REST snapshot that the WS
 * `hello` triggers, which is a whole round trip later. So the splash lifted onto
 * an empty frame and the app assembled itself in front of you, which is the one
 * thing it exists to prevent. `hydrated` (stores/connection.ts) closes that: it
 * is set at the END of `hydrateFromServer`, once every gating store is filled.
 *
 * Required only where the shell is what comes next. The sign-in form, the
 * unreachable-server diagnosis and the first-run wizard are all finished screens
 * with no snapshot coming — two of them because the socket is not even open —
 * so waiting on one there would wait for `MAX_MS` and then uncover the same
 * screen anyway.
 *
 * The sequence is built for exactly that (see the docblock over the `<style>` in
 * index.html): the mark EXTENDS — one segment is eaten from behind while the
 * next is laid down in front, so a fork becomes a merge becomes a fork without
 * the shape ever losing its width. One — two — one — two, and it loops, so it is
 * the only open-ended part. A fast boot sees a couple of poses, a slow one keeps
 * counting, and neither has to invent a progress bar for a number nobody has.
 *
 * `MIN_MS` and the loop's period over there are set against each other, not
 * separately — see the note on the constant below.
 *
 * `MAX_MS` is the cap that keeps a promise from becoming a hang: past it we
 * uncover whatever is there, which is `ConnectingScreen` or a placeholder — both
 * of which say more about a stuck boot than a logo can.
 */
import { useAuth } from "../stores/auth.js";
import { useSetup } from "../stores/setup.js";
import { useConnection } from "../stores/connection.js";

declare global {
  interface Window {
    /**
     * The splash's colour rotation, set up by the inline script in index.html's
     * <head> — see the comment over it. Declared here rather than next to its
     * only other caller because this module owns the splash's lifetime, and
     * `releaseSplash` is a thing only this module may call.
     *
     * Optional at runtime and typed as such: it is inline in the document and so
     * is always there in a real page, but a vitest render has no <head> at all.
     */
    __dispatchBootMark?: {
      /** Keep the rotation turning until the returned function is called. */
      hold: () => () => void;
      /** Give back the hold the splash itself took when the document was parsed. */
      releaseSplash: () => void;
      /**
       * Subscribe to colour changes; returns an unsubscribe. Set by the
       * rotation and used by the canvas renderer, which is one subscription per
       * MOUNT now that `BootMark` runs it too — so the unsubscribe is not
       * optional tidiness.
       */
      onColour: (fn: (name: string, value: string) => void) => () => void;
      /**
       * Tell the canvas renderer to play the mold.
       *
       * Absent unless the worker actually started — no `OffscreenCanvas`, no
       * worker, reduced motion — in which case the SVG is still on screen and
       * the CSS plays the mold, which is why this is only ever called
       * optionally and nothing branches on it.
       */
      onExit?: () => void;
      /**
       * Terminate the canvas renderer outright, with no animation.
       *
       * Separate from `onExit` because the two answer different questions:
       * `onExit` plays the mold and the worker stops itself when it finishes,
       * while this is for every path that takes the splash down WITHOUT an
       * exit — where nothing would otherwise ever stop the worker's render
       * loop. Absent unless the worker started; see `onExit`.
       */
      stopCanvas?: () => void;
      /**
       * Run the SAME worker renderer on a canvas of your own — what `BootMark`
       * uses, so an in-app mark is not the one animation in the app that stops
       * dead when the main thread is busy.
       *
       * The canvas must be FRESH: `transferControlToOffscreen` is a one-way
       * door per element, so a component that can remount has to create one in
       * its effect rather than render one and hold a ref. `markPx` is the
       * mark's own box; the canvas is sized around it.
       *
       * Returns null when there is no renderer to be had (no worker, no
       * `OffscreenCanvas`, reduced motion), which is the signal to leave the
       * SVG showing — `onReady` is what says the canvas has a frame up.
       */
      attachCanvas?: (
        canvas: HTMLCanvasElement,
        markPx: number,
        onReady?: () => void,
      ) => { stop: () => void } | null;
    };
  }
}

/**
 * Long enough to count to four, and TUNED TO LAND ON A HELD POSE.
 *
 * The loop in index.html is 2400ms and finishes a pose twice per cycle — the ink
 * lands at 43.5% and at 93.5% — so a pose is complete at 0ms (one), 1044ms
 * (two), 2244ms (one) and 3444ms (two). 3.66s puts the dismissal 216ms past that
 * fourth one, by which point its recoil is under a tenth of a pixel and 492ms of
 * the hold is still to run. One, two, one, two, and then it leaves — the whole
 * shape of the thing, seen once.
 *
 * THE FIRST POSE IS AT ZERO, which is new. The mark used to grow out of a lone
 * dot; it now retracts one segment while drawing the next, so it is complete
 * and legible on the very first painted frame and it never stops being a whole
 * mark. Four poses therefore cost three cycles' worth of exchange rather than
 * four, which is what keeps this near where it was after the period went from
 * 2100 to 2400 (see the note on the holds over there).
 *
 * That alignment is what the exact figure is for. The exit molds whatever is on
 * screen into a ball, and a pose is a much better thing to mold than a mark
 * caught halfway through an exchange.
 *
 * The hold's leading edge rather than its middle, deliberately, because the
 * error here is ONE-SIDED. The CSS clock starts when the splash first paints;
 * this timer starts when the bundle gets as far as `startBootSplash()`, which is
 * always LATER and never earlier. So the real dismissal is 3.6s of animation
 * plus however long that took, and sitting early in the hold leaves the rest of
 * it as budget for that rather than half. Past that the strip is drawing
 * again — still perfectly watchable, just not the frame this was aimed at.
 *
 * So: move this number and re-derive it against the schedule in index.html.
 *
 * It is the floor on every reload, but no longer the thing that usually decides:
 * on a real boot the REST snapshot is what the splash is waiting for, and that
 * lands after this does.
 */
export const BOOT_SPLASH_MIN_MS = 3_660;
/**
 * Never hold the app hostage to a boot that isn't coming.
 *
 * Raised from 6s with the readiness gate: the splash now waits for the REST
 * snapshot rather than for two probes, and 6s was inside the range a cold boot
 * of a large install legitimately takes. The cap is meant to catch a boot that
 * is BROKEN, and firing it on one that is merely slow uncovers a shell that is
 * still filling in — which is what this change is fixing.
 */
export const BOOT_SPLASH_MAX_MS = 9_000;
/**
 * How long the boot may go without anything happening before we call it stuck.
 *
 * `MAX_MS` above asks "how long has this taken", which cannot tell a slow boot
 * from a broken one — and that is exactly the confusion this fixes. With auth on
 * a load is SIX serialized round trips before the first row can exist:
 * `/api/auth/status`, the cookie refresh, status again, the ws-ticket, the
 * socket's hello, and only then the REST snapshot. At a 1.2s RTT that is ~10s of
 * entirely healthy boot, so the cap fired on an ordinary bad-signal load and
 * uncovered the empty shell the splash exists to hide.
 *
 * So the cap asks the question that actually separates the two: is anything
 * still MOVING? Every step of the boot writes to one of the three stores the
 * splash subscribes to, so a boot that is progressing cannot be silent and one
 * that is wedged cannot be noisy.
 *
 * Sized against the longest legitimate gap between two of those writes, which is
 * the ws-ticket POST plus the socket upgrade — two round trips with no store
 * update in between, so ~4s on a 2s-RTT link. Five leaves that headroom without
 * making a genuinely dead boot sit around.
 */
export const BOOT_SPLASH_STALL_MS = 5_000;
/**
 * The ceiling that is never extended, however well the boot is progressing.
 *
 * Past this, waiting has stopped being kind: whatever is behind the splash —
 * `ConnectingScreen`, a placeholder — says more about a boot this slow than a
 * logo does.
 */
export const BOOT_SPLASH_HARD_MAX_MS = 25_000;
/** Must outlast the exit in index.html: the 480ms mold, the aperture open that
 *  follows it, and the corners of the plate gone by 1060ms. */
export const BOOT_SPLASH_EXIT_MS = 1_140;

export interface BootState {
  /** `/api/auth/status` has answered, or been guessed at. */
  authReady: boolean;
  /** That answer is a PLACEHOLDER because the server could not be reached. */
  unreachable: boolean;
  /** This install requires a login. */
  authEnabled: boolean;
  /** Somebody is signed in. */
  signedIn: boolean;
  /** `/api/setup` has answered. null = not asked yet. */
  setupPending: boolean | null;
  /** The REST snapshot has landed, so the shell has rows to render. */
  hydrated: boolean;
  /** Dev-only: the offline mock was seeded instead, which is also real content. */
  mockSeeded: boolean;
}

/**
 * Is there a real screen behind the splash yet?
 *
 * A pure predicate, and tested, for the same reason `shouldProbeSetup` is: it
 * gates whether the app is ever revealed, so a wrong boolean here is either a
 * splash that hangs for `MAX_MS` on every load or one that lifts onto a blank
 * frame. Mirrors the branches in `App`/`AuthGate` that decide what renders:
 *
 *   - sign-in form   — auth is on and nobody is signed in. Nothing else will
 *                      load until they are, so waiting on `/api/setup` (which
 *                      401s in this state, and isn't even asked — see
 *                      `shouldProbeSetup`) would wait forever.
 *   - ConnectingScreen — the server is unreachable. Same trap: the setup probe
 *                      is suppressed, so `setupPending` stays null.
 *   - first-run wizard — `/api/setup` said this install has never been set up.
 *                      There is no snapshot coming that would change what it
 *                      looks like; the wizard IS the finished screen.
 *   - the shell      — and this is the one that has to wait for its data. See
 *                      the note in the module docblock: auth and setup both
 *                      answer a full round trip before the sidebar has anything
 *                      in it.
 */
export function isBootReady(s: BootState): boolean {
  if (!s.authReady) return false;
  if (s.authEnabled && !s.signedIn) return true;
  if (s.unreachable) return true;
  if (s.setupPending === null) return false;
  if (s.setupPending) return true;
  return s.hydrated || s.mockSeeded;
}

/**
 * The cap expired. Lift, or wait a little longer?
 *
 * Pure, and tested, for the same reason `isBootReady` is: the two ways to get
 * this wrong are both invisible to anyone on a fast link. Lift too eagerly and
 * the splash uncovers the empty shell it exists to hide; extend without a
 * ceiling and a wedged server pins the app behind a logo forever.
 *
 * `sinceProgress` — how long the three boot stores have been silent — is the
 * whole judgement; see `BOOT_SPLASH_STALL_MS`. `elapsed` runs from the splash's
 * own start, so `HARD_MAX_MS` bounds the entire wait rather than handing out a
 * fresh budget on every extension.
 *
 * Returns the delay to re-arm for, or null to lift now. A re-arm is never longer
 * than the stall window has left to run, so a boot that goes quiet is noticed
 * within `BOOT_SPLASH_STALL_MS` of going quiet rather than at whatever the next
 * deadline happened to be.
 */
export function capExtension(elapsed: number, sinceProgress: number): number | null {
  const stall = BOOT_SPLASH_STALL_MS - sinceProgress;
  if (stall <= 0) return null;
  const remaining = BOOT_SPLASH_HARD_MAX_MS - elapsed;
  return remaining > 0 ? Math.min(stall, remaining) : null;
}

function readBootState(): BootState {
  const auth = useAuth.getState();
  const conn = useConnection.getState();
  return {
    authReady: auth.ready,
    unreachable: auth.unreachable,
    authEnabled: !!auth.status?.enabled,
    signedIn: !!auth.user,
    setupPending: useSetup.getState().pending,
    hydrated: conn.hydrated,
    mockSeeded: conn.mockSeeded,
  };
}

function element(): HTMLElement | null {
  return document.getElementById("boot-splash");
}

/**
 * Run `fn` once the browser has painted a frame with the current DOM in it.
 *
 * TWO FRAMES, not one, and that is the whole point. The store update that makes
 * `isBootReady` true is synchronous; React's render of it is not. One `rAF`
 * lands in the frame that is about to be composited — before React has even
 * committed — so the aperture would open on the previous frame's contents. The
 * second fires after that commit has been painted, which is the first moment
 * "the app is on screen behind this" is a true statement.
 *
 * Costs ~32ms on top of a 3.6s minimum, which is nothing, and it is what stops
 * the very last thing you see being the shell popping in.
 *
 * NOT WHILE THE DOCUMENT IS HIDDEN. `rAF` is SUSPENDED in a background tab
 * rather than throttled the way `setTimeout` is — there is no repaint to
 * schedule a callback against, so the two hops here simply never run. Boot
 * Dispatch in a tab that never gets focus (a restored session, a middle-clicked
 * link) and the splash would sit there indefinitely, straight through the
 * `MAX_MS` cap that exists to make exactly that impossible.
 *
 * So a hidden document skips the wait outright, which is also the honest answer:
 * the reason to wait is that somebody is about to watch the aperture open, and
 * nobody is. The exit still plays, off its own timers, whenever the tab comes
 * back — or it has long since finished and been removed.
 */
function afterPaint(fn: () => void): void {
  if (typeof requestAnimationFrame !== "function") return fn();
  if (typeof document !== "undefined" && document.hidden) return fn();
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

/**
 * Play the exit: whatever pose the strip is holding molds into a ball, and the
 * ball opens into an aperture that the app is behind. See the exit note in the
 * docblock over the `<style>` in index.html — the mold is a scale rather than
 * the dots converging, because the pose and the frame's offset both depend on
 * where in the loop this interrupted.
 *
 * The `boot-reveal` class is added to `#root` at THIS moment rather than being
 * on it from the start, so a bundle that throws before reaching this line
 * leaves the app fully opaque behind the splash instead of permanently
 * invisible under one that never lifts.
 *
 * The colour rotation's hold goes back here too. It is what keeps `--c-ball`
 * moving, and the ball is dyed from whatever it last held — so this must come
 * AFTER `data-done` is set, or the ticks get one more turn and the ball can wear
 * a colour the strip never drew.
 */
function dismiss(el: HTMLElement): void {
  if (el.hasAttribute("data-done")) return;
  el.setAttribute("data-done", "");
  // Before the hold is released, so the mold is drawn in the colours the loop
  // was actually wearing rather than whatever the last tick left behind.
  window.__dispatchBootMark?.onExit?.();
  window.__dispatchBootMark?.releaseSplash();
  document.getElementById("root")?.classList.add("boot-reveal");
  setTimeout(() => {
    el.remove();
    document.getElementById("root")?.classList.remove("boot-reveal");
    // Belt and braces: the worker ends its own loop when the mold finishes, so
    // this only bites if the exit never got that far — a `data-done` that raced
    // the worker's startup, say.
    window.__dispatchBootMark?.stopCanvas?.();
  }, BOOT_SPLASH_EXIT_MS);
}

/**
 * Take the splash down NOW, with no animation.
 *
 * For the standalone renders — the detached log window, the trace viewer, the
 * mission preview — which load this same `index.html` and therefore inherit its
 * splash, but are tool windows rather than the app booting. There is nothing to
 * wait for and nothing to make an entrance about.
 */
export function dismissBootSplashNow(): void {
  window.__dispatchBootMark?.releaseSplash();
  // There is no exit here, so nothing else will ever stop the canvas renderer.
  // These windows keep the document open for hours — a log popup is the whole
  // point of the detached window — and an orphaned worker would go on drawing a
  // removed canvas at 60fps for every one of them.
  window.__dispatchBootMark?.stopCanvas?.();
  element()?.remove();
}

/**
 * Hold the splash until the app is ready, then lift it.
 *
 * Safe to call before the stores have hydrated — it subscribes and re-checks.
 */
export function startBootSplash(): void {
  const el = element();
  if (!el) return;

  // With reduced motion the entrance is suppressed by the stylesheet, so there
  // is no animation to wait out — only the data. `MIN_MS` would be a second and
  // a half of a static logo, which is the definition of a pointless delay.
  const reduced =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const minMs = reduced ? 0 : BOOT_SPLASH_MIN_MS;

  const startedAt = performance.now();
  let scheduled = false;

  const lift = () => {
    if (scheduled) return;
    scheduled = true;
    unsubscribe();
    clearTimeout(cap);
    setTimeout(
      () => afterPaint(() => dismiss(el)),
      Math.max(0, minMs - (performance.now() - startedAt)),
    );
  };

  // Any write to the three stores subscribed below is the boot making progress:
  // no step of it advances without one. The cap reads this to tell "slow" from
  // "stuck" — see `capExtension`.
  let progressAt = startedAt;

  const check = () => {
    progressAt = performance.now();
    if (isBootReady(readBootState())) lift();
  };

  // `useConnection` is in here because the REST snapshot is now part of the
  // answer — see `isBootReady`. Without it the splash would sit until `MAX_MS`
  // on every load that got its hydrate after the setup probe, which is all of
  // them.
  const stops = [useAuth.subscribe(check), useSetup.subscribe(check), useConnection.subscribe(check)];
  const unsubscribe = () => {
    for (const stop of stops) stop();
  };

  // `MAX_MS` measured from boot, not from readiness — it is the ceiling on the
  // whole splash, and `lift()` short-circuits once it has already fired.
  //
  // It is EXTENDED, not simply enforced: expiring while the boot is still
  // visibly advancing uncovers an app that is seconds from being ready, which is
  // strictly worse than waiting those seconds out. `capExtension` owns that
  // judgement and `BOOT_SPLASH_HARD_MAX_MS` bounds it either way.
  let cap = setTimeout(function expire() {
    const now = performance.now();
    const again = capExtension(now - startedAt, now - progressAt);
    if (again === null) return lift();
    cap = setTimeout(expire, again);
  }, BOOT_SPLASH_MAX_MS);

  // Both stores may already hold the answer: `initializeAuth` can resolve from
  // cache faster than this module is reached, and a subscription only fires on
  // CHANGES.
  check();
}
