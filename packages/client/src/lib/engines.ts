/**
 * The speech engine registries: dictation (speech → text) and TTS (text →
 * speech), each with a built-in that is always registered, and which one is
 * ACTIVE as a per-browser preference.
 *
 * Per browser, not per chat, like the composer-control visibility beside it
 * (lib/composerPrefs): which microphone pipeline you talk through is a fact
 * about this device — the phone has a mic and no local Whisper; the desktop
 * has both — not about one conversation. Persisted the house way, a guarded
 * localStorage read/write, no zustand middleware.
 *
 * A plugin registers an engine through `host.engines.*.register`; the
 * composer's options menu lists every registered engine and the selection
 * is honoured by `useDictation` and the TTS feeder (lib/ttsFeeder). A
 * selection naming an engine that is not registered — the plugin was
 * disabled — falls back to the built-in rather than to silence.
 */
import type { DictationEngineDef, TtsEngineDef } from "@dispatch/shared";
import { create } from "zustand";
import { createDictation, unavailableReason } from "./speech.js";
import { SPEECH_SYNTHESIS_ENGINE, SPEECH_SYNTHESIS_ID } from "./speechSynthesisTts.js";

export const WEB_SPEECH_ID = "web-speech";

export const WEB_SPEECH_ENGINE: DictationEngineDef = {
  id: WEB_SPEECH_ID,
  label: "Browser speech recognition",
  unavailable: unavailableReason,
  create: createDictation,
};

const DICTATION_KEY = "cm:dictation-engine";
const TTS_KEY = "cm:tts-engine";
const SPEAK_KEY = "cm:speak-replies";

function backing(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return backing()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    backing()?.setItem(key, value);
  } catch {
    /* quota / private mode — a lost preference beats a thrown save */
  }
}

interface EnginesStore {
  dictation: DictationEngineDef[];
  tts: TtsEngineDef[];
  /** The chosen ids. May name an engine that is not (yet, or any more) registered. */
  dictationId: string;
  ttsId: string;
  /** Read streamed replies aloud through the active TTS engine. */
  speakReplies: boolean;
  registerDictation: (def: DictationEngineDef) => () => void;
  registerTts: (def: TtsEngineDef) => () => void;
  selectDictation: (id: string) => void;
  selectTts: (id: string) => void;
  setSpeakReplies: (on: boolean) => void;
}

function refuseDuplicate(list: { id: string }[], id: string, what: string): void {
  if (list.some((d) => d.id === id)) throw new Error(`${what} engine "${id}" is already registered`);
}

export const useEngines = create<EnginesStore>((set) => ({
  dictation: [WEB_SPEECH_ENGINE],
  tts: [SPEECH_SYNTHESIS_ENGINE],
  dictationId: read(DICTATION_KEY) ?? WEB_SPEECH_ID,
  ttsId: read(TTS_KEY) ?? SPEECH_SYNTHESIS_ID,
  speakReplies: read(SPEAK_KEY) === "1",
  registerDictation: (def) => {
    refuseDuplicate(useEngines.getState().dictation, def.id, "dictation");
    set((s) => ({ dictation: [...s.dictation, def] }));
    return () => set((s) => ({ dictation: s.dictation.filter((d) => d !== def) }));
  },
  registerTts: (def) => {
    refuseDuplicate(useEngines.getState().tts, def.id, "TTS");
    set((s) => ({ tts: [...s.tts, def] }));
    return () => set((s) => ({ tts: s.tts.filter((d) => d !== def) }));
  },
  selectDictation: (id) => {
    write(DICTATION_KEY, id);
    set({ dictationId: id });
  },
  selectTts: (id) => {
    write(TTS_KEY, id);
    set({ ttsId: id });
  },
  setSpeakReplies: (on) => {
    write(SPEAK_KEY, on ? "1" : "0");
    set({ speakReplies: on });
  },
}));

/** The dictation engine in force: the selection when registered, else the built-in. */
export function activeDictationEngine(s: Pick<EnginesStore, "dictation" | "dictationId">): DictationEngineDef {
  return s.dictation.find((d) => d.id === s.dictationId) ?? WEB_SPEECH_ENGINE;
}

/** The TTS engine in force: the selection when registered, else the built-in. */
export function activeTtsEngine(s: Pick<EnginesStore, "tts" | "ttsId">): TtsEngineDef {
  return s.tts.find((d) => d.id === s.ttsId) ?? SPEECH_SYNTHESIS_ENGINE;
}

/** Test seam: back to the built-ins and defaults. */
export function resetEngines(): void {
  useEngines.setState({
    dictation: [WEB_SPEECH_ENGINE],
    tts: [SPEECH_SYNTHESIS_ENGINE],
    dictationId: WEB_SPEECH_ID,
    ttsId: SPEECH_SYNTHESIS_ID,
    speakReplies: false,
  });
}
