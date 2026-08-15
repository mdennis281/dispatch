/**
 * The rules that decide whether an update surface appears at all.
 *
 * Two of them are easy to break and expensive to break: a build run from source
 * must never show an update control (`supported: false`), and dismissing a
 * release must silence only THAT release — a boolean or a timestamp here would
 * either nag about an update you rejected or hide the next one you never saw.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { UpdateStatus } from "@dispatch/shared";
import { useUpdate, hasUpdate } from "./update.js";

const INSTALLED = { version: "2026.08.14.81160", tag: "v2026.08.14.81160" };
const LATEST = {
  version: "2026.08.14.85068",
  tag: "v2026.08.14.85068",
  url: "https://github.com/mdennis281/dispatch/releases/tag/v2026.08.14.85068",
};

function status(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    supported: true,
    installed: INSTALLED,
    latest: LATEST,
    available: true,
    checkedAt: 1_760_000_000_000,
    ...over,
  };
}

/** The card's visibility rule, read off the store the way the selector does. */
function shouldNudge(): boolean {
  const s = useUpdate.getState();
  if (s.installing || !hasUpdate(s.status)) return false;
  return s.dismissed !== s.status!.latest!.version;
}

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

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
  useUpdate.setState({
    status: null,
    loaded: false,
    checking: false,
    installing: false,
    dismissed: null,
  });
});

describe("hasUpdate", () => {
  it("is false with no status at all", () => {
    expect(hasUpdate(null)).toBe(false);
  });

  it("is false on a build run from source, even if a newer release exists", () => {
    expect(hasUpdate(status({ supported: false }))).toBe(false);
  });

  it("is false when the server says there is nothing newer", () => {
    expect(hasUpdate(status({ available: false }))).toBe(false);
  });

  it("is true when a newer release is installable", () => {
    expect(hasUpdate(status())).toBe(true);
  });
});

describe("dismissal", () => {
  it("nudges for an available update", () => {
    useUpdate.getState().set(status());
    expect(shouldNudge()).toBe(true);
  });

  it("stops nudging once dismissed, and stays dismissed across a reload", () => {
    useUpdate.getState().set(status());
    useUpdate.getState().dismiss();
    expect(shouldNudge()).toBe(false);
    expect(localStorage.getItem("cm:update-dismissed")).toBe(LATEST.version);
  });

  it("nudges again for the NEXT release", () => {
    useUpdate.getState().set(status());
    useUpdate.getState().dismiss();

    useUpdate.getState().set(
      status({ latest: { ...LATEST, version: "2026.08.15.00120", tag: "v2026.08.15.00120" } }),
    );
    expect(shouldNudge()).toBe(true);
  });

  it("does nothing when there is no release to dismiss", () => {
    useUpdate.getState().set(status({ latest: null, available: false }));
    useUpdate.getState().dismiss();
    expect(useUpdate.getState().dismissed).toBeNull();
  });
});

describe("installing", () => {
  it("hides the nudge while an install is running", () => {
    useUpdate.getState().set(status());
    useUpdate.setState({ installing: true });
    expect(shouldNudge()).toBe(false);
  });

  it("adopts an install already running on the server", () => {
    // A second tab, or this tab after a reload that beat the shutdown.
    useUpdate.getState().set(status({ installing: true }));
    expect(useUpdate.getState().installing).toBe(true);
  });
});
