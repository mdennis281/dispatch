/**
 * How deep a chat sits in the sidebar's tree, and whether it may spawn another.
 *
 * The sidebar folds a chat under its parent by TWO different edges, and this
 * has to walk both or it answers a different question than the one the user
 * sees. A spawned chat carries `parentChatId`; a reviewer joins through the
 * pull request instead (`reviewOf` → `PrRecord.chatId`), because the registry
 * spawns it and the chat that opened the PR never asks for it. Counting only
 * the direct edge would call a reviewer of a spawned chat depth 0 and let it
 * start a fourth level that the sidebar has nowhere to draw.
 *
 * Pure over two lookups so the walk can be tested without a store, a registry,
 * or a running broker — the same split `chat-messenger`'s limits use.
 */
import type { Chat } from "@dispatch/shared";

/** The two edges a parent can be reached by, as this module needs them. */
export interface NestingLookup {
  /** The chat, or null when it's gone (deleted mid-walk, or never existed). */
  getChat(chatId: string): Promise<Chat | null>;
  /** The chat that OPENED this pull request, by `PrRecord` key. */
  prAuthorChatId(prKey: string): Promise<string | null>;
}

/**
 * A ceiling on the walk that is not the policy — the policy is `maxDepth`, and
 * it is checked against the number this returns.
 *
 * It exists because the two edges are written by different code paths and
 * neither validates the other, so a corrupt chain is reachable in principle. A
 * walk that stops at 32 reports "deeper than anything the sidebar draws", which
 * is the right answer for every real chain and a bounded one for a broken one.
 */
const WALK_LIMIT = 32;

/**
 * The pull request a reviewer chat was pointed at, mirroring the client's
 * `reviewTargetKey`.
 *
 * The legacy label parse is here for the same reason it is there: reviewers
 * spawned before `reviewOf` existed carry their target only in the sentence
 * `taskLabel` wrote for the sidebar, and those chats are on disk. The two
 * copies are allowed to be copies — this one only has to agree about which
 * chats have a parent at all, and a reviewer whose label no longer parses is
 * treated as parentless by BOTH, which is the same answer.
 */
function reviewTargetKey(chat: Chat): string | null {
  if (chat.reviewOf) return chat.reviewOf;
  if (chat.purpose?.kind !== "pr:review") return null;
  const m = /^Reviewing PR #(\d+) in (\S+)$/.exec(chat.purpose.label ?? "");
  return m ? `${m[2]}#${m[1]}` : null;
}

/**
 * How many rows sit between this chat and the top of the sidebar — 0 for a chat
 * a human opened, 1 for one another chat spawned, 2 for that chat's reviewer.
 *
 * A parent that no longer exists ENDS the walk rather than failing it: the
 * sidebar files an orphan at the top level, so the depth it actually renders at
 * is the one counted from wherever the chain still reaches. A cycle likewise
 * stops, because the alternative is a promise that never settles inside a tool
 * call the human is waiting on.
 */
export async function chatNestingDepth(chatId: string, lookup: NestingLookup): Promise<number> {
  const seen = new Set<string>([chatId]);
  let cursor = await lookup.getChat(chatId);
  let depth = 0;
  while (cursor && depth < WALK_LIMIT) {
    const key = reviewTargetKey(cursor);
    const parentId = key ? await lookup.prAuthorChatId(key) : (cursor.parentChatId ?? null);
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);
    const parent = await lookup.getChat(parentId);
    if (!parent) break;
    depth += 1;
    cursor = parent;
  }
  return depth;
}

/** Whether a `spawn_chat` may nest another row under the calling chat. */
export interface SpawnNestingVerdict {
  allowed: boolean;
  /** The caller's own depth — 0 when the spawn wouldn't be nested at all. */
  depth: number;
  /** The project's cap, as the refusal message quotes it. */
  maxDepth: number;
}
