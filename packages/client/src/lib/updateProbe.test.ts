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
import { describe, it, expect } from "vitest";
import { isNewProcess, type HealthProbe } from "./updateProbe.js";

const probe = (over: Partial<HealthProbe> = {}): HealthProbe => ({
  ok: true,
  pid: 4242,
  startedAt: 1_760_000_000_000,
  sha: "abc",
  ...over,
});

describe("isNewProcess", () => {
  it("is false for the very server that accepted the install", () => {
    // The old server, still up, still healthy, mid-download. The whole bug.
    expect(isNewProcess(probe(), 4242, 1_760_000_000_000)).toBe(false);
  });

  it("is true once a different pid answers", () => {
    expect(isNewProcess(probe({ pid: 5150 }), 4242, 1_760_000_000_000)).toBe(true);
  });

  it("is true for a later start time even when the pid was recycled", () => {
    // Not far-fetched on a machine that just restarted a service, so start time
    // is checked independently rather than as a tiebreak behind the pid.
    expect(isNewProcess(probe({ startedAt: 1_760_000_050_000 }), 4242, 1_760_000_000_000)).toBe(true);
  });

  it("is false for an EARLIER start time", () => {
    // Clock skew or a stale cached body — not evidence of a restart.
    expect(isNewProcess(probe({ startedAt: 1_759_000_000_000 }), 4242, 1_760_000_000_000)).toBe(false);
  });

  it("is false when the baseline was never captured", () => {
    // Health was unreachable when the install was accepted. Nothing to compare,
    // so the screen falls back to watching the server go down and come back.
    expect(isNewProcess(probe(), null, null)).toBe(false);
  });

  it("is false when the answering server reports no identity at all", () => {
    expect(isNewProcess(probe({ pid: null, startedAt: null }), 4242, 1_760_000_000_000)).toBe(false);
  });

  it("counts a degraded (503) new build as new", () => {
    // A 503 means the new build is up but unhappy. That is still "the swap
    // finished", and the reloaded page is where the problem gets reported.
    expect(isNewProcess(probe({ ok: false, pid: 5150 }), 4242, 1_760_000_000_000)).toBe(true);
  });
});
