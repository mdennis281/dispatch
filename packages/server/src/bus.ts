/**
 * Typed event bus. Services publish WsServerEvents here; the WS layer subscribes
 * and fans them out to connected clients (multiplexed, tagged by chatId). Kept a
 * thin strongly-typed wrapper over EventEmitter so every publish/subscribe is a
 * fully-typed WsServerEvent.
 */
import { EventEmitter } from "node:events";
import type { WsServerEvent, WsServerEventType } from "@dispatch/shared";

/** A subscriber receiving every server event. */
export type BusListener = (evt: WsServerEvent) => void;
/** A subscriber receiving only events of one `type`. */
export type BusTypedListener<T extends WsServerEventType> = (
  evt: Extract<WsServerEvent, { type: T }>,
) => void;

const ALL = "*" as const;

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many concurrent chats/sockets subscribe; lift the default 10-listener cap.
    this.emitter.setMaxListeners(0);
  }

  /** Broadcast an event to every subscriber (and per-type subscribers). */
  publish(evt: WsServerEvent): void {
    this.emitter.emit(ALL, evt);
    // Node's EventEmitter THROWS on an `'error'` emit with no dedicated listener
    // (and `publish` is fire-and-forget, so that throw becomes an unhandled
    // rejection / crash). The ALL channel already delivered this event, so only
    // fan out on the per-type channel when something is actually listening.
    if (this.emitter.listenerCount(evt.type) > 0) {
      this.emitter.emit(evt.type, evt);
    }
  }

  /** Subscribe to ALL events. Returns an unsubscribe fn. */
  subscribe(fn: BusListener): () => void {
    this.emitter.on(ALL, fn as (...args: unknown[]) => void);
    return () => this.emitter.off(ALL, fn as (...args: unknown[]) => void);
  }

  /** Subscribe to a single event `type`. Returns an unsubscribe fn. */
  on<T extends WsServerEventType>(
    type: T,
    fn: BusTypedListener<T>,
  ): () => void {
    this.emitter.on(type, fn as (...args: unknown[]) => void);
    return () => this.emitter.off(type, fn as (...args: unknown[]) => void);
  }

  /** Current number of "all" subscribers (for diagnostics/tests). */
  listenerCount(): number {
    return this.emitter.listenerCount(ALL);
  }

  /** Drop every subscriber (teardown). */
  clear(): void {
    this.emitter.removeAllListeners();
  }
}

/** The process-wide bus instance. */
export const bus = new EventBus();
