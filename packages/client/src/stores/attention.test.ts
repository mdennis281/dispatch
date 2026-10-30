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
  const att = () => useAttention.getState();
  const ids = () => att().items.map((i) => i.id).sort();

  it("keeps an item resolved while the snapshot was in flight resolved", () => {
    // The 2026-10-29 bug: an answered question came back with the stale
    // snapshot and sat in the queue until a page reload.
    const q = item("question");
    att().add(q);
    const sync = att().beginSync();
    att().resolve(q.id);
    att().hydrate([q], sync);
    expect(att().items).toEqual([]);
  });

  it("keeps an item added while the snapshot was in flight", () => {
    const sync = att().beginSync();
    att().add(item("permission"));
    att().hydrate([item("done")], sync);
    expect(ids()).toEqual(["done-1", "permission-1"]);
  });

  it("replays in arrival order, so a clear then a fresh add both survive", () => {
    const sync = att().beginSync();
    att().clearChat("c1");
    att().add(item("question", { id: "fresh" }));
    att().hydrate([item("idle"), item("done", { chatId: "c2" })], sync);
    expect(ids()).toEqual(["done-1", "fresh"]);
  });

  it("replays to a later overlapping sync only what arrived after IT began", () => {
    // Review finding on #463: with one shared journal, B replayed A's `add(q)`
    // over a snapshot taken after `q` was resolved (the resolve itself was
    // missed while the socket was down), resurrecting it.
    const q = item("question");
    const a = att().beginSync();
    att().add(q);
    const b = att().beginSync();
    att().hydrate([], a);
    expect(ids()).toEqual(["question-1"]);
    att().hydrate([], b);
    expect(att().items).toEqual([]);
  });

  it("holds the journal for a sync still in flight after another lands", () => {
    const q = item("question");
    const a = att().beginSync();
    const b = att().beginSync();
    att().resolve(q.id);
    att().hydrate([q], a);
    att().hydrate([q], b);
    expect(att().items).toEqual([]);
    // …and stops journaling afterwards: an untokened hydrate is authoritative.
    att().resolve("gone");
    att().hydrate([item("question", { id: "gone" })]);
    expect(ids()).toEqual(["gone"]);
  });

  it("drops the journal when the snapshot request fails", () => {
    const failed = att().beginSync();
    att().resolve("q");
    att().abortSync(failed);
    const next = att().beginSync();
    att().hydrate([item("question", { id: "q" })], next);
    expect(ids()).toEqual(["q"]);
  });
});
