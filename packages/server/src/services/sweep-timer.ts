/**
 * The real timer pair behind the background poll loops: the issue watcher, the
 * schedule runner and the PR review watcher. Each takes `setTimer`/`clearTimer`
 * as options so its tests can drive ticks by hand, and falls back to these.
 *
 * Unref'd because a background sweep must never hold the process open on its
 * own: shutdown would then wait out a tick nobody is going to act on.
 */
export function setSweepTimer(fn: () => void, ms: number): unknown {
  const t = setInterval(fn, ms);
  t.unref?.();
  return t;
}

export function clearSweepTimer(handle: unknown): void {
  clearInterval(handle as ReturnType<typeof setInterval>);
}
