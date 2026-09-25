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
import { isBootReady, type BootState } from "./bootSplash.js";

const BOOTED: BootState = {
  authReady: true,
  unreachable: false,
  authEnabled: false,
  signedIn: false,
  setupPending: false,
  hydrated: true,
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
