import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  appendSpoken,
  createDictation,
  pressOutcome,
  unavailableReason,
  HOLD_MS,
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

function stubEnv(opts: { ctor?: unknown; ua?: string } = {}) {
  vi.stubGlobal("window", opts.ctor === undefined ? {} : { SpeechRecognition: opts.ctor });
  vi.stubGlobal("navigator", { language: "en-US", userAgent: opts.ua ?? CHROME_UA });
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

describe("unavailableReason", () => {
  it("is null when the browser has recognition", () => {
    stubEnv({ ctor: FakeSR });
    expect(unavailableReason()).toBeNull();
  });

  it("names a browser that will work when this one has no speech API", () => {
    stubEnv({ ua: CHROME_UA });
    expect(unavailableReason()).toMatch(/doesn't support speech recognition/);
  });
});

describe("createDictation", () => {
  it("returns null when the platform has no recognition at all", () => {
    stubEnv();
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

  it("treats a network error as a connection problem, and stops", () => {
    stubEnv({ ctor: FakeSR });
    const { h, errors, stopped } = handlers();
    createDictation(h)!.start();

    FakeSR.live().fail("network");

    expect(errors[0]).toMatch(/unreachable/);
    expect(stopped()).toBe(1);
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
