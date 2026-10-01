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
