import { create } from "zustand";
import { actions } from "../lib/actions.js";
import { isUnstartedChat, useChats } from "./chats.js";
import type { Chat } from "@dispatch/shared";
import { selectChat } from "./navigation.js";

/**
 * "A New chat is on its way" — per project, shared by every entry point.
 *
 * `create-chat` is fire-and-forget over the socket: nothing answers the send,
 * the chat simply streams into `useChats` some hundreds of ms later. Without a
 * flag for that gap the click looked dead, so people clicked again and got two
 * chats. The sidebar reads this to draw a placeholder row and disable the
 * button; the command palette writes it too, so creating from ⌘K shows the
 * same thing rather than a sidebar that pretends nothing is happening.
 */
interface PendingChatStore {
  /** projectId → token of the create in flight. One per project at a time. */
  byProject: Record<string, number>;
}

export const usePendingChat = create<PendingChatStore>(() => ({
  byProject: {},
}));

/**
 * How long the placeholder and the disabled button may last. Past this the
 * create is either queued behind a dead socket or lost, and holding the button
 * hostage longer helps neither.
 */
export const PENDING_CHAT_TIMEOUT_MS = 8_000;

let seq = 0;

function clear(projectId: string, token: number): void {
  usePendingChat.setState((s) => {
    // Only OUR token: a later create for the same project owns the flag now.
    if (s.byProject[projectId] !== token) return s;
    const { [projectId]: _, ...rest } = s.byProject;
    return { byProject: rest };
  });
}

/**
 * How far a chat's server-stamped `createdAt` may trail our send and still be
 * the one we created. Generous on purpose: it only has to reject OLD chats that
 * enter `order` during the wait (`hydrate` on reconnect, `mergeChats` from
 * "N older chats"), and a tight bound would trip on client/server clock skew —
 * a phone reaching the server over Tailscale has its own clock.
 */
const CREATED_SKEW_MS = 60_000;

/**
 * Could `chat` be the one this click created? `order` is not only appended to
 * by `chat-created`, so "new id in this project" alone also matched:
 *  - a chat an agent spawned here (`parentChatId`), a PR reviewer (`reviewOf`),
 *    a scheduled run, a job chat (`purpose`), one an integration token started;
 *  - an old chat arriving through a reconnect `hydrate` or an older-chats page.
 * A plain chat created in the same project from another tab in the same window
 * is still indistinguishable without a correlation id on the wire.
 */
export function isOurNewChat(chat: Chat | undefined, projectId: string, sentAt: number): boolean {
  if (!chat || chat.projectId !== projectId) return false;
  if (chat.parentChatId || chat.reviewOf || chat.scheduleId || chat.purpose || chat.startedBy) {
    return false;
  }
  if (chat.archived || !isUnstartedChat(chat)) return false;
  return chat.createdAt >= sentAt - CREATED_SKEW_MS;
}

/**
 * Fire-and-focus chat creation: dispatch create-chat for the project, mark it
 * pending, and select the chat the moment its id streams into the store.
 *
 * Returns without sending when this project already has a create in flight —
 * the button is disabled for that window, but ⌘K and a double-fired keypress
 * aren't, and a second chat nobody wanted is the bug this exists to stop.
 *
 * Which new id is "ours" is a guess — `create-chat` carries no correlation id
 * back — so {@link isOurNewChat} narrows it as far as the record allows.
 *
 * Effort is deliberately NOT sent: the server resolves it from the app's
 * per-provider default (Settings → Chat), and an explicit value here WINS over
 * that chain — which is exactly how every new chat used to land on medium no
 * matter what the setting said.
 */
export function createChatAndFocus(input: { projectId: string; modeId?: string }): void {
  const { projectId } = input;
  if (usePendingChat.getState().byProject[projectId] !== undefined) return;

  const token = ++seq;
  usePendingChat.setState((s) => ({ byProject: { ...s.byProject, [projectId]: token } }));

  const before = new Set(useChats.getState().order);
  const sentAt = Date.now();
  let done = false;
  const stop = () => {
    done = true;
    unsubChats();
    clearTimeout(timer);
  };

  const unsubChats = useChats.subscribe((s) => {
    if (done) return;
    const fresh = s.order.find(
      (id) => !before.has(id) && isOurNewChat(s.byId[id], projectId, sentAt),
    );
    if (!fresh) return;
    stop();
    // Same synchronous tick as the chat's arrival, so React commits the real
    // row and the placeholder's removal together — no frame with both.
    clear(projectId, token);
    selectChat(fresh);
  });

  // The ONLY thing that ends a pending create without the chat landing. A
  // server `error` deliberately does not: errors are broadcast to every socket
  // and the untagged ones can't be told apart, so clearing on them re-enabled
  // the button mid-create — the double-create this exists to stop. An 8s
  // spinner on a genuinely failed create (whose notice still shows) is the
  // cheaper side.
  //
  // Silent on purpose. The usual way to get here is a dropped socket, and then
  // `ws.send` has QUEUED the create in its outbox: the chat will arrive on
  // reconnect. A "didn't arrive — try again" toast was wrong about both halves,
  // and following it made a second chat. The top bar already says
  // "Reconnecting…", and a real failure arrives as an `error` notice.
  const timer = setTimeout(() => {
    if (done) return;
    stop();
    clear(projectId, token);
  }, PENDING_CHAT_TIMEOUT_MS);

  actions.createChat({ projectId, modeId: input.modeId });
}
