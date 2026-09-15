/**
 * The one decision the updating screen must not get wrong: is the server that
 * just answered the NEW one, or the old one that hasn't died yet?
 *
 * Getting it wrong in the optimistic direction is the bug this whole change
 * exists to fix. `tools/install.mjs` downloads, verifies, unpacks and runs a
 * full `pnpm install` before it stops anything, so the pre-swap server answers
 * healthy for MINUTES after Update is clicked. A probe that reads "something
 * answered" as "the update finished" therefore reloads the page every couple of
 * seconds for the whole install — which is exactly what it did.
 *
 * So every case where identity is unknown must answer false. Waiting too long is
 * recoverable (the patience timer offers a manual reload); reloading too early
 * is the loop.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { isNewProcess, probeHealth, probeReady, type FromIdentity, type HealthProbe } from "./updateProbe.js";

const probe = (over: Partial<HealthProbe> = {}): HealthProbe => ({
  ok: true,
  pid: 4242,
  startedAt: 1_760_000_000_000,
  sha: "abc",
  version: "2026.08.14.81160",
  ...over,
});

const from = (over: Partial<FromIdentity> = {}): FromIdentity => ({
  fromPid: 4242,
  fromStartedAt: 1_760_000_000_000,
  fromVersion: "2026.08.14.81160",
  ...over,
});

describe("isNewProcess", () => {
  it("is false for the very server that accepted the install", () => {
    // The old server, still up, still healthy, mid-download. The whole bug.
    expect(isNewProcess(probe(), from())).toBe(false);
  });

  it("is true once a different pid answers", () => {
    expect(isNewProcess(probe({ pid: 5150 }), from())).toBe(true);
  });

  it("is true for a later start time even when the pid was recycled", () => {
    // Not far-fetched on a machine that just restarted a service, so start time
    // is checked independently rather than as a tiebreak behind the pid.
    expect(isNewProcess(probe({ startedAt: 1_760_000_050_000 }), from())).toBe(true);
  });

  it("is false for an EARLIER start time", () => {
    // Clock skew or a stale cached body — not evidence of a restart.
    expect(isNewProcess(probe({ startedAt: 1_759_000_000_000 }), from())).toBe(false);
  });

  it("is false when the baseline was never captured", () => {
    // Health was unreachable when the install was accepted. Nothing to compare,
    // so the screen falls back to watching the server go down and come back.
    expect(isNewProcess(probe(), from({ fromPid: null, fromStartedAt: null, fromVersion: null }))).toBe(false);
  });

  it("is false when the answering server reports no identity at all", () => {
    expect(isNewProcess(probe({ pid: null, startedAt: null, version: null }), from())).toBe(false);
  });

  it("is true for a different VERSION even when no process identity was captured", () => {
    // The baseline probe was dropped, so the marker knows only which release it
    // was leaving. Before `fromVersion` this case was undecidable, and an
    // undecidable marker held the screen over the login form until it expired.
    expect(
      isNewProcess(
        probe({ pid: 4242, startedAt: 1_760_000_000_000, version: "2026.08.14.85068" }),
        from({ fromPid: null, fromStartedAt: null }),
      ),
    ).toBe(true);
  });

  it("is false for the same version when the process identity is unknown on both sides", () => {
    expect(
      isNewProcess(probe({ pid: null, startedAt: null }), from({ fromPid: null, fromStartedAt: null })),
    ).toBe(false);
  });

  it("counts a degraded (503) new build as new", () => {
    // A 503 means the new build is up but unhappy. That is still "the swap
    // finished", and the reloaded page is where the problem gets reported.
    expect(isNewProcess(probe({ ok: false, pid: 5150 }), from())).toBe(true);
  });
});

describe("probeHealth", () => {
  afterEach(() => vi.unstubAllGlobals());

  const answer = (status: number, body: string, type: string) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status, headers: { "content-type": type } })));

  it("reads Dispatch's own degraded 503 as a live server", async () => {
    answer(503, JSON.stringify({ ok: false, pid: 5150, startedAt: 1, version: "2026.08.14.85068" }), "application/json; charset=utf-8");
    expect(await probeHealth()).toMatchObject({ ok: false, pid: 5150, version: "2026.08.14.85068" });
  });

  it("reads a reverse proxy's HTML 503 as down", async () => {
    // HAProxy with no backend answers exactly this for the minutes the server
    // is being swapped. It is not a degraded build; it is nobody home.
    answer(503, "<html><body><h1>503 Service Unavailable</h1></body></html>", "text/html");
    expect(await probeHealth()).toBeNull();
  });
});

describe("probeReady", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is true only when the document itself is served", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<!doctype html>", { status: 200 })));
    expect(await probeReady()).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("503", { status: 503 })));
    expect(await probeReady()).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("refused"); }));
    expect(await probeReady()).toBe(false);
  });

  it("bypasses the service worker's cached shell", async () => {
    // A cached "/" answering for the probe would say "ready" during the exact
    // window the proxy is 503ing — the case the probe exists to wait out.
    const mock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", mock);
    await probeReady();
    expect(mock).toHaveBeenCalledWith("/", expect.objectContaining({ cache: "no-store" }));
  });
});
