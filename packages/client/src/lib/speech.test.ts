import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  appendSpoken,
  createDictation,
  pressOutcome,
  unavailableReason,
  engineKind,
  HOLD_MS,
  DESKTOP_HINT,
  type DictationHandlers,
} from "./speech.js";

/** A stand-in for Chrome's SpeechRecognition, driven by the test. */
class FakeSR {
  static instances: FakeSR[] = [];
  static reset() {
    FakeSR.instances = [];
  }

  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;
  started = false;

  constructor() {
    FakeSR.instances.push(this);
  }

  start() {
    this.started = true;
    this.onstart?.();
  }
  stop() {
    this.started = false;
    this.onend?.();
  }
  abort() {
    this.stop();
  }

  /** The live instance is the last one constructed. */
  static live(): FakeSR {
    const last = FakeSR.instances[FakeSR.instances.length - 1];
    if (!last) throw new Error("no recognition instance");
    return last;
  }

  emit(phrases: { text: string; final: boolean }[]) {
    const results = phrases.map((p) => {
      const alt = [{ transcript: p.text }] as unknown as {
        0: { transcript: string };
        isFinal: boolean;
        length: number;
      };
      alt.isFinal = p.final;
      return alt;
    });
    this.onresult?.({ resultIndex: 0, results });
  }

  fail(code: string) {
    this.onerror?.({ error: code });
  }
}

function handlers() {
  const finals: string[] = [];
  const interims: string[] = [];
  const errors: string[] = [];
  let stops = 0;
  const h: DictationHandlers = {
    onFinal: (t) => finals.push(t),
    onInterim: (t) => interims.push(t),
    onError: (m) => errors.push(m),
    onStopped: () => {
      stops += 1;
    },
  };
  return { h, finals, interims, errors, stopped: () => stops };
}

const CHROME_UA = "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36";
const ELECTRON_UA = "Mozilla/5.0 Chrome/130.0.0.0 Electron/33.4.11 Safari/537.36";

function stubEnv(opts: { ctor?: unknown; ua?: string; canRecord?: boolean } = {}) {
  vi.stubGlobal("window", opts.ctor === undefined ? {} : { SpeechRecognition: opts.ctor });
  vi.stubGlobal("navigator", {
    language: "en-US",
    userAgent: opts.ua ?? CHROME_UA,
    ...(opts.canRecord ? { mediaDevices: { getUserMedia: () => {} } } : {}),
  });
  // The three APIs the local engine records with — absent in the node test env
  // unless a test says the browser has them.
  vi.stubGlobal("Worker", opts.canRecord ? class {} : undefined);
  vi.stubGlobal("MediaRecorder", opts.canRecord ? class {} : undefined);
  vi.stubGlobal("AudioContext", opts.canRecord ? class {} : undefined);
}

