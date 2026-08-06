/**
 * Dictation engine — speech in, text out.
 *
 * The only implementation today is the browser's built-in Web Speech API, which
 * is free, needs no key, and streams interim results as you talk. It is also the
 * one piece of this feature that is environment-dependent: Chrome/Edge ship
 * Google's speech service, and Electron does NOT (its Chromium is built without
 * the API key), so the desktop app fails with `not-allowed` the instant it
 * starts. `unavailableReason()` and the error mapping below exist to say that
 * out loud instead of leaving a dead mic button.
 *
 * Everything above this module talks to `DictationEngine`, so swapping in a
 * local Whisper (record → transcribe on stop) is a matter of adding a second
 * factory here — no UI changes.
 */

/** Chrome's SpeechRecognition isn't in TypeScript's DOM lib; only what we use. */
interface SpeechRecognitionAlternative {
  transcript: string;
}
interface SpeechRecognitionResult {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
  message?: string;
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function ctor(): SpeechRecognitionCtor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/**
 * Rough "are we inside the Electron shell" test. Only used to explain a failure
 * in terms the user can act on — never to gate the attempt, because if a future
 * Electron does ship working recognition we want it to just work.
 */
function looksLikeElectron(): boolean {
  return /\bElectron\//i.test(navigator.userAgent);
}

/**
 * Measured in Electron 33 with real microphones present: `start` → `audiostart`
 * → `error: network` → `end`. The mic opens and streams perfectly well; it's the
 * recognition backend that fails, because Electron's Chromium is built without
 * Chrome's Google speech service key, so the audio goes nowhere. Device access is
 * NOT the problem, which is why this reads the way it does.
 */
export const DESKTOP_HINT =
  "The desktop app can't reach a speech service — Electron ships without Chrome's " +
  "speech API key, so dictation dies the moment the mic opens. Open " +
  "http://127.0.0.1:4319 in Chrome, or switch to a local Whisper engine.";

export type EngineKind = "web-speech" | "whisper";

/**
 * Which engine to use here.
 *
 * Electron always gets local Whisper: Web Speech there is not flaky, it is
 * measurably impossible (mic opens, then `network`), so attempting it first
 * would only ever cost a failed take. Real browsers keep Web Speech, whose live
 * interim text makes for markedly better dictation, and which needs no 114MB of
 * vendored model to have been built in.
 */
export function engineKind(): EngineKind {
  if (looksLikeElectron()) return "whisper";
  return ctor() ? "web-speech" : "whisper";
}

/**
 * Why dictation can't run at all, or null when it's available to try.
 *
 * With Whisper as the fallback there is no longer a "this browser can't dictate"
 * case for a missing speech API — only for a browser too old to RECORD, which is
 * what the local engine actually needs. Whether the microphone exists, whether
 * permission is granted, and whether the model loads are all runtime questions
 * that can't be answered without starting, so they surface as errors instead.
 */
export function unavailableReason(): string | null {
  if (engineKind() === "web-speech") return null;
  const canRecord =
    typeof Worker !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    typeof AudioContext !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia;
  return canRecord ? null : "This browser can't record audio, so dictation isn't available.";
}

/** Turn a SpeechRecognition error code into something worth showing a human. */
function describe(code: string): string | null {
  switch (code) {
    // Fired on every natural pause. Not a failure — we just keep listening.
    case "no-speech":
      return null;
    // We called stop()/abort() ourselves.
    case "aborted":
      return null;
    // A genuine permission denial in either environment — Electron grants media
    // permissions and enumerates microphones normally, so this is never the
    // desktop shell's doing and must not be explained away as such.
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was blocked. Allow it and try again.";
    case "audio-capture":
      return "No microphone found. Plug one in (or pick one in your sound settings) and try again.";
    // The desktop shell's actual signature — see DESKTOP_HINT. Telling someone to
    // check their connection when the real cause is a missing build-time API key
    // sends them debugging the wrong thing entirely.
    case "network":
      return looksLikeElectron()
        ? DESKTOP_HINT
        : "The speech service is unreachable — check your connection.";
    case "language-not-supported":
      return `Speech recognition doesn't support ${navigator.language}.`;
    default:
      return `Speech recognition failed (${code}).`;
  }
}

export interface DictationHandlers {
  /** Stable, committed text. Arrives in chunks as you pause. */
  onFinal(text: string): void;
  /** Live guess for the phrase in progress; replaced on every event. */
  onInterim(text: string): void;
  /** A real problem worth surfacing. Benign codes never reach this. */
  onError(message: string): void;
  /** Recognition has genuinely stopped — update the UI to "not listening". */
  onStopped(): void;
  /**
   * Engine-specific work the user is waiting on ("Loading speech model… 40%",
   * "Transcribing…"), or null when idle. Local Whisper has a gap between the mic
   * closing and the text landing; without a word about it that gap reads as the
   * feature having silently failed.
   */
  onStatus?(text: string | null): void;
}

export interface DictationEngine {
  start(): void;
  stop(): void;
}

/**
 * How many consecutive instant restarts we tolerate before concluding the engine
 * is refusing rather than idling. Chrome ends a session on every long silence and
 * expects a restart; a broken engine ends immediately, forever, so an unguarded
 * restart loop would spin the CPU and never surface the failure.
 */
const MAX_INSTANT_RESTARTS = 3;
const INSTANT_MS = 400;

/** Create a Web Speech dictation engine. Returns null when unavailable. */
export function createDictation(handlers: DictationHandlers): DictationEngine | null {
  const SR = ctor();
  if (!SR) return null;

  let rec: SpeechRecognitionLike | null = null;
  // The user's intent, which outlives any individual recognition session:
  // Chrome stops on silence and we restart underneath, invisibly.
  let wanted = false;
  let startedAt = 0;
  let instantRestarts = 0;

  const teardown = () => {
    if (!rec) return;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    rec.onstart = null;
    rec = null;
  };

  const halt = (message?: string) => {
    wanted = false;
    teardown();
    if (message) handlers.onError(message);
    handlers.onStopped();
  };

  const spin = () => {
    const r = new SR();
    rec = r;
    r.lang = navigator.language || "en-US";
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onstart = () => {
      startedAt = Date.now();
    };

    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (!result) continue;
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) {
          const trimmed = text.trim();
          if (trimmed) handlers.onFinal(trimmed);
        } else {
          interim += text;
        }
      }
      handlers.onInterim(interim.trim());
      // Speech is flowing, so any earlier instant-end was just silence.
      instantRestarts = 0;
    };

    r.onerror = (e) => {
      const message = describe(e.error);
      // A benign code (silence, our own abort) leaves `wanted` alone — `onend`
      // fires next and decides whether to restart.
      if (message) halt(message);
    };

    r.onend = () => {
      if (!wanted) {
        teardown();
        handlers.onInterim("");
        handlers.onStopped();
        return;
      }
      // Ended while we still want to listen → Chrome's silence timeout. Restart,
      // unless it's ending the instant it starts, which means it isn't working.
      instantRestarts = Date.now() - startedAt < INSTANT_MS ? instantRestarts + 1 : 0;
      if (instantRestarts > MAX_INSTANT_RESTARTS) {
        halt("Speech recognition kept stopping as soon as it started — giving up.");
        return;
      }
      teardown();
      spin();
    };

    try {
      r.start();
    } catch {
      // Almost always "already started" from a double-trigger; the live session
      // is fine, so leave it running rather than tearing the user's mic down.
    }
  };

  return {
    start() {
      if (wanted) return;
      wanted = true;
      instantRestarts = 0;
      handlers.onInterim("");
      spin();
    },
    stop() {
      if (!wanted) return;
      wanted = false;
      handlers.onInterim("");
      // stop() lets the final result land; onend then reports the stop.
      try {
        rec?.stop();
      } catch {
        halt();
      }
    },
  };
}

/**
 * Below this, a press is a tap (latch the mic on, "toggle"); at or above it, the
 * press was a hold and releasing turns the mic off ("push-to-talk"). One control,
 * both behaviours — which is how every voice chat app people already use behaves.
 */
export const HOLD_MS = 350;

export type PressOutcome = "latch" | "release";

/** Decide what releasing the mic button means, given how long it was held. */
export function pressOutcome(heldMs: number): PressOutcome {
  return heldMs < HOLD_MS ? "latch" : "release";
}

/**
 * Join dictated text onto an existing draft: a space between sentences, nothing
 * doubled up, and no leading space when the box is empty.
 */
export function appendSpoken(existing: string, spoken: string): string {
  const left = existing.replace(/\s+$/, "");
  if (!left) return spoken;
  return `${left} ${spoken}`;
}
