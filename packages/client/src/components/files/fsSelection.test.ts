import { describe, it, expect } from "vitest";
import { fsIsSelectable, type FsEntry } from "@dispatch/shared";
import { rangeSelection, nextCursor, pruneSelection } from "./fsSelection.js";

const entry = (name: string, kind: FsEntry["kind"] = "file"): FsEntry => ({
  name,
  path: `/x/${name}`,
  kind,
  size: 0,
  modifiedAt: 0,
  createdAt: null,
  accessedAt: null,
  ext: name.includes(".") ? (name.split(".").pop() ?? "") : "",
  hidden: false,
});

const anything = () => true;

describe("rangeSelection", () => {
  const list = [entry("a"), entry("b"), entry("c"), entry("d")];

  it("takes everything between anchor and target, inclusive", () => {
    expect(rangeSelection(list, "/x/b", "/x/d", anything)).toEqual(["/x/b", "/x/c", "/x/d"]);
  });

  it("works the same when the target is ABOVE the anchor", () => {
    expect(rangeSelection(list, "/x/d", "/x/b", anything)).toEqual(["/x/b", "/x/c", "/x/d"]);
  });

  it("uses DISPLAY order, not path order", () => {
    // The very bug this exists to prevent: sorted by size, the on-screen order
    // is c, a, d, b — shift-clicking c then d must take the rows in between as
    // SEEN, not the alphabetically-adjacent ones.
    const bySize = [entry("c"), entry("a"), entry("d"), entry("b")];
    expect(rangeSelection(bySize, "/x/c", "/x/d", anything)).toEqual(["/x/c", "/x/a", "/x/d"]);
  });

  it("selects just the target when there is no anchor", () => {
    expect(rangeSelection(list, null, "/x/c", anything)).toEqual(["/x/c"]);
  });

  it("degrades to the target when the anchor has vanished from the list", () => {
    // A refresh dropped the anchored row; shift-click should still do something
    // sensible rather than selecting nothing or everything.
    expect(rangeSelection(list, "/x/gone", "/x/c", anything)).toEqual(["/x/c"]);
  });

  it("returns nothing when the target itself isn't listed", () => {
    expect(rangeSelection(list, "/x/a", "/x/gone", anything)).toEqual([]);
  });

  it("skips rows the picker won't accept", () => {
    // A files-only picker shift-selecting across a folder takes the files and
    // leaves the folder — offering it would produce an answer that fails the
    // caller's own filter.
    const mixed = [entry("a.txt"), entry("stuff", "directory"), entry("b.txt")];
    const filesOnly = (e: FsEntry) => fsIsSelectable(e, { select: "file" });
    expect(rangeSelection(mixed, "/x/a.txt", "/x/b.txt", filesOnly)).toEqual([
      "/x/a.txt",
      "/x/b.txt",
    ]);
  });

  it("handles a single-row range", () => {
    expect(rangeSelection(list, "/x/b", "/x/b", anything)).toEqual(["/x/b"]);
  });

  it("returns nothing for an empty list", () => {
    expect(rangeSelection([], "/x/a", "/x/b", anything)).toEqual([]);
  });
});

describe("nextCursor", () => {
  const list = [entry("a"), entry("b"), entry("c")];

  it("moves down and up", () => {
    expect(nextCursor(list, "/x/a", 1)?.name).toBe("b");
    expect(nextCursor(list, "/x/b", -1)?.name).toBe("a");
  });

  it("wraps at both ends", () => {
    expect(nextCursor(list, "/x/c", 1)?.name).toBe("a");
    // JS `%` keeps the sign, so this is the case a naive modulo gets wrong.
    expect(nextCursor(list, "/x/a", -1)?.name).toBe("c");
  });

  it("starts at the top going down and the bottom going up", () => {
    expect(nextCursor(list, null, 1)?.name).toBe("a");
    expect(nextCursor(list, null, -1)?.name).toBe("c");
  });

  it("treats a vanished cursor as no cursor", () => {
    expect(nextCursor(list, "/x/gone", 1)?.name).toBe("a");
  });

  it("returns null for an empty list instead of dividing by zero", () => {
    expect(nextCursor([], null, 1)).toBeNull();
    expect(nextCursor([], "/x/a", -1)).toBeNull();
  });
});

describe("pruneSelection", () => {
  it("drops paths that are no longer listed", () => {
    // Otherwise Delete acts on rows that aren't on screen.
    const list = [entry("a"), entry("b")];
    expect(pruneSelection(list, ["/x/a", "/x/gone"])).toEqual(["/x/a"]);
  });

  it("keeps the surviving order", () => {
    const list = [entry("a"), entry("b"), entry("c")];
    expect(pruneSelection(list, ["/x/c", "/x/a"])).toEqual(["/x/c", "/x/a"]);
  });

  it("empties out when nothing survives", () => {
    expect(pruneSelection([], ["/x/a"])).toEqual([]);
  });
});
