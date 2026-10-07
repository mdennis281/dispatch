/**
 * The chat LOAD cap — which chats `GET /api/chats` ships.
 *
 * Nothing here deletes or modifies anything. An install accumulates chats
 * faster than any sidebar can show them (1621 over 92 days on the install this
 * was built for, 874 of them in one project), and every one of them was being
 * read off disk, serialized into one hydrate response and held in the client
 * store forever. So the response is bounded to the newest N per project and the
 * rest stay on disk, reachable by `?all=1` or by id.
 *
 * The cap itself is {@link capChatsPerProject} in `@dispatch/shared` — shared
 * because the client needs the same rule to know whether a project has more to
 * fetch. What lives here is the one thing the shared function cannot know: which
 * chats are LIVE, and therefore must ride along above the cap however stale
 * their last activity looks.
 */
import {
  capChatsPerProject,
  resolveRetention,
  type Chat,
  type ChatStatus,
  type ProjectRetention,
  type RetentionSettings,
} from "@dispatch/shared";
import type { Store } from "../store/index.js";
import type { AttentionQueue } from "./attention.js";

/** What a chat's rank is measured by: last activity, falling back to creation. */
export function chatActivityAt(chat: Chat): number {
  return chat.updatedAt ?? chat.createdAt ?? 0;
}

export interface LoadCapDeps {
  /** Live session status, or `undefined` for a chat with no session. */
  getStatus: (chatId: string) => ChatStatus | undefined;
  attention: Pick<AttentionQueue, "list">;
  /**
   * This project's `project.yaml` → `retention` block, if it authors one.
   * Synchronous because `ProjectConfigService.getConfig` is — it serves a parsed
   * cache — which is what makes a per-project limit affordable on the hydrate
   * path at all.
   */
  projectRetention?: (projectId: string) => ProjectRetention | undefined;
}

/**
 * The per-project cap, as a function of project id.
 *
 * One `resolveRetention` per project rather than one for the whole call: the
 * unscoped hydrate caps every project in a single pass, and resolving once would
 * apply whichever project answered first to all of them.
 */
function limitFor(deps: LoadCapDeps, app: RetentionSettings | undefined) {
  const cache = new Map<string, number>();
  return (projectId: string): number => {
    const hit = cache.get(projectId);
    if (hit !== undefined) return hit;
    const limit = resolveRetention(app, deps.projectRetention?.(projectId)).maxChatsPerProject
      .effective;
    cache.set(projectId, limit);
    return limit;
  };
}

/**
 * Chats that must be in the payload whatever the cap says.
 *
 * Two sources, each from a way the cap would otherwise hide something that is
 * asking for a human:
 *
 *  - A chat with a live session. `idle` is the one status that does not pin —
 *    everything else means a turn is in flight, parked on a tool, or waiting on
 *    an answer. A session that has just started has no transcript row yet, so
 *    its `updatedAt` can rank it anywhere.
 *  - A chat with an attention item. These are by nature OLD: the whole point of
 *    the queue is that something has been waiting. A permission prompt from this
 *    morning sorts below a week of other activity and is still the most
 *    important row on the screen.
 */
export function pinnedChatIds(deps: LoadCapDeps, chats: readonly Chat[]): Set<string> {
  const pinned = new Set<string>();
  for (const chat of chats) {
    const status = deps.getStatus(chat.id);
    if (status && status !== "idle") pinned.add(chat.id);
  }
  for (const item of deps.attention.list()) pinned.add(item.chatId);
  return pinned;
}

/**
 * The chats a hydrate gets: `store.listChats` capped per project.
 *
 * `projectId` narrows first and the cap then applies to that one project, so a
 * scoped fetch returns the same rows for that project as the unscoped one did —
 * if the cap were applied before the filter, a project would load a different
 * number of chats depending on which call asked.
 */
export async function listCappedChats(
  store: Store,
  deps: LoadCapDeps,
  opts: { projectId?: string; all?: boolean } = {},
): Promise<Chat[]> {
  const chats = await store.listChats(opts.projectId);
  if (opts.all) return chats;
  const settings = await store.getSettings();
  return capChatsPerProject(chats, limitFor(deps, settings.retention), {
    pinned: pinnedChatIds(deps, chats),
    activityOf: chatActivityAt,
  });
}

/**
 * How many chats each project HAS, against the cap that is loading them.
 *
 * The client needs both to offer "show the other 674": the loaded count alone
 * cannot distinguish a project at its cap from one that happens to have exactly
 * that many. Cheap — `listChats` serves its records from an in-memory cache, so
 * this is the same read the hydrate already did.
 *
 * `limit` is the APP-level cap, reported for the one thing the client does with
 * it (telling an uncapped install from a capped one). Per-project overrides are
 * not reported, because the client never recomputes the cap — it subtracts what
 * it was sent from the total, so a project's own number is already reflected.
 */
export async function chatTotalsByProject(
  store: Store,
): Promise<{ totals: Record<string, number>; limit: number }> {
  const chats = await store.listChats();
  const settings = await store.getSettings();
  const limit = resolveRetention(settings.retention).maxChatsPerProject.effective;
  const totals: Record<string, number> = {};
  for (const chat of chats) totals[chat.projectId] = (totals[chat.projectId] ?? 0) + 1;
  return { totals, limit };
}
