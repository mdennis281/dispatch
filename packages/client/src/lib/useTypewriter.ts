import { useEffect, useRef, useState } from "react";

/**
 * Display-only "typewriter" for live-streaming text. Given the append-only
 * buffer `target`, returns a substring that trails slightly behind and catches
 * up at a rate PROPORTIONAL to how fast new text is arriving — a first-order
 * (exponential) tracker whose steady-state reveal speed equals the incoming
 * speed. So a fast burst types fast, a slow trickle types slowly, and the trail
 * stays subtle either way.
 *
 * Only NEWLY-arrived characters animate: whatever is already present when the
 * hook mounts (e.g. opening a chat mid-reply, or a reconnect that replays a
 * long buffer) shows instantly, so it never crawls through a backlog. It is
 * purely visual — it never gates or slows the underlying stream.
 */

const TAU = 0.08; // s — reveal time-constant; smaller = tighter (more subtle) trail
const MIN_CPS = 120; // chars/s floor so a slow trickle's last chars don't crawl
const MAX_LAG = 280; // cap the trailing backlog so a big jump animates only its tail
const SNAP = 0.5; // within this many chars of the end → snap to complete

export function useTypewriter(target: string): string {
  const [count, setCount] = useState(target.length);
  const targetRef = useRef(target);
  const prevRef = useRef(target);
  const posRef = useRef(target.length);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef(0);

  // Always read the freshest target from inside the rAF loop.
  targetRef.current = target;

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = target;

    // Non-append change (a new/replaced/shorter buffer) → snap; never rewind.
    if (!target.startsWith(prev)) {
      posRef.current = target.length;
      setCount(target.length);
      return;
    }
    // Bound the backlog so a large jump animates only its tail, not a long crawl.
    if (target.length - posRef.current > MAX_LAG) {
      posRef.current = target.length - MAX_LAG;
    }
    if (rafRef.current !== null) return; // a loop is already catching up
    if (posRef.current >= target.length) return; // nothing new to reveal

    lastRef.current = 0;
    const step = (t: number) => {
      const len = targetRef.current.length;
      const prevT = lastRef.current;
      lastRef.current = t;
      // Clamp dt so a backgrounded tab (huge gap) doesn't reveal in one leap.
      const dt = prevT === 0 ? 0.016 : Math.min((t - prevT) / 1000, 0.05);
      const gap = len - posRef.current;
      if (gap <= 0) {
        rafRef.current = null;
        return;
      }
      const reveal = Math.max(gap * (1 - Math.exp(-dt / TAU)), MIN_CPS * dt);
      posRef.current = Math.min(len, posRef.current + reveal);
      if (len - posRef.current < SNAP) posRef.current = len;
      setCount(Math.floor(posRef.current));
      rafRef.current = posRef.current < len ? requestAnimationFrame(step) : null;
    };
    rafRef.current = requestAnimationFrame(step);
  }, [target]);

  // Stop the loop if the row unmounts mid-catch-up.
  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    },
    [],
  );

  return count >= target.length ? target : target.slice(0, count);
}
