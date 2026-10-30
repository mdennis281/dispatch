import { describe, it, expect, beforeEach } from "vitest";
import type { AttentionItem } from "@dispatch/shared";
import { useAttention } from "./attention.js";

const item = (
  kind: AttentionItem["kind"],
  over: Partial<AttentionItem> = {},
): AttentionItem => ({
  id: `${kind}-1`,
  chatId: "c1",
  kind,
  summary: kind,
  createdAt: 0,
  ...over,
});

beforeEach(() => {
  useAttention.setState({ items: [], visible: [], filter: { kinds: {}, reviewKinds: {} } });
});

describe("useAttention — queue filter", () => {
  it("keeps a muted item in `items` but out of `visible`", () => {
    useAttention.getState().setFilter({ kinds: { done: false }, reviewKinds: {} });
    useAttention.getState().hydrate([item("done"), item("permission")]);
    expect(useAttention.getState().items).toHaveLength(2);
    expect(useAttention.getState().visible.map((i) => i.kind)).toEqual(["permission"]);
  });

  it("shows what arrived while a kind was muted, the moment it is unmuted", () => {
    // The reason the raw list is kept: a display filter must not lose history,
    // or unmuting leaves a gap until the next event happens to fire.
    useAttention.getState().setFilter({ kinds: { done: false }, reviewKinds: {} });
    useAttention.getState().add(item("done"));
    expect(useAttention.getState().visible).toHaveLength(0);
    useAttention.getState().setFilter({ kinds: {}, reviewKinds: {} });
    expect(useAttention.getState().visible.map((i) => i.kind)).toEqual(["done"]);
  });

  it("keeps permissions and questions visible even if a stored filter mutes them", () => {
    // Only reachable through a hand-edited config.json — the Settings UI does not
    // offer those two rows — but `visible` is what the sidebar's "Needs input"
    // marker reads, so it must not be possible at all.
    useAttention
      .getState()
      .setFilter({ kinds: { permission: false, question: false }, reviewKinds: {} });
    useAttention.getState().hydrate([item("permission"), item("question")]);
    expect(useAttention.getState().visible).toHaveLength(2);
  });

  it("filters review rounds by sub-kind", () => {
    useAttention.getState().setFilter({ kinds: {}, reviewKinds: { passed: false } });
    useAttention.getState().hydrate([
      item("review", { id: "green", reviewKinds: ["passed"] }),
      item("review", { id: "red", reviewKinds: ["check"] }),
    ]);
    expect(useAttention.getState().visible.map((i) => i.id)).toEqual(["red"]);
  });

  it("keeps both lists sorted and in step through resolve and clearChat", () => {
    useAttention
      .getState()
      .hydrate([item("done"), item("permission"), item("question", { chatId: "c2" })]);
    expect(useAttention.getState().visible.map((i) => i.kind)).toEqual([
      "permission",
      "question",
      "done",
    ]);
    useAttention.getState().resolve("permission-1");
    expect(useAttention.getState().visible.map((i) => i.kind)).toEqual(["question", "done"]);
    useAttention.getState().clearChat("c2");
    expect(useAttention.getState().items.map((i) => i.kind)).toEqual(["done"]);
    expect(useAttention.getState().visible.map((i) => i.kind)).toEqual(["done"]);
  });
});

describe("useAttention — hydrate racing the socket", () => {
  // The reconnect hydrate applies its `/api/attention` snapshot only after seven
  // other reads return, and the socket keeps delivering events meanwhile.
  it("keeps an item resolved while the snapshot was in flight resolved", () => {
    // The 2026-10-29 bug: an answered question came back with the stale
    // snapshot and sat in the queue until a page reload.
    const q = item("question");
    useAttention.getState().add(q);
    useAttention.getState().beginSync();
    useAttention.getState().resolve(q.id);
    useAttention.getState().hydrate([q]);
    expect(useAttention.getState().items).toEqual([]);
  });

  it("keeps an item added while the snapshot was in flight", () => {
    const p = item("permission");
    useAttention.getState().beginSync();
    useAttention.getState().add(p);
    useAttention.getState().hydrate([item("done")]);
    expect(useAttention.getState().items.map((i) => i.id).sort()).toEqual(["done-1", "permission-1"]);
  });

  it("replays in arrival order, so a clear then a fresh add both survive", () => {
    useAttention.getState().beginSync();
    useAttention.getState().clearChat("c1");
    useAttention.getState().add(item("question", { id: "fresh" }));
    useAttention.getState().hydrate([item("idle"), item("done", { chatId: "c2" })]);
    expect(useAttention.getState().items.map((i) => i.id).sort()).toEqual(["done-1", "fresh"]);
  });

  it("holds the journal until the LAST overlapping hydrate lands", () => {
    const q = item("question");
    useAttention.getState().beginSync();
    useAttention.getState().beginSync();
    useAttention.getState().resolve(q.id);
    useAttention.getState().hydrate([q]);
    useAttention.getState().hydrate([q]);
    expect(useAttention.getState().items).toEqual([]);
    // …and stops journaling afterwards: a later plain hydrate is authoritative.
    useAttention.getState().resolve("gone");
    useAttention.getState().hydrate([item("question", { id: "gone" })]);
    expect(useAttention.getState().items.map((i) => i.id)).toEqual(["gone"]);
  });

  it("drops the journal when the snapshot request fails", () => {
    useAttention.getState().beginSync();
    useAttention.getState().resolve("q");
    useAttention.getState().abortSync();
    useAttention.getState().hydrate([item("question", { id: "q" })]);
    expect(useAttention.getState().items.map((i) => i.id)).toEqual(["q"]);
  });
});
