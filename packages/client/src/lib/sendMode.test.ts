import { describe, it, expect } from "vitest";
import { sendModeFromKey, sendModeKeyHint, SEND_MODES } from "./sendMode.js";

function key(k: string, mods: { mod?: boolean; shift?: boolean } = {}) {
  return { key: k, metaKey: false, ctrlKey: !!mods.mod, shiftKey: !!mods.shift };
}

describe("sendModeFromKey", () => {
  it("maps each chord to its mode while a turn is running", () => {
    const running = { running: true, appDefault: "steer" as const };
    expect(sendModeFromKey(key("Enter", { mod: true }), running)).toBe("steer");
    expect(sendModeFromKey(key("Enter", { shift: true }), running)).toBe("queue");
    expect(sendModeFromKey(key("Enter", { mod: true, shift: true }), running)).toBe("interrupt");
  });

  it("treats mod+Enter as the app's default, so the chord and the button agree", () => {
    // The whole reason the default is settable: someone who pinned Queue expects
    // their main chord to queue, not to steer.
    expect(sendModeFromKey(key("Enter", { mod: true }), { running: true, appDefault: "queue" })).toBe(
      "queue",
    );
    // The explicit chords never drift with it.
    expect(
      sendModeFromKey(key("Enter", { shift: true }), { running: true, appDefault: "interrupt" }),
    ).toBe("queue");
  });

  it("leaves bare shift+Enter alone when nothing is running — it is still the newline", () => {
    const idle = { running: false, appDefault: "queue" as const };
    expect(sendModeFromKey(key("Enter", { shift: true }), idle)).toBeNull();
    // mod+Enter still SENDS, and with the plain default: an idle chat has no turn
    // to queue behind, so honouring the pin here would mean nothing.
    expect(sendModeFromKey(key("Enter", { mod: true }), idle)).toBe("steer");
    // A stray shift must not turn the send chord into a no-op.
    expect(sendModeFromKey(key("Enter", { mod: true, shift: true }), idle)).toBe("steer");
  });

  it("claims nothing but Enter", () => {
    const running = { running: true, appDefault: "steer" as const };
    expect(sendModeFromKey(key("a", { mod: true }), running)).toBeNull();
    expect(sendModeFromKey(key("Tab", { shift: true }), running)).toBeNull();
    expect(sendModeFromKey(key("Enter"), running)).toBeNull();
  });

  it("reads the Mac modifier as ⌘ and everything else as Ctrl, never both", () => {
    expect(sendModeKeyHint("steer", true)).toBe("⌘↵");
    expect(sendModeKeyHint("steer", false)).toBe("Ctrl↵");
    expect(sendModeKeyHint("interrupt", true)).toBe("⌘⇧↵");
    expect(sendModeKeyHint("interrupt", false)).toBe("Ctrl⇧↵");
    // Queue is modifier-free, so it reads the same on every machine.
    expect(sendModeKeyHint("queue", true)).toBe("⇧↵");
    for (const mode of SEND_MODES) {
      expect(sendModeKeyHint(mode, true)).not.toContain("Ctrl");
      expect(sendModeKeyHint(mode, false)).not.toContain("⌘");
    }
  });

  it("gives every mode a distinct chord", () => {
    const hints = SEND_MODES.map((m) => sendModeKeyHint(m, false));
    expect(new Set(hints).size).toBe(SEND_MODES.length);
  });
});
