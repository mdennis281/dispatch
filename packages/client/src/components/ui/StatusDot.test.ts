import { describe, expect, it } from "vitest";
import { statusMeta, TONE_CLASS } from "./StatusDot.js";

describe("statusMeta", () => {
  it("uses blue for waits and red for unsuccessful exits", () => {
    expect(statusMeta("waiting")).toMatchObject({ tone: "info", label: "Waiting" });
    expect(statusMeta("failed")).toMatchObject({ tone: "danger", label: "Failed" });
    expect(statusMeta("error")).toMatchObject({ tone: "danger", label: "Error" });
  });
});

describe("TONE_CLASS", () => {
  // A status renders as a dot on most sidebar rows and as a glyph on a chat
  // spawned for a job. `Record<DotTone, …>` already forces both halves to exist;
  // what it can't catch is one half being recoloured — a `bg-success` paired
  // with a `text-warn` would show the same chat as done in one row and stalled
  // in another. Iterates the map itself so a new tone is covered on arrival.
  it("keeps each tone's dot and glyph on the same palette family", () => {
    for (const [tone, { bg, text }] of Object.entries(TONE_CLASS)) {
      expect(text, tone).toBe(bg.replace(/^bg-/, "text-"));
    }
  });
});
