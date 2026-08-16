import { describe, it, expect, vi, afterEach } from "vitest";

import { composerPlaceholder } from "./submitHint.js";

/** jsdom-free environment: stub only what the module touches. */
function stubEnv(opts: { coarse: boolean; platform: string }): void {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({
      matches: query === "(pointer: coarse)" ? opts.coarse : false,
    }),
  });
  vi.stubGlobal("navigator", { platform: opts.platform });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("composerPlaceholder", () => {
  it("names the Command chord on a Mac", () => {
    stubEnv({ coarse: false, platform: "MacIntel" });
    expect(composerPlaceholder()).toBe("Message agent — ⌘↵ to send");
  });

  it("names the Control chord everywhere else", () => {
    stubEnv({ coarse: false, platform: "Win32" });
    expect(composerPlaceholder()).toBe("Message agent — Ctrl↵ to send");
    stubEnv({ coarse: false, platform: "Linux x86_64" });
    expect(composerPlaceholder()).toBe("Message agent — Ctrl↵ to send");
  });

  it("names no chord on a touch device, which has no modifier key to press", () => {
    stubEnv({ coarse: true, platform: "iPhone" });
    expect(composerPlaceholder()).toBe("Message agent");
    // iPadOS reports a Mac platform — the pointer, not the name, decides.
    stubEnv({ coarse: true, platform: "MacIntel" });
    expect(composerPlaceholder()).toBe("Message agent");
  });

  it("falls back to the Control chord with no window at all (SSR / headless)", () => {
    vi.stubGlobal("navigator", { platform: "" });
    expect(composerPlaceholder()).toBe("Message agent — Ctrl↵ to send");
  });
});