beforeEach(() => {
  FakeSR.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("pressOutcome", () => {
  it("treats a quick press as a tap that latches the mic on", () => {
    expect(pressOutcome(0)).toBe("latch");
    expect(pressOutcome(HOLD_MS - 1)).toBe("latch");
  });

  it("treats a sustained press as push-to-talk, ending on release", () => {
    expect(pressOutcome(HOLD_MS)).toBe("release");
    expect(pressOutcome(5_000)).toBe("release");
  });
});

describe("appendSpoken", () => {
  it("does not lead with a space when the draft is empty", () => {
    expect(appendSpoken("", "hello there")).toBe("hello there");
  });

  it("separates from existing text with exactly one space", () => {
    expect(appendSpoken("ship it", "when tests pass")).toBe("ship it when tests pass");
    expect(appendSpoken("ship it ", "when tests pass")).toBe("ship it when tests pass");
    expect(appendSpoken("ship it\n\n", "when tests pass")).toBe("ship it when tests pass");
  });
});

describe("engineKind", () => {
  it("uses Web Speech in a browser that has it — live interim text is worth it", () => {
    stubEnv({ ctor: FakeSR });
    expect(engineKind()).toBe("web-speech");
  });

  it("always uses local Whisper in Electron, even though the API is present", () => {
    // Measured: Electron HAS webkitSpeechRecognition and it always fails with
    // `network`. Trying it first would only ever cost the user a failed take.
    stubEnv({ ctor: FakeSR, ua: ELECTRON_UA });
    expect(engineKind()).toBe("whisper");
  });

  it("falls back to Whisper in a browser with no speech API", () => {
    stubEnv({ ua: CHROME_UA });
    expect(engineKind()).toBe("whisper");
  });
});

describe("unavailableReason", () => {
  it("is null when the browser has recognition", () => {
    stubEnv({ ctor: FakeSR });
    expect(unavailableReason()).toBeNull();
  });

  it("is null on the Whisper path when the browser can record", () => {
    stubEnv({ ctor: FakeSR, ua: ELECTRON_UA, canRecord: true });
    expect(unavailableReason()).toBeNull();
  });

  it("rules dictation out only when the browser cannot record at all", () => {
    stubEnv({ ua: CHROME_UA }); // whisper path, no recording APIs stubbed
    expect(unavailableReason()).toMatch(/can't record audio/);
  });
});

describe("createDictation", () => {
  it("returns null when the platform has no recognition at all", () => {
    stubEnv({ ua: ELECTRON_UA });
    expect(createDictation(handlers().h)).toBeNull();
  });

  it("reports final phrases and the interim guess separately", () => {
    stubEnv({ ctor: FakeSR });
    const { h, finals, interims } = handlers();
    createDictation(h)!.start();

    FakeSR.live().emit([{ text: "  commit the fix  ", final: true }]);
    FakeSR.live().emit([{ text: "and then push", final: false }]);

    expect(finals).toEqual(["commit the fix"]);
    expect(interims.at(-1)).toBe("and then push");
  });

  it("restarts silently when the engine times out on silence", () => {
    stubEnv({ ctor: FakeSR });
    const { h, errors, stopped } = handlers();
    createDictation(h)!.start();
    expect(FakeSR.instances).toHaveLength(1);

    // Chrome ends the session after a long pause; the user still wants the mic.
    vi.advanceTimersByTime(5_000);
    FakeSR.live().onend?.();

    expect(FakeSR.instances).toHaveLength(2);
    expect(FakeSR.live().started).toBe(true);
    expect(errors).toEqual([]);
    expect(stopped()).toBe(0);
  });

  it("gives up instead of spinning when the engine ends instantly, every time", () => {
    stubEnv({ ctor: FakeSR });
    const { h, errors, stopped } = handlers();
    createDictation(h)!.start();

    // No time passes between start and end — the signature of an engine that is
    // refusing rather than idling.
    for (let i = 0; i < 6; i++) FakeSR.live().onend?.();

    expect(errors).toHaveLength(1);
    expect(stopped()).toBe(1);
    // Bounded: it stopped rebuilding recognizers rather than looping forever.
    expect(FakeSR.instances.length).toBeLessThanOrEqual(5);
  });

  it("keeps listening through a silent pause, which is not an error", () => {
    stubEnv({ ctor: FakeSR });
    const { h, errors, stopped } = handlers();
    createDictation(h)!.start();

    FakeSR.live().fail("no-speech");

    expect(errors).toEqual([]);
    expect(stopped()).toBe(0);
  });

  it("surfaces a blocked microphone, and stops", () => {
    stubEnv({ ctor: FakeSR });
    const { h, errors, stopped } = handlers();
    createDictation(h)!.start();

    FakeSR.live().fail("not-allowed");

    expect(errors[0]).toMatch(/Microphone access was blocked/);
    expect(stopped()).toBe(1);
  });

  it("does not blame the desktop shell for a real permission denial", () => {
    // Electron enumerates mics and grants media permissions normally (measured),
    // so `not-allowed` there means what it says.
    stubEnv({ ctor: FakeSR, ua: ELECTRON_UA });
    const { h, errors } = handlers();
    createDictation(h)!.start();

    FakeSR.live().fail("not-allowed");

    expect(errors[0]).toMatch(/Microphone access was blocked/);
    expect(errors[0]).not.toBe(DESKTOP_HINT);
  });

  it("explains Electron's missing speech service on the error it actually emits", () => {
    // Measured signature in Electron 33: audiostart, then `network`.
    stubEnv({ ctor: FakeSR, ua: ELECTRON_UA });
    const { h, errors, stopped } = handlers();
    createDictation(h)!.start();

    FakeSR.live().fail("network");

    expect(errors[0]).toBe(DESKTOP_HINT);
    expect(stopped()).toBe(1);
  });

  it("treats a network error in a real browser as a connection problem", () => {
    stubEnv({ ctor: FakeSR, ua: CHROME_UA });
    const { h, errors } = handlers();
    createDictation(h)!.start();

    FakeSR.live().fail("network");

    expect(errors[0]).toMatch(/unreachable/);
    expect(errors[0]).not.toBe(DESKTOP_HINT);
  });

  it("stops cleanly, and stays stopped", () => {
    stubEnv({ ctor: FakeSR });
    const { h, stopped } = handlers();
    const engine = createDictation(h)!;
    engine.start();

    engine.stop();
    expect(stopped()).toBe(1);
    expect(FakeSR.live().started).toBe(false);

    // A second stop is a no-op, not a second teardown.
    engine.stop();
    expect(stopped()).toBe(1);
    expect(FakeSR.instances).toHaveLength(1);
  });
});
