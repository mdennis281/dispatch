/**
 * The rules that decide whether an update surface appears at all.
 *
 * Two of them are easy to break and expensive to break: a build run from source
 * must never show an update control (`supported: false`), and dismissing a
 * release must silence only THAT release — a boolean or a timestamp here would
 * either nag about an update you rejected or hide the next one you never saw.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { UpdateStatus } from "@dispatch/shared";
import { useUpdate, hasUpdate } from "./update.js";
import { readFlight } from "../lib/updatePrefs.js";

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
    channel: "stable",
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
    switching: false,
    installing: false,
    flight: null,
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

describe("channels", () => {
  it("does not treat 'ahead of the channel' as an update", () => {
    // Switched unstable → stable while running a build stable has not been
    // promoted to. There is something to SAY, but nothing the nudge should push.
    const s = status({ channel: "stable", available: false, ahead: true });
    expect(hasUpdate(s)).toBe(false);
    useUpdate.getState().set(s);
    expect(shouldNudge()).toBe(false);
  });

  it("still nudges on the unstable channel", () => {
    useUpdate.getState().set(status({ channel: "unstable" }));
    expect(shouldNudge()).toBe(true);
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

/**
 * The marker that makes the update survivable.
 *
 * Its job is to record WHICH server is about to go away, so the updating screen
 * can wait for a different one instead of reloading the moment the old one — up
 * and healthy for the whole download and dependency install — answers a probe.
 */
describe("the in-flight marker", () => {
  const HEALTH = { ok: true, pid: 4242, startedAt: 1_760_000_000_000, sha: "abc" };

  function routeFetch(over: { health?: unknown; install?: unknown } = {}) {
    const mock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/api/health")
        ? (over.health ?? HEALTH)
        : (over.install ?? { ok: true, tag: LATEST.tag });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records the identity of the server that accepted the install", async () => {
    routeFetch();
    useUpdate.getState().set(status());
    await useUpdate.getState().install();

    expect(readFlight()).toMatchObject({
      tag: LATEST.tag,
      version: LATEST.version,
      fromPid: 4242,
      fromStartedAt: 1_760_000_000_000,
    });
    expect(useUpdate.getState().flight).not.toBeNull();
  });

  it("probes the baseline BEFORE asking for the install", async () => {
    // Probing afterwards races the shutdown: a health read that lands on the
    // NEW server would record the build we are waiting FOR as the one we are
    // waiting to lose, and the screen then waits forever.
    const mock = routeFetch();
    useUpdate.getState().set(status());
    await useUpdate.getState().install();

    const urls = mock.mock.calls.map((c) => String(c[0]));
    expect(urls.findIndex((u) => u.includes("/api/health"))).toBeLessThan(
      urls.findIndex((u) => u.includes("/api/update/install")),
    );
  });

  it("writes no marker when the server refuses the install", async () => {
    routeFetch({ install: { ok: false, error: "there is no newer release to install" } });
    useUpdate.getState().set(status());
    const res = await useUpdate.getState().install();

    expect(res.ok).toBe(false);
    expect(readFlight()).toBeNull();
    expect(useUpdate.getState().installing).toBe(false);
  });

  it("still records the install when health cannot be reached", async () => {
    // No baseline to compare against, so the screen falls back to watching the
    // server go down and come back — but losing the marker entirely would lose
    // the update screen, which is worse.
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/health")) throw new Error("connection refused");
      return new Response(JSON.stringify({ ok: true, tag: LATEST.tag }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }));
    useUpdate.getState().set(status());
    await useUpdate.getState().install();

    expect(readFlight()).toMatchObject({ fromPid: null, fromStartedAt: null });
  });

  it("clears both the marker and the latch when the update concludes", async () => {
    routeFetch();
    useUpdate.getState().set(status());
    await useUpdate.getState().install();
    useUpdate.getState().endFlight();

    expect(readFlight()).toBeNull();
    expect(useUpdate.getState()).toMatchObject({ flight: null, installing: false });
  });

  it("adopts an install this tab did not start, capturing the live server as the baseline", async () => {
    routeFetch();
    useUpdate.getState().set(status({ installing: true }));
    await useUpdate.getState().adopt();

    // The server still answering IS the one the installer is about to stop.
    expect(readFlight()).toMatchObject({ fromPid: 4242 });
    expect(useUpdate.getState().installing).toBe(true);
  });

  it("does not overwrite a marker that already exists", async () => {
    routeFetch();
    useUpdate.getState().set(status());
    await useUpdate.getState().install();
    const first = readFlight();

    await useUpdate.getState().adopt();
    expect(readFlight()).toEqual(first);
  });
});
