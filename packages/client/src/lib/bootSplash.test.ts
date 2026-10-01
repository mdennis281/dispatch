/**
 * When the splash is allowed to lift.
 *
 * `isBootReady` decides whether the app is ever uncovered, so both directions
 * are a visible bug and neither is caught by anything else: too eager lifts the
 * splash onto a half-hydrated frame, too strict pins it there until `MAX_MS`
 * expires on every single load. The "yes" branches below are the screens the
 * splash can legitimately uncover, and two of them are only right because
 * `/api/setup` is never asked in those states (see `shouldProbeSetup`) —
 * waiting on `setupPending` there would wait forever.
 *
 * The shell is the one that waits for its DATA as well as for its probes, and
 * the asymmetry is the point: every other branch is a finished screen with no
 * snapshot coming, so requiring `hydrated` there would hold the splash until
 * `MAX_MS` and then uncover exactly the same thing.
 */
import { describe, it, expect } from "vitest";
import {
  BOOT_SPLASH_HARD_MAX_MS,
  BOOT_SPLASH_MAX_MS,
  BOOT_SPLASH_STALL_MS,
  bootMilestones,
  capExtension,
  isBootReady,
  type BootState,
} from "./bootSplash.js";

const BOOTED: BootState = {
  authReady: true,
  unreachable: false,
  authEnabled: false,
  signedIn: false,
  setupPending: false,
  hydrated: true,
  socketOpen: true,
  hydrating: false,
  mockSeeded: false,
};

const state = (over: Partial<BootState> = {}): BootState => ({ ...BOOTED, ...over });

describe("isBootReady", () => {
  it("holds until /api/auth/status has answered", () => {
    expect(isBootReady(state({ authReady: false, setupPending: false }))).toBe(false);
  });

  it("holds once auth has answered but the setup probe has not", () => {
    expect(isBootReady(state({ setupPending: null }))).toBe(false);
  });

  it("lifts onto the shell", () => {
    expect(isBootReady(state({ setupPending: false }))).toBe(true);
  });

  it("holds the shell until the REST snapshot has landed", () => {
    // Both probes have answered and the socket may not even be open yet. This
    // is the window the splash used to lift in, onto an empty sidebar.
    expect(isBootReady(state({ setupPending: false, hydrated: false }))).toBe(false);
  });

  it("accepts the dev offline mock as content", () => {
    expect(isBootReady(state({ setupPending: false, hydrated: false, mockSeeded: true }))).toBe(
      true,
    );
  });

  it("lifts onto the first-run wizard with no snapshot at all", () => {
    // Nothing is going to hydrate: this install has never been set up, and the
    // wizard is the finished screen.
    expect(isBootReady(state({ setupPending: true, hydrated: false }))).toBe(true);
  });

  it("lifts onto the sign-in form without waiting for a probe that never runs", () => {
    // Auth on, nobody signed in: `/api/setup` sits behind the same bearer gate,
    // so `shouldProbeSetup` suppresses it and `setupPending` stays null. No
    // socket is opened in this state either, so `hydrated` would never arrive.
    expect(
      isBootReady(
        state({ authEnabled: true, signedIn: false, setupPending: null, hydrated: false }),
      ),
    ).toBe(true);
  });

  it("lifts onto ConnectingScreen when the server is unreachable", () => {
    // Same trap, and now a third time over for `hydrated`: a server that cannot
    // be reached is not going to answer a REST snapshot either.
    expect(isBootReady(state({ unreachable: true, setupPending: null, hydrated: false }))).toBe(
      true,
    );
  });

  it("still waits for auth even when the server is unreachable", () => {
    // `unreachable` is only meaningful once auth has settled on the placeholder;
    // before that it is the store's initial value and says nothing.
    expect(isBootReady(state({ authReady: false, unreachable: true, setupPending: null }))).toBe(
      false,
    );
  });
});

/**
 * What the `MAX_MS` cap does when it expires on a boot that is slow rather than
 * broken.
 *
 * With auth on, a load is six serialized round trips before the first row can
 * exist, which runs past nine seconds on an ordinary bad-signal link — so the
 * cap was firing on healthy boots and uncovering the empty shell the splash
 * exists to hide. The fix is that it extends while the boot is still visibly
 * advancing, and both directions are a visible bug: too eager shows the empty
 * shell, too patient pins the app behind a logo that will never lift.
 */
