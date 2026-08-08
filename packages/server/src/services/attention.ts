/**
 * AttentionQueue — the GLOBAL, cross-chat inbox of "an agent needs you now".
 *
 * Every LiveSession publishes `attention-add` (permission / question / idle /
 * done) and `attention-resolve` on the bus. The queue is a pure *consumer* that
 * aggregates those into one in-memory, insertion-ordered list so the UI can show
 * a single prioritized triage surface across all chats + expose it over REST/WS.
 *
 * It never publishes in-app delivery (the producer already did); its only job is
 * to remember what is currently outstanding and answer `list()` queries. On
 * `attention-resolve` (or when a chat is deleted) the matching item(s) drop out.
 */
import type { AttentionItem, WsServerEvent } from "@dispatch/shared";
import type { EventBus } from "../bus.js";

/**
 * Kind → triage weight (higher = more urgent, sorted first in `list()`).
 *
 * `review` sits BELOW the two kinds that hold a live turn hostage (a permission
 * prompt and a direct question block an agent that is running right now) and
 * ABOVE the two that are purely retrospective (`idle`/`done` say a turn already
 * finished). A review round is real, unfinished work with a deadline attached —
 * it is the thing that went unnoticed for two full rounds — but it is not
 * blocking a session this second, so it must not push a waiting permission
 * prompt down the list.
 */
const KIND_PRIORITY: Record<AttentionItem["kind"], number> = {
  permission: 5,
  question: 4,
  review: 3,
  idle: 2,
  done: 1,
};

export interface AttentionQueueDeps {
  bus: EventBus;
}

export class AttentionQueue {
  private readonly bus: EventBus;
  /** id → item, insertion-ordered (Map preserves insertion order). */
  private readonly items = new Map<string, AttentionItem>();
  private offs: Array<() => void> = [];

  constructor(deps: AttentionQueueDeps) {
    this.bus = deps.bus;
  }

  /** Begin aggregating bus attention events. Idempotent. */
  start(): void {
    if (this.offs.length) return;
    this.offs.push(
      this.bus.on("attention-add", (e) => this.add(e.item)),
      this.bus.on("attention-resolve", (e) => this.resolve(e.id)),
    );
  }

  /** Stop aggregating. Idempotent. */
  stop(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  /** Upsert an item (dedup by id). */
  add(item: AttentionItem): void {
    this.items.set(item.id, item);
  }

  /** Remove an item by id. Returns true if one was present. */
  resolve(id: string): boolean {
    return this.items.delete(id);
  }

  /** Every outstanding item, most-urgent-first then oldest-first. */
  list(): AttentionItem[] {
    return [...this.items.values()].sort((a, b) => {
      const p = KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind];
      return p !== 0 ? p : a.createdAt - b.createdAt;
    });
  }

  /** Outstanding items for one chat. */
  listForChat(chatId: string): AttentionItem[] {
    return this.list().filter((i) => i.chatId === chatId);
  }

  get(id: string): AttentionItem | undefined {
    return this.items.get(id);
  }

  size(): number {
    return this.items.size;
  }

  /**
   * Drop every item for a chat (used when a chat is deleted). Returns the ids it
   * removed so the caller can broadcast an authoritative `attention-resolve` per
   * id — otherwise a client that already received the item's `attention-add`
   * (e.g. the "Session ended" one deletion triggers) strands a phantom entry.
   */
  clearChat(chatId: string): string[] {
    const removed: string[] = [];
    for (const [id, item] of this.items) {
      if (item.chatId === chatId) {
        this.items.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }
}

/** Narrow guard used by tests/consumers: is this a bus attention event? */
export function isAttentionEvent(
  e: WsServerEvent,
): e is Extract<WsServerEvent, { type: "attention-add" | "attention-resolve" }> {
  return e.type === "attention-add" || e.type === "attention-resolve";
}
