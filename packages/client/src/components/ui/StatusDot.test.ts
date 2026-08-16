import { describe, expect, it } from "vitest";
import { statusMeta, toneText, type DotTone } from "./StatusDot.js";

describe("statusMeta", () => {
  it("uses blue for waits and red for unsuccessful exits", () => {
    expect(statusMeta("waiting")).toMatchObject({ tone: "info", label: "Waiting" });
    expect(statusMeta("failed")).toMatchObject({ tone: "danger", label: "Failed" });
    expect(statusMeta("error")).toMatchObject({ tone: "danger", label: "Error" });
  });
});

describe("toneText", () => {
  // Sidebar rows render a status EITHER as a dot or as the spawning job's icon.
  // A tone missing here renders the icon in whatever colour it inherits, which
  // silently reads as "idle" — so every tone must have a foreground class.
  it("covers every tone a dot can take", () => {
    const tones: DotTone[] = [
      "success",
      "accent",
      "info",
      "warn",
      "danger",
      "muted",
      "working",
    ];
    for (const tone of tones) expect(toneText[tone]).toMatch(/^text-/);
  });
});
