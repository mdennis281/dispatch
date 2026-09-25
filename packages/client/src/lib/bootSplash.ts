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
    };
  }
}

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
 * That alignment is what the exact figure is for. The exit molds whatever is on
 * screen into a ball, and a pose is a much better thing to mold than a road
 * half-drawn or a frame mid-slide.
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
export const BOOT_SPLASH_MIN_MS = 3_600;
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
/** Must outlast the exit in index.html: the 420ms mold, the aperture open that
 *  follows it, and the corners of the plate gone by 1000ms. */
export const BOOT_SPLASH_EXIT_MS = 1_080;

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
 */
function afterPaint(fn: () => void): void {
  if (typeof requestAnimationFrame !== "function") return fn();
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
  window.__dispatchBootMark?.releaseSplash();
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
  window.__dispatchBootMark?.releaseSplash();
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

  const check = () => {
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
  const cap = setTimeout(lift, BOOT_SPLASH_MAX_MS);

  // Both stores may already hold the answer: `initializeAuth` can resolve from
  // cache faster than this module is reached, and a subscription only fires on
  // CHANGES.
  check();
}
