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
 * The sequence is built for exactly that (see the docblock over the `<style>` in
 * index.html): the mark EXTENDS — a fork's roads undraw into its two leading
 * dots, the frame slides on, and new roads draw out of them into a merge, which
 * is the mark mirrored. One — two — one — two, and it loops, so it is the only
 * open-ended part. A fast boot sees a couple of poses, a slow one keeps
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

/**
 * Long enough to count to four, and TUNED TO LAND ON A HELD POSE.
 *
 * The loop in index.html is 2100ms and holds a pose twice per cycle — 20.57–32%
 * and 70.57–82% — so a pose is fully drawn and the frame has stopped at 432ms
 * (one), 1482ms (two), 2532ms (one) and 3582ms (two). 3.6s puts the dismissal
 * 18ms into that fourth one, with 222ms of it still to run. One, two, one, two,
 * and then it leaves — the whole shape of the thing, seen once.
 *
 * This went UP, from 3.05s, when the draw was slowed by half: four poses take
 * as long as they take, and the alternative was to cut the sequence at three
 * and never show the second mirror. It is a shade over the 3.4s the previous
 * splash held for, so the floor on a reload is not new — but it is the number to
 * challenge first if this ever feels long.
 *
 * That alignment is what the exact figure is for. The exit
 * collapses whatever is on screen into a single dot, and a pose is a much better
 * thing to collapse than a road half-drawn or a frame mid-slide.
 *
 * The hold's leading edge rather than its middle, deliberately, because the
 * error here is ONE-SIDED. The CSS clock starts when the splash first paints;
 * this timer starts when the bundle gets as far as `startBootSplash()`, which is
 * always LATER and never earlier. So the real dismissal is 3.05s of animation
 * plus however long that took, and sitting early in the hold leaves the rest of
 * it as budget for that rather than half. Past that the strip is drawing
 * again — still perfectly watchable, just not the frame this was aimed at.
 *
 * So: move this number and re-derive it against the schedule in index.html.
 *
 * It is also the floor on every single reload, which is the other reason to keep
 * it honest: three seconds is already the largest thing in this file.
 */
export const BOOT_SPLASH_MIN_MS = 3_600;
/** Never hold the app hostage to a boot that isn't coming. */
export const BOOT_SPLASH_MAX_MS = 6_000;
/** Must outlast the exit in index.html — the 320ms shrink, the plate cleared
 *  behind it by 560ms, and #root faded up at 660ms. */
export const BOOT_SPLASH_EXIT_MS = 700;

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
 *   - wizard or shell — `/api/setup` has answered.
 */
export function isBootReady(s: BootState): boolean {
  if (!s.authReady) return false;
  if (s.authEnabled && !s.signedIn) return true;
  if (s.unreachable) return true;
  return s.setupPending !== null;
}

function readBootState(): BootState {
  const auth = useAuth.getState();
  return {
    authReady: auth.ready,
    unreachable: auth.unreachable,
    authEnabled: !!auth.status?.enabled,
    signedIn: !!auth.user,
    setupPending: useSetup.getState().pending,
  };
}

function element(): HTMLElement | null {
  return document.getElementById("boot-splash");
}

/**
 * Play the exit: whatever pose the strip is holding shrinks into the centre of
 * the view box, and then the plate clears behind it and the app is there. See
 * `.boot-splash__collapse` in index.html — it is a scale rather than anything
 * converging, because the pose and the frame's offset both depend on where in
 * the loop this interrupted.
 *
 * The `boot-reveal` class is added to `#root` at THIS moment rather than being
 * on it from the start, so a bundle that throws before reaching this line
 * leaves the app fully opaque behind the splash instead of permanently
 * invisible under one that never lifts.
 */
function dismiss(el: HTMLElement): void {
  if (el.hasAttribute("data-done")) return;
  el.setAttribute("data-done", "");
  document.getElementById("root")?.classList.add("boot-reveal");
  setTimeout(() => {
    el.remove();
    document.getElementById("root")?.classList.remove("boot-reveal");
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
    setTimeout(() => dismiss(el), Math.max(0, minMs - (performance.now() - startedAt)));
  };

  const check = () => {
    if (isBootReady(readBootState())) lift();
  };

  const stops = [useAuth.subscribe(check), useSetup.subscribe(check)];
  const unsubscribe = () => {
    for (const stop of stops) stop();
  };

  // `MAX_MS` measured from boot, not from readiness — it is the ceiling on the
  // whole splash, and `lift()` short-circuits once it has already fired.
  const cap = setTimeout(lift, BOOT_SPLASH_MAX_MS);

  // Both stores may already hold the answer: `initializeAuth` can resolve from
  // cache faster than this module is reached, and a subscription only fires on
  // CHANGES.
  check();
}
