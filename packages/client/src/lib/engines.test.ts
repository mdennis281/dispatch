import { describe, it, expect, beforeEach } from "vitest";
import type { DictationEngineDef, TtsEngineDef } from "@dispatch/shared";
import { activeDictationEngine, activeTtsEngine, resetEngines, useEngines, WEB_SPEECH_ID } from "./engines.js";
import { SPEECH_SYNTHESIS_ID } from "./speechSynthesisTts.js";

const whisper: DictationEngineDef = {
  id: "whisper",
  label: "Local Whisper",
  create: () => ({ start() {}, stop() {} }),
};
const piper: TtsEngineDef = { id: "piper", label: "Piper", create: () => ({ feed() {}, flush() {}, cancel() {} }) };

describe("engine registries", () => {
  beforeEach(resetEngines);

  it("always has the built-ins, and they are the defaults", () => {
    const s = useEngines.getState();
    expect(s.dictation.map((d) => d.id)).toEqual([WEB_SPEECH_ID]);
    expect(s.tts.map((d) => d.id)).toEqual([SPEECH_SYNTHESIS_ID]);
    expect(activeDictationEngine(s).id).toBe(WEB_SPEECH_ID);
    expect(activeTtsEngine(s).id).toBe(SPEECH_SYNTHESIS_ID);
    expect(s.speakReplies).toBe(false);
  });

  it("a registered engine replaces the built-in once selected, and unregistering falls back", () => {
    const off = useEngines.getState().registerDictation(whisper);
    useEngines.getState().selectDictation("whisper");
    expect(activeDictationEngine(useEngines.getState())).toBe(whisper);
    off();
    // The selection is kept (the plugin may come back after a restart) but
    // the engine in force is the built-in, never nothing.
    expect(useEngines.getState().dictationId).toBe("whisper");
    expect(activeDictationEngine(useEngines.getState()).id).toBe(WEB_SPEECH_ID);
  });

  it("same for TTS, and refuses a duplicate id", () => {
    const off = useEngines.getState().registerTts(piper);
    useEngines.getState().selectTts("piper");
    expect(activeTtsEngine(useEngines.getState())).toBe(piper);
    expect(() => useEngines.getState().registerTts(piper)).toThrow(/already registered/);
    expect(() => useEngines.getState().registerDictation({ ...whisper, id: WEB_SPEECH_ID })).toThrow(/already registered/);
    off();
    expect(activeTtsEngine(useEngines.getState()).id).toBe(SPEECH_SYNTHESIS_ID);
  });

  it("a selection naming an engine nobody registered falls back to the built-in", () => {
    useEngines.getState().selectDictation("ghost");
    expect(activeDictationEngine(useEngines.getState()).id).toBe(WEB_SPEECH_ID);
  });
});
