import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sessionFetch = vi.fn();
vi.mock("../stores/auth.js", () => ({ sessionFetch: (...args: unknown[]) => sessionFetch(...args) }));

const { assetSrcTarget, directSrc, loadAsset, __resetAssetCache } = await import("./assetSrc.js");

let created = 0;

beforeEach(() => {
  created = 0;
  sessionFetch.mockReset();
  // jsdom-free environment: stub only what the module touches.
  globalThis.URL.createObjectURL = vi.fn(() => `blob:stub/${++created}`);
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  __resetAssetCache();
});

const ok = () => ({ ok: true, status: 200, blob: async () => ({}) as Blob });

describe("directSrc", () => {
  it("passes through what the DOM can already render", () => {
    expect(directSrc("data:image/png;base64,AAA")).toBe("data:image/png;base64,AAA");
    expect(directSrc("blob:stub/1")).toBe("blob:stub/1");
    expect(directSrc("https://example.test/a.png")).toBe("https://example.test/a.png");
  });

  it("treats a stored asset path as needing a fetch", () => {
    expect(directSrc("assets/shot.png")).toBeNull();
  });
});

describe("assetSrcTarget", () => {
  it("maps a stored path to the chat's asset endpoint", () => {
    expect(assetSrcTarget("c1", "assets/shot.png")).toBe("/api/chats/c1/assets/shot.png");
  });

  it("leaves a directly renderable src alone", () => {
    expect(assetSrcTarget("c1", "data:image/png;base64,AAA")).toBe("data:image/png;base64,AAA");
  });
});

describe("loadAsset", () => {
  it("fetches through the authenticated session, not a bare <img> request", async () => {
    sessionFetch.mockResolvedValue(ok());
    await loadAsset("/api/chats/c1/assets/shot.png");
    expect(sessionFetch).toHaveBeenCalledWith("/api/chats/c1/assets/shot.png");
  });

  it("memoizes so a re-rendering transcript re-downloads nothing", async () => {
    sessionFetch.mockResolvedValue(ok());
    const first = await loadAsset("/api/chats/c1/assets/shot.png");
    const second = await loadAsset("/api/chats/c1/assets/shot.png");
    expect(second).toBe(first);
    expect(sessionFetch).toHaveBeenCalledTimes(1);
  });

  it("shares one request between concurrent callers", async () => {
    sessionFetch.mockResolvedValue(ok());
    const [a, b] = await Promise.all([
      loadAsset("/api/chats/c1/assets/shot.png"),
      loadAsset("/api/chats/c1/assets/shot.png"),
    ]);
    expect(a).toBe(b);
    expect(sessionFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects on a non-OK response", async () => {
    sessionFetch.mockResolvedValue({ ok: false, status: 401, blob: async () => ({}) as Blob });
    await expect(loadAsset("/api/chats/c1/assets/shot.png")).rejects.toThrow("asset 401");
  });

  it("does not memoize a failure, so a blip can recover", async () => {
    sessionFetch.mockResolvedValueOnce({ ok: false, status: 500, blob: async () => ({}) as Blob });
    await expect(loadAsset("/api/chats/c1/assets/shot.png")).rejects.toThrow();
    sessionFetch.mockResolvedValue(ok());
    await expect(loadAsset("/api/chats/c1/assets/shot.png")).resolves.toMatch(/^blob:/);
    expect(sessionFetch).toHaveBeenCalledTimes(2);
  });
});
