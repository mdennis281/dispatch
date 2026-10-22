/**
 * The built-in text-to-speech engine: `window.speechSynthesis`.
 *
 * Free, no key, and present in every Chromium — the same reason Web Speech is
 * the built-in for dictation. The browser keeps its own utterance queue, so
 * `feed` is one `speak()` per sentence and `flush` has nothing to do; the
 * queue drains on its own. `cancel` drops it, which is what a chat switch
 * means.
 *
 * One Chromium quirk is handled here rather than left to callers: a long
 * utterance can stall after ~15 s of continuous speech (the engine goes
 * silent and never fires `end`). Speaking per SENTENCE — which the host's
 * chunker already guarantees — keeps every utterance well under that.
 */
import type { TtsEngine, TtsEngineDef } from "@dispatch/shared";

export const SPEECH_SYNTHESIS_ID = "speech-synthesis";

function synth(): SpeechSynthesis | undefined {
  return typeof window !== "undefined" ? window.speechSynthesis : undefined;
}

export function speechSynthesisUnavailable(): string | null {
  return synth() ? null : "This browser has no speech synthesis.";
}

export function createSpeechSynthesisEngine(): TtsEngine | null {
  const s = synth();
  if (!s) return null;
  return {
    feed(text) {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = navigator.language || "en-US";
      s.speak(u);
    },
    flush() {
      /* the browser's queue finishes by itself */
    },
    cancel() {
      s.cancel();
    },
  };
}

export const SPEECH_SYNTHESIS_ENGINE: TtsEngineDef = {
  id: SPEECH_SYNTHESIS_ID,
  label: "Browser voice",
  unavailable: speechSynthesisUnavailable,
  create: createSpeechSynthesisEngine,
};
