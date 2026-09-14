/**
 * What a chat is running as — mode, effort, model — with where each came from.
 *
 * `chat.modeId` / `chat.effort` / `chat.model` are PINS: present when the
 * human chose, absent when the chat inherits the project manifest's
 * `defaults`, then the app's per-provider defaults, then the built-in floor.
 * The composer used to read the row directly, which was fine while
 * `createChat` copied the app default onto every row and wrong the moment it
 * stopped: an unpinned chat would render no effort at all.
 *
 * This is the SAME resolver the server runs at session start
 * (`resolveChatPosture`), fed the same three layers, so the badge in the
 * composer and the level the session actually starts at cannot disagree —
 * short of the layers changing between the two reads, which is exactly the
 * case the source label exists to explain.
 */
import {
  DEFAULT_HARNESS,
  layerSourceLabel,
  layerSourceShort,
  resolveChatPosture,
  type ChatPosture,
  type PostureSource,
} from "@dispatch/shared";
import { useChats } from "../stores/chats.js";
import { useProjectLayer } from "../stores/config.js";
import { useSettings } from "../stores/settings.js";

/** Resolve the chain for a chat. Safe with a chat that doesn't exist yet. */
export function useChatPosture(chatId: string | null): ChatPosture {
  const chat = useChats((s) => (chatId ? s.byId[chatId] : undefined));
  const project = useProjectLayer(chat?.projectId);
  const settings = useSettings((s) => s.app);
  return resolveChatPosture({
    chat: chat
      ? {
          harness: chat.harness ?? DEFAULT_HARNESS,
          subscriptionId: chat.subscriptionId,
          modeId: chat.modeId,
          effort: chat.effort,
          model: chat.model,
        }
      : undefined,
    project,
    settings,
  });
}

/**
 * The sentence a chat control shows for where its value came from. `parent`
 * never survives to a stored chat (a spawn pins what it inherited), so the
 * three-layer label covers it.
 */
export function postureSourceLabel(source: PostureSource, defaultLabel = "built-in default"): string {
  return source === "parent" ? "inherited from the parent chat" : layerSourceLabel(source, defaultLabel);
}

/** The one-word form for a menu row's trailing hint — see `layerSourceShort`. */
export function postureSourceShort(source: PostureSource, defaultLabel = "built-in"): string {
  return source === "parent" ? "parent" : layerSourceShort(source, defaultLabel);
}
