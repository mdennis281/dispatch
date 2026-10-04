import { useLayoutEffect, useRef, type RefObject } from "react";

/** How long the arriving surface takes to settle. */
export const SWAP_MS = 180;
/** Matches `--ease-out` in index.css. */
const EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/**
 * The arrival itself, split out from the hook so it is testable in the client's
 * node-environment suite (which renders no JSX and has no DOM).
 *
 * `opacity` + `scale` only — both composited, so 757 chat rows underneath cost
 * nothing. The surface as ONE box; see the note about per-row staggering in
 * App.tsx.
 */
export function swapArrival(from: number): {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
} {
  return {
    keyframes: [
      { opacity: 0, transform: `scale(${from})` },
      { opacity: 1, transform: "scale(1)" },
    ],
    // `fill: none` so a finished arrival leaves no inline transform behind on a
    // box that other things (the drawers) position against.
    options: { duration: SWAP_MS, easing: EASING, fill: "none" },
  };
}

/** Whether this commit should play one. Pure, for the same reason. */
export function shouldSwap(
  prev: unknown,
  next: unknown,
  reduceMotion: boolean,
): boolean {
  // Equal tokens covers the first commit too (the hook seeds prev with token),
  // which is the app appearing — already covered by the boot splash.
  return prev !== next && !reduceMotion;
}

/**
 * A short arrival played on a whole surface when the app swaps one for another.
 *
 * This exists for the full-bleed views (home, new-project). They replace the
 * sidebar AND the entire main area in a single commit, so arriving — and
 * leaving — used to be a hard cut of every pixel under the top bar, which reads
 * as a glitch rather than as navigation.
 *
 * Deliberately NOT gated on load state. `/api/home` serves from cache in ~4ms,
 * so anything keyed on fetching is over before the eye catches it — which is
 * exactly why the refresh spinner there is never seen. This is keyed on the
 * NAVIGATION: it plays whenever `token` changes, however fast the data was.
 *
 * Web Animations rather than a CSS class because the animation has to RESTART
 * on every crossing. A class can't: re-adding a name the element already has is
 * a no-op, so it needs a remount (throws away transcript scroll and the mounted
 * right panel) or an off/reflow/on dance. `el.animate()` just plays again.
 */
export function useSurfaceSwap(
  ref: RefObject<HTMLElement | null>,
  token: unknown,
  /** Scale the surface starts at. <1 arrives forward, >1 settles back. */
  from: number,
): void {
  const prev = useRef<unknown>(token);
  // The in-flight animation, so a second crossing mid-flight replaces the first
  // instead of fighting it — tabbing home/back/home leaves no stuck opacity.
  const playing = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const was = prev.current;
    prev.current = token;

    const el = ref.current;
    if (!el || typeof el.animate !== "function") return;
    const reduce =
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!shouldSwap(was, token, reduce)) return;

    playing.current?.cancel();
    const { keyframes, options } = swapArrival(from);
    const done = el.animate(keyframes, options);
    playing.current = done;
    // Clearing the handle on finish keeps a later cancel() from touching a
    // finished animation whose `transform` is no longer ours.
    done.addEventListener("finish", () => {
      if (playing.current === done) playing.current = null;
    });
  }, [ref, token, from]);

  useLayoutEffect(() => () => playing.current?.cancel(), []);
}