describe("capExtension", () => {
  it("lifts once the boot has gone silent — nothing is coming", () => {
    expect(capExtension(BOOT_SPLASH_MAX_MS, BOOT_SPLASH_STALL_MS)).toBeNull();
  });

  it("waits while the boot is still advancing", () => {
    // Something wrote to a boot store a moment ago, so the next step is in
    // flight and the splash is seconds from lifting onto a finished screen.
    expect(capExtension(BOOT_SPLASH_MAX_MS, 0)).toBe(BOOT_SPLASH_STALL_MS);
  });

  it("re-arms only for what the stall window has left", () => {
    // So a boot that goes quiet is noticed within `STALL_MS` of going quiet,
    // rather than at whatever the next deadline happened to be.
    expect(capExtension(BOOT_SPLASH_MAX_MS, BOOT_SPLASH_STALL_MS - 300)).toBe(300);
  });

  it("never extends past the hard ceiling, however lively the boot looks", () => {
    // The ceiling is absolute and measured from the splash's own start, so a
    // boot that keeps emitting progress cannot buy itself an unbounded wait.
    expect(capExtension(BOOT_SPLASH_HARD_MAX_MS - 400, 0)).toBe(400);
    expect(capExtension(BOOT_SPLASH_HARD_MAX_MS, 0)).toBeNull();
    expect(capExtension(BOOT_SPLASH_HARD_MAX_MS + 5_000, 0)).toBeNull();
  });
});

/**
 * What the cap counts as the boot getting somewhere.
 *
 * The distinction this suite exists for: a FAILING boot is the noisiest thing in
 * the app — `ConnectingScreen` re-probes every four seconds and the socket's
 * retry loop churns `useConnection` on every attempt, both well inside
 * `BOOT_SPLASH_STALL_MS`. A watchdog that counted store writes would read all of
 * that as health and hide a dead boot behind the splash for the entire hard
 * ceiling, which is precisely backwards.
 */
describe("bootMilestones", () => {
  const nothing = state({
    authReady: false,
    setupPending: null,
    hydrated: false,
    socketOpen: false,
    hydrating: false,
  });

  it("rises once per checkpoint, over a whole healthy boot", () => {
    const steps = [
      nothing,
      { ...nothing, authReady: true },
      { ...nothing, authReady: true, setupPending: false },
      { ...nothing, authReady: true, setupPending: false, socketOpen: true },
      { ...nothing, authReady: true, setupPending: false, socketOpen: true, hydrating: true },
      { ...nothing, authReady: true, setupPending: false, socketOpen: true, hydrated: true },
    ].map(bootMilestones);
    expect(steps).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("does not dip when the snapshot stops being in flight by LANDING", () => {
    // `hydrating` goes false and `hydrated` goes true in the same breath. If
    // that read as a step backwards the counter would stop being monotonic and
    // the caller could not treat "it went up" as the whole test.
    const inFlight = { ...nothing, authReady: true, setupPending: false, socketOpen: true, hydrating: true };
    expect(bootMilestones({ ...inFlight, hydrating: false, hydrated: true })).toBeGreaterThan(
      bootMilestones(inFlight),
    );
  });

  it("cannot be moved by retry or probe bookkeeping", () => {
    // The structural guarantee, stated as a test: none of what a failing boot
    // churns — `probe`, `attempts`, `nextRetryAt`, `downSince`, `state` short of
    // "open" — is part of `BootState`, so there is nothing a retry loop can
    // touch that this function can see. A stalled boot therefore holds one
    // number and the cap expires on it.
    const stalled = { ...nothing, authReady: true, setupPending: null };
    expect(bootMilestones(stalled)).toBe(bootMilestones({ ...stalled }));
    expect(Object.keys(stalled).sort()).toEqual([
      "authEnabled", "authReady", "hydrated", "hydrating", "mockSeeded",
      "setupPending", "signedIn", "socketOpen", "unreachable",
    ]);
  });
});
