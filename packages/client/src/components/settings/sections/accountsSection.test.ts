import { describe, it, expect } from "vitest";
import type { Subscription, SubscriptionStatus } from "@dispatch/shared";
import { liveAccountIds } from "./AccountsSection.js";

const status = (id: string, implicit?: boolean): SubscriptionStatus => ({
  id,
  name: id,
  provider: "claude",
  implicit,
  resolvedConfigDir: `/x/${id}`,
  dirExists: true,
  loggedIn: true,
  isDefault: false,
  atDefaultDir: false,
});

describe("liveAccountIds", () => {
  const rows: Subscription[] = [
    { id: "claude1", name: "One", provider: "claude", fallbacks: ["codex"] },
    { id: "claude2", name: "Two", provider: "claude" },
  ];

  it("counts the stored rows", () => {
    expect([...liveAccountIds(rows, [])].sort()).toEqual(["claude1", "claude2"]);
  });

  it("counts an IMPLICIT account, so saving does not strip an edge pointing at one", () => {
    // The regression this exists for: `claude1 → codex` is a legal edge (the
    // schema and `fallbackChain` both accept an implicit target), but `codex`
    // is not a stored row. Pruning against the rows alone dropped it on the
    // next unrelated save, and the list PUT is a full replace.
    const live = liveAccountIds(rows, [status("claude1"), status("claude2"), status("codex", true)]);
    expect(live.has("codex")).toBe(true);
    expect(rows[0]!.fallbacks!.filter((id) => live.has(id))).toEqual(["codex"]);
  });

  it("does not count an id that is neither stored nor implicit", () => {
    expect(liveAccountIds(rows, [status("codex", true)]).has("deleted")).toBe(false);
  });
});
