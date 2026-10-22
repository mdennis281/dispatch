/**
 * Feeds the active TTS engine from the chat on screen.
 *
 * Listens on the event tap for `message-chunk` (the streamed text of the
 * assistant row in flight), runs it through the sentence chunker, and hands
 * each completed sentence to the engine; flushes when the assistant row
 * lands as a `chat-message`; cancels when the reader moves to another chat
 * or turns "Speak replies" off. Only the ACTIVE chat is spoken — a reply
 * streaming in a background chat is somebody else's conversation.
 *
 * Why a module-level service rather than a hook: the composer is remounted
 * per layout and not mounted at all on the home page, and a reply does not
 * stop streaming because the composer went away. Started once from
 * `startLiveApp`, alongside the socket.
 */
import type { TtsEngine } from "@dispatch/shared";
import { onServerEvent } from "./eventTap.js";
import { useChats } from "../stores/chats.js";
import { useEngines, activeTtsEngine } from "./engines.js";
import { SentenceChunker } from "./ttsChunker.js";

/** What the feeder depends on — injectable for the tests. */
export interface TtsFeederDeps {
  activeChatId(): string | null;
  engine(): TtsEngine | null;
  /** Fire when the engine selection changes (the old instance is cancelled). */
  onEngineChange(fn: () => void): () => void;
  onActiveChatChange(fn: () => void): () => void;
  enabled(): boolean;
  onEnabledChange(fn: () => void): () => void;
}

export function createTtsFeeder(deps: TtsFeederDeps): () => void {
  const chunker = new SentenceChunker();
  let messageId: string | null = null;
  let instance: TtsEngine | null = null;
  let instanceStale = true;

  const engine = (): TtsEngine | null => {
    if (instanceStale) {
      instance = deps.engine();
      instanceStale = false;
    }
    return instance;
  };

  const cancel = () => {
    instance?.cancel();
    chunker.reset();
    messageId = null;
  };

  const say = (sentences: string[]) => {
    const e = engine();
    if (!e) return;
    for (const s of sentences) e.feed(s);
  };

  const finish = () => {
    const tail = chunker.flush();
    if (tail) say([tail]);
    engine()?.flush();
    messageId = null;
  };

  const offs = [
    onServerEvent("message-chunk", (evt) => {
      if (!deps.enabled() || evt.channel !== "text") return;
      if (evt.chatId !== deps.activeChatId()) return;
      if (messageId !== evt.messageId) {
        // A new row started streaming before the previous one's `chat-message`
        // arrived (a tool call between two assistant rows, say): finish the
        // old one so its tail is not glued to the new one's first sentence.
        if (messageId !== null) finish();
        messageId = evt.messageId;
      }
      say(chunker.feed(evt.delta));
    }),
    onServerEvent("chat-message", (evt) => {
      if (!deps.enabled() || evt.message.kind !== "assistant") return;
      if (evt.chatId !== deps.activeChatId()) return;
      if (messageId === evt.message.id) {
        finish();
      } else if (messageId === null && evt.message.text) {
        // A row that never streamed (a provider that delivers whole messages,
        // the fake SDK). Speak it in one go through the same chunker so the
        // rule convention still applies.
        say(chunker.feed(evt.message.text));
        finish();
      }
    }),
    onServerEvent("chat-status", (evt) => {
      // A turn that ended without its row landing (interrupted, errored): say
      // what we have rather than hold it forever.
      if (evt.chatId === deps.activeChatId() && evt.status !== "running" && messageId !== null) finish();
    }),
    deps.onActiveChatChange(cancel),
    deps.onEngineChange(() => {
      cancel();
      instanceStale = true;
    }),
    deps.onEnabledChange(() => {
      if (!deps.enabled()) cancel();
    }),
  ];
  return () => {
    cancel();
    for (const off of offs) off();
  };
}

let stop: (() => void) | null = null;

/** Start the feeder against the real stores. Idempotent. */
export function startTtsFeeder(): void {
  if (stop) return;
  stop = createTtsFeeder({
    activeChatId: () => useChats.getState().activeChatId,
    engine: () => {
      const def = activeTtsEngine(useEngines.getState());
      if (def.unavailable?.()) return null;
      try {
        return def.create();
      } catch (err) {
        console.error(`[dispatch] TTS engine "${def.id}" failed to create:`, err);
        return null;
      }
    },
    onEngineChange: (fn) =>
      useEngines.subscribe((s, prev) => {
        if (s.ttsId !== prev.ttsId || s.tts !== prev.tts) fn();
      }),
    onActiveChatChange: (fn) =>
      useChats.subscribe((s, prev) => {
        if (s.activeChatId !== prev.activeChatId) fn();
      }),
    enabled: () => useEngines.getState().speakReplies,
    onEnabledChange: (fn) =>
      useEngines.subscribe((s, prev) => {
        if (s.speakReplies !== prev.speakReplies) fn();
      }),
  });
}

export function stopTtsFeeder(): void {
  stop?.();
  stop = null;
}
