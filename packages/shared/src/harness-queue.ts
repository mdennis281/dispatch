/**
 * The push side of a harness session's `events` stream: producers `push`, one
 * consumer pulls with `next()`, and a pull on an empty queue parks until
 * something arrives or the stream `end`s.
 *
 * The Claude, Codex and goose sessions each carried this as three private
 * fields and two methods, copied line for line. That queue sits under every
 * chat's event stream, and a lost wake-up there doesn't throw. The turn just
 * stops moving, so one tested copy is worth more than three that drift. Each
 * session still owns its `next()`: Codex adds a turn-end hand-off, and Claude
 * races a pull from the SDK against `wait()`. That is why `shift`/`wait`/`wake`
 * are public rather than hidden behind `next()`.
 */
export class HarnessEventQueue<T> {
  private readonly items: T[] = [];
  private waiter?: () => void;
  private closed = false;

  /** Queue items and wake a parked consumer. A no-op once ended: late events have nowhere to go. */
  push(...items: T[]): void {
    if (this.closed) return;
    this.items.push(...items);
    this.wake();
  }

  /** No more items will come. A parked consumer wakes, drains what is left, then sees done. */
  end(): void {
    this.closed = true;
    this.wake();
  }

  /**
   * Release a parked consumer without queueing anything. Claude's session uses
   * this when an SDK stream appears that the consumer should start reading.
   */
  wake(): void {
    const w = this.waiter;
    this.waiter = undefined;
    w?.();
  }

  get ended(): boolean {
    return this.closed;
  }

  shift(): T | undefined {
    return this.items.shift();
  }

  some(pred: (item: T) => boolean): boolean {
    return this.items.some(pred);
  }

  /**
   * Resolves on the next `push`, `end` or `wake`. Only ONE consumer may wait at
   * a time: a second `wait()` replaces the first, which would then never resolve.
   * That matches the single-consumer contract of a harness `events` stream.
   */
  wait(): Promise<void> {
    return new Promise<void>((resolve) => (this.waiter = resolve));
  }

  /** The plain pull: the next item, parking while empty, done once ended and drained. */
  async next(): Promise<IteratorResult<T>> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) return { value: item, done: false };
      if (this.closed) return { value: undefined as never, done: true };
      await this.wait();
    }
  }

  /** This queue as an `AsyncIterable`, for a session whose `next()` needs nothing extra. */
  iterable(): AsyncIterable<T> {
    return { [Symbol.asyncIterator]: () => ({ next: () => this.next() }) };
  }
}
