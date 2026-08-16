/**
 * Mic state for the composer: one engine, two gestures.
 *
 * Tap the mic and it latches on until you tap again (toggle). Press and hold it —
 * or hold the push-to-talk key anywhere in the app — and it listens only while
 * held (push-to-talk). Both land on the same control because a single press can
 * be classified after the fact: we start listening on press either way, then on
 * release decide from the elapsed time whether that was a tap (stay on) or a hold
 * (stop now). Starting on press rather than waiting to disambiguate is what keeps
 * push-to-talk from clipping the first word.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createDictation,
  pressOutcome,
  unavailableReason,
  type DictationEngine,
} from "./speech.js";

/**
 * Push-to-talk key. A single key you can hold down comfortably, which rules out
 * anything printable (it would type) and modifier chords (awkward to hold while
 * speaking). F9 is unbound everywhere else in this app.
 */
export const PTT_KEY = "F9";
export const PTT_LABEL = "F9";

export interface Dictation {
  /** The mic is live right now. */
  listening: boolean;
  /** Live, uncommitted guess at the phrase in progress. */
  interim: string;
  /** Last real failure, until dismissed or superseded. */
  error: string | null;
  /** Set when dictation can't run here at all — explains why, in user terms. */
  unavailable: string | null;
  dismissError(): void;
  /** Pointer went down on the mic control. */
  pressStart(): void;
  /** Pointer came up (or was cancelled) after `pressStart`. */
  pressEnd(): void;
  /** Latch on/off with no gesture — the composer's options menu row. */
  toggle(): void;
  /** Force the mic off — chat switches, unmount, send. */
  stop(): void;
}

export function useDictation(onText: (text: string) => void): Dictation {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Probed once: it's a capability of the build, and it can't change mid-session.
  const [unavailable] = useState(unavailableReason);

  // The insertion callback is rebuilt every render (it closes over the editor and
  // the current draft), but the engine's handlers are wired exactly once.
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const engineRef = useRef<DictationEngine | null>(null);
  // How the current session was started, so release knows whether it owns the stop.
  const pressRef = useRef<{ at: number; swallow: boolean } | null>(null);
  const keyHeldRef = useRef(false);

  const engine = useCallback((): DictationEngine | null => {
    if (!engineRef.current) {
      engineRef.current = createDictation({
        onFinal: (text: string) => onTextRef.current(text),
        onInterim: setInterim,
        onError: (message: string) => setError(message),
        onStopped: () => {
          setListening(false);
          setInterim("");
        },
      });
    }
    return engineRef.current;
  }, []);

  const start = useCallback(() => {
    const e = engine();
    if (!e) return;
    setError(null);
    e.start();
    setListening(true);
  }, [engine]);

  const stop = useCallback(() => {
    engineRef.current?.stop();
    setListening(false);
    setInterim("");
  }, []);

  const pressStart = useCallback(() => {
    if (unavailable) return;
    if (listening) {
      // Tapping a live mic turns it off now; the matching release is not a gesture
      // of its own and must not be read as "held briefly, so latch on again".
      stop();
      pressRef.current = { at: Date.now(), swallow: true };
      return;
    }
    pressRef.current = { at: Date.now(), swallow: false };
    start();
  }, [unavailable, listening, start, stop]);

  const pressEnd = useCallback(() => {
    const press = pressRef.current;
    pressRef.current = null;
    if (!press || press.swallow) return;
    if (pressOutcome(Date.now() - press.at) === "release") stop();
  }, [stop]);

  /**
   * Latch the mic on or off with no gesture behind it — for the composer's
   * options menu, where a row is clicked rather than held. Clears any pending
   * press so a stray release afterwards can't be read as the end of a hold.
   */
  const toggle = useCallback(() => {
    if (unavailable) return;
    pressRef.current = null;
    if (listening) stop();
    else start();
  }, [unavailable, listening, start, stop]);

  // Push-to-talk, live anywhere in the app — including while the caret sits in
  // the composer, which is the whole point: think, hold, speak, release.
  useEffect(() => {
    if (unavailable) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== PTT_KEY || e.repeat || keyHeldRef.current) return;
      e.preventDefault();
      keyHeldRef.current = true;
      start();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== PTT_KEY || !keyHeldRef.current) return;
      e.preventDefault();
      keyHeldRef.current = false;
      stop();
    };
    // A keyup delivered to another window never reaches us, which would strand
    // the mic open for as long as the app is in the background.
    const onBlur = () => {
      if (!keyHeldRef.current) return;
      keyHeldRef.current = false;
      stop();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [unavailable, start, stop]);

  // Never leave a mic open behind an unmounted composer.
  useEffect(() => () => engineRef.current?.stop(), []);

  const dismissError = useCallback(() => setError(null), []);

  return {
    listening,
    interim,
    error,
    unavailable,
    dismissError,
    pressStart,
    pressEnd,
    toggle,
    stop,
  };
}
