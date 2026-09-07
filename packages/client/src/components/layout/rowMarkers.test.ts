import { describe, it, expect } from "vitest";
import type { Chat, ChatStatus } from "@dispatch/shared";
import {
  canReapBranch,
  childChatTint,
  childChatTitle,
  processTint,
  processTitle,
} from "./rowMarkers.js";

/** A reviewer chat in a given state, the way `launchAgentTask` records it. */
function child(id: string, status?: ChatStatus, reviewOf = "o/r#140"): Chat {
  return {
    id,
    projectId: "p1",
    title: "review",
    createdAt: 0,
    updatedAt: 0,
    reviewOf,
    ...(status ? { status } : {}),
  } as Chat;
}

describe("childChatTint — the three states the row is asked for", () => {
  it("is faint with no children, ordinary text with children at rest", () => {
    // Faint IS the empty state — the glyph is always mounted so the titles line
    // up, so "nothing to report" has to be a colour rather than an absence.
    expect(childChatTint([], false)).toBe("text-faint");
    expect(childChatTint([child("r1", "idle")], false)).toBe("text-secondary");
  });

  it("takes the brand accent the moment ANY child is mid-turn", () => {
    expect(childChatTint([child("r1", "idle"), child("r2", "running")], false)).toBe(
      "text-accent",
    );
  });

  it("counts every mid-turn status, not just the one called `running`", () => {
    // `waiting` is what the broker assigns a tool blocked on work elsewhere — a
    // `watch_pr` sitting on a PR for ten minutes. Its own row pulses throughout;
    // a parent glyph reading "at rest" through that is quiet for exactly the
    // long block worth knowing about. `queued` has the same shape.
    for (const status of ["running", "waiting", "queued"] as const) {
      expect(childChatTint([child("r1", status)], false)).toBe("text-accent");
    }
    for (const status of ["idle", "done", "error"] as const) {
      expect(childChatTint([child("r1", status)], false)).toBe("text-secondary");
    }
  });

  it("lets a child that needs an answer outrank a child that is running", () => {
    // The parent's own attention dot says nothing about its children, so on a
    // collapsed row this is the only signal that somebody is waiting on you.
    expect(childChatTint([child("r1", "running")], true)).toBe("text-warn");
  });
});

describe("childChatTitle — the count the glyph no longer prints", () => {
  it("says so plainly when there are none", () => {
    expect(childChatTitle([], false)).toBe("No child chats");
  });

  it("carries the PR breakdown plus what they are doing", () => {
    expect(childChatTitle([child("r1", "running"), child("r2", "idle")], false)).toBe(
      "2 reviews of #140 — 1 working",
    );
    expect(childChatTitle([child("r1", "idle")], false)).toBe("1 review of #140 — all idle");
    expect(childChatTitle([child("r1", "awaiting-input")], true)).toBe(
      "1 review of #140 — needs an answer",
    );
  });

  it("counts a blocked child as working, exactly as the tint does", () => {
    // The tooltip and the colour read the same predicate — a glyph that lit up
    // over a label saying "all idle" would be two answers to one question.
    expect(childChatTitle([child("r1", "waiting"), child("r2", "queued")], false)).toBe(
      "2 reviews of #140 — 2 working",
    );
  });
});

describe("processTint — one glyph for what used to be two", () => {
  it("splits the two lifetimes by colour, and mixes them when both are held", () => {
    // Blue is reclaimable (the idle sweep takes the session tree), green is not
    // (a dev server is yours until you say otherwise), violet is BOTH — the same
    // "and" the two-glyph version drew by sitting next to each other.
    expect(processTint({ session: 0, shells: 0 })).toBe("text-faint");
    expect(processTint({ session: 3, shells: 0 })).toBe("text-info");
    expect(processTint({ session: 0, shells: 1 })).toBe("text-success");
    expect(processTint({ session: 3, shells: 1 })).toBe("text-accent-2");
  });
});

describe("processTitle — the halves stay named even though the glyph merged them", () => {
  it("lists shells first, and each half only when it has something", () => {
    expect(processTitle({ session: 0, shells: 0 })).toBe("No processes");
    expect(processTitle({ session: 1, shells: 0 })).toBe("1 session process");
    expect(processTitle({ session: 2, shells: 1 })).toBe(
      "1 background shell, 2 session processes",
    );
  });
});

describe("canReapBranch — when the row offers a one-click kill", () => {
  const held = { session: 3, shells: 1 };

  it("stays away from a branch holding nothing", () => {
    // Nothing to reap is not a disabled button, it is no button: the tray is
    // four icons wide and a permanently dead one costs a slot on every row.
    expect(canReapBranch({ session: 0, shells: 0 }, "idle", [])).toBe(false);
  });

  it("offers it for a parked branch that never let go of its processes", () => {
    expect(canReapBranch(held, "idle", [])).toBe(true);
    expect(canReapBranch(held, "done", [child("r1", "done")])).toBe(true);
    expect(canReapBranch(held, "error", [child("r1", "error")])).toBe(true);
  });

  it("withholds it while ANY chat on the branch is mid-turn", () => {
    // Including `waiting` and `queued`. A reviewer parked on `watch_pr` reports
    // `waiting` for as long as CI takes, and that is the single longest window
    // in which an accidental click would cost real work.
    for (const status of ["running", "waiting", "queued"] as const) {
      expect(canReapBranch(held, status, [])).toBe(false);
      expect(canReapBranch(held, "idle", [child("r1", status)])).toBe(false);
    }
  });

  it("counts the branch's shells, not just its session tree", () => {
    // A dev server with the session already swept still has something to reap.
    expect(canReapBranch({ session: 0, shells: 1 }, "idle", [])).toBe(true);
  });
});
