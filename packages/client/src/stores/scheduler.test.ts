import { describe, expect, it } from "vitest";
import type { SchedulerSnapshot } from "@dispatch/shared";
import { displayStatus, isResumeQueued } from "./scheduler.js";

function snapshot(queued: SchedulerSnapshot["queued"]): SchedulerSnapshot {
  return { paused: null, projectPauses: {}, chatPauses: {}, cap: 4, lent: 0, running: [], queued };
}

describe("isResumeQueued", () => {
  it("is true only for a RESUME entry for this chat", () => {
    const snap = snapshot([
      { chatId: "parked", kind: "resume", tier: 2 },
      { chatId: "cold", kind: "start", tier: 3 },
    ]);
    expect(isResumeQueued(snap, "parked")).toBe(true);
    // A cold start already carries `queued` as its own status; nothing to redraw.
    expect(isResumeQueued(snap, "cold")).toBe(false);
    expect(isResumeQueued(snap, "elsewhere")).toBe(false);
    expect(isResumeQueued(null, "parked")).toBe(false);
  });
});

describe("displayStatus", () => {
  // The bug: a chat whose `watch_pr` had answered but whose answer was held for
  // a slot read "Waiting", the same word and blue as a chat still parked on CI —
  // when it was the one the human could push through with Run now.
  it("draws a chat parked to resume as Queued", () => {
    expect(displayStatus("waiting", true)).toBe("queued");
    // A permission answered at a full cap parks before the status moves on.
    expect(displayStatus("awaiting-input", true)).toBe("queued");
    expect(displayStatus("running", true)).toBe("queued");
  });

  it("leaves every status alone when nothing is parked", () => {
    for (const status of ["waiting", "running", "awaiting-input", "idle", "queued"] as const) {
      expect(displayStatus(status, false)).toBe(status);
    }
  });

  // A stale snapshot can still name a chat whose turn already ended; the turn's
  // own resting status is the truth then.
  it("never paints a finished chat as Queued", () => {
    for (const status of ["idle", "done", "failed", "error"] as const) {
      expect(displayStatus(status, true)).toBe(status);
    }
    expect(displayStatus(undefined, true)).toBeUndefined();
  });
});
