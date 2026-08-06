import { describe, it, expect, beforeEach } from "vitest";
import type { ImageRef } from "@dispatch/shared";
import {
  loadDraft,
  saveDraft,
  clearDraft,
  flushDrafts,
  appendDraftImage,
  pruneDrafts,
} from "./composerDrafts.js";

/** In-memory Storage stand-in — the node test env has no localStorage. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

const img = (id: string): ImageRef => ({ id, path: `assets/${id}.png`, mimeType: "image/png" });

const store = () => globalThis.localStorage;

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
  });
  flushDrafts(); // drop anything queued by a previous test
  store().clear();
});

describe("saveDraft / loadDraft", () => {
  it("round-trips text and images", () => {
    saveDraft("c1", { html: "<p>hi</p>", images: [img("a")] });
    flushDrafts();
    expect(loadDraft("c1")).toEqual({ html: "<p>hi</p>", images: [img("a")] });
  });

  it("keeps images for a draft with no text", () => {
    // The whole point: a pasted screenshot with nothing typed still survives.
    saveDraft("c1", { html: "", images: [img("a")] });
    flushDrafts();
    expect(loadDraft("c1").images).toEqual([img("a")]);
  });

  it("reads back a queued draft before it has been flushed", () => {
    saveDraft("c1", { html: "<p>typing</p>", images: [] });
    expect(loadDraft("c1").html).toBe("<p>typing</p>");
  });

  it("keys drafts per chat", () => {
    saveDraft("c1", { html: "<p>one</p>", images: [] });
    saveDraft("c2", { html: "<p>two</p>", images: [img("b")] });
    flushDrafts();
    expect(loadDraft("c1")).toEqual({ html: "<p>one</p>", images: [] });
    expect(loadDraft("c2")).toEqual({ html: "<p>two</p>", images: [img("b")] });
  });

  it("returns an empty draft for an unknown chat", () => {
    expect(loadDraft("nope")).toEqual({ html: "", images: [] });
  });

  it("removes the entry when a draft goes empty", () => {
    saveDraft("c1", { html: "<p>hi</p>", images: [] });
    flushDrafts();
    saveDraft("c1", { html: "", images: [] });
    expect(loadDraft("c1")).toEqual({ html: "", images: [] });
    expect(store().getItem("cm:draft:c1")).toBeNull();
  });

  it("treats whitespace-only text with no images as empty", () => {
    saveDraft("c1", { html: "<p></p>", images: [] });
    flushDrafts();
    expect(store().getItem("cm:draft:c1")).toBeNull();
  });
});

describe("clearDraft", () => {
  it("drops both the stored and the queued copy", () => {
    saveDraft("c1", { html: "<p>hi</p>", images: [img("a")] });
    flushDrafts();
    saveDraft("c1", { html: "<p>hi there</p>", images: [img("a")] });
    clearDraft("c1");
    flushDrafts();
    expect(loadDraft("c1")).toEqual({ html: "", images: [] });
  });
});

describe("appendDraftImage", () => {
  it("adds to a background chat's saved draft without disturbing its text", () => {
    saveDraft("c1", { html: "<p>hi</p>", images: [img("a")] });
    flushDrafts();
    appendDraftImage("c1", img("b"));
    flushDrafts();
    expect(loadDraft("c1")).toEqual({ html: "<p>hi</p>", images: [img("a"), img("b")] });
  });

  it("creates a draft for a chat that had none", () => {
    appendDraftImage("c9", img("z"));
    flushDrafts();
    expect(loadDraft("c9")).toEqual({ html: "", images: [img("z")] });
  });
});

describe("parsing", () => {
  it("ignores a malformed entry", () => {
    store().setItem("cm:draft:c1", "{not json");
    expect(loadDraft("c1")).toEqual({ html: "", images: [] });
  });

  it("drops image entries that aren't refs", () => {
    store().setItem(
      "cm:draft:c1",
      JSON.stringify({ html: "<p>hi</p>", images: [img("a"), null, { id: 1 }], at: Date.now() }),
    );
    expect(loadDraft("c1")).toEqual({ html: "<p>hi</p>", images: [img("a")] });
  });

  it("ignores a draft older than the max age", () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    store().setItem("cm:draft:c1", JSON.stringify({ html: "<p>hi</p>", images: [], at: old }));
    expect(loadDraft("c1")).toEqual({ html: "", images: [] });
  });
});

describe("pruneDrafts", () => {
  it("sweeps expired keys and leaves fresh ones (and other keys) alone", () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    store().setItem("cm:draft:stale", JSON.stringify({ html: "<p>x</p>", images: [], at: old }));
    store().setItem("cm:draft:fresh", JSON.stringify({ html: "<p>y</p>", images: [], at: Date.now() }));
    store().setItem("cm:theme", "dark");
    pruneDrafts();
    expect(store().getItem("cm:draft:stale")).toBeNull();
    expect(loadDraft("fresh").html).toBe("<p>y</p>");
    expect(store().getItem("cm:theme")).toBe("dark");
  });
});
