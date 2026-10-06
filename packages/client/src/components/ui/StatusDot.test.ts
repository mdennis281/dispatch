import { describe, expect, it } from "vitest";
import { statusMeta, TONE_CLASS } from "./StatusDot.js";

describe("statusMeta", () => {
  it("uses blue for waits and red for unsuccessful exits", () => {
    expect(statusMeta("waiting")).toMatchObject({ tone: "info", label: "Waiting" });
    expect(statusMeta("failed")).toMatchObject({ tone: "danger", label: "Failed" });
    expect(statusMeta("error")).toMatchObject({ tone: "danger", label: "Error" });
  });

  // A chat that has never run shares idle's grey, so fill is the whole signal:
  // the row that dragged a branch into "New" is the hollow one.
  it("draws a never-run chat hollow, and an idle one filled", () => {
    expect(statusMeta("idle", false, true)).toMatchObject({
      tone: "muted",
      label: "New",
      hollow: true,
    });
    expect(statusMeta("idle").hollow).toBeFalsy();
  });

  // The trap this guards: a FIRST turn has no session id either — it lands with
  // the init event — so an unstarted chat that is already streaming must read as
  // what it's doing, not as new. Same precedence `chatSection` uses, which is
  // what keeps the marker agreeing with the queue the row is filed in.
  it("lets any live status outrank never-run", () => {
    expect(statusMeta("running", false, true)).toMatchObject({ label: "Running", tone: "working" });
    expect(statusMeta("queued", false, true)).toMatchObject({ label: "Queued" });
    expect(statusMeta("awaiting-input", false, true)).toMatchObject({ label: "Awaiting input" });
    expect(statusMeta("failed", false, true)).toMatchObject({ label: "Failed", tone: "danger" });
    for (const status of ["running", "queued", "awaiting-input", "failed"] as const) {
      expect(statusMeta(status, false, true).hollow, status).toBeFalsy();
    }
  });

  // `prSettled` wins its own race by being impossible to lose: a chat that never
  // ran has no PR to have settled. Pinned so the ordering is a decision, not an
  // accident of which `if` came first.
  it("prefers a settled PR over never-run", () => {
    expect(statusMeta("idle", true, true)).toMatchObject({ tone: "success", label: "PR done" });
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
