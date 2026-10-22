/**
 * A tap on the server event stream, for code that is not a store.
 *
 * `applyServerEvent` (stores/index.ts) is the one reducer, and it is
 * exhaustive on purpose: a new wire event is a compile error until a store
 * handles it. That is the right shape for the app's own state and the wrong
 * shape for a plugin, which cannot add a case to a switch it does not own.
 * So the reducer publishes every frame here AFTER the stores have applied
 * it — a listener for `chat-update` reads the updated chat, not the stale
 * one — and plugin code subscribes by type.
 *
 * Dependency-free (no store imports) so anything can subscribe without
 * creating a cycle through stores/index.ts.
 */
import type { WsServerEvent, WsServerEventType } from "@dispatch/shared";

type Listener = (evt: WsServerEvent) => void;

const byType = new Map<string, Set<Listener>>();
const all = new Set<Listener>();

/** Listen for one event type. Returns the unsubscribe. */
export function onServerEvent<T extends WsServerEventType>(
  type: T,
  fn: (evt: Extract<WsServerEvent, { type: T }>) => void,
): () => void {
  let set = byType.get(type);
  if (!set) {
    set = new Set();
    byType.set(type, set);
  }
  const listener = fn as Listener;
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** Listen for every event. Returns the unsubscribe. */
export function subscribeServerEvents(fn: Listener): () => void {
  all.add(fn);
  return () => {
    all.delete(fn);
  };
}

/**
 * Fan one frame out. A listener that throws is reported and skipped: a
 * plugin's bug must not stop the next listener — or, since the reducer calls
 * this synchronously, the socket's frame loop.
 */
export function publishServerEvent(evt: WsServerEvent): void {
  const typed = byType.get(evt.type);
  if (typed) for (const fn of [...typed]) safely(fn, evt);
  if (all.size) for (const fn of [...all]) safely(fn, evt);
}

function safely(fn: Listener, evt: WsServerEvent): void {
  try {
    fn(evt);
  } catch (err) {
    console.error(`[dispatch] event listener for "${evt.type}" threw:`, err);
  }
}

/** Test seam: drop every listener. */
export function resetServerEventTap(): void {
  byType.clear();
  all.clear();
}
