/**
 * Dictation engine — speech in, text out.
 *
 * Built on the browser's Web Speech API: free, no key, and it streams interim
 * results as you talk. Dispatch runs as an installed PWA in a Chromium browser,
 * so the API is simply there — which is the whole reason the app is a PWA and
 * not an Electron shell. Electron's Chromium is built without Chrome's speech
 * service key, so this died with `network` the instant the mic opened, and the
 * workaround was 114MB of vendored Whisper weights. Running in the real browser
 * deletes both the failure and the workaround.
 *
 * Everything above this module talks to `DictationEngine`, so a second engine
 * (a local model, a server-side transcriber) is a matter of adding another
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
 * Why dictation can't run at all, or null when it's available to try.
 *
 * The only answerable question up front is whether the API exists — Firefox and
 * Safari still don't ship it. Whether a microphone is present and whether
 * permission is granted can't be known without starting, so those surface as
 * errors from `describe()` instead of disabling the control pre-emptively.
 */
export function unavailableReason(): string | null {
  return ctor()
    ? null
    : "This browser doesn't support speech recognition. Chrome or Edge does.";
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
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was blocked. Allow it and try again.";
    case "audio-capture":
      return "No microphone found. Plug one in (or pick one in your sound settings) and try again.";
    // Recognition runs against a remote service, so this is the offline case.
    case "network":
      return "The speech service is unreachable — check your connection.";
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
