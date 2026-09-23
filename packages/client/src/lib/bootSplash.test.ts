/**
 * When the splash is allowed to lift.
 *
 * `isBootReady` decides whether the app is ever uncovered, so both directions
 * are a visible bug and neither is caught by anything else: too eager lifts the
 * splash onto a half-hydrated frame, too strict pins it there until `MAX_MS`
 * expires on every single load. The three "yes" branches below are the three
 * screens the splash can legitimately uncover, and two of them are only right
 * because `/api/setup` is never asked in those states (see `shouldProbeSetup`)
 * — waiting on `setupPending` there would wait forever.
 */
import { describe, it, expect } from "vitest";
import { isBootReady, type BootState } from "./bootSplash.js";

const BOOTED: BootState = {
  authReady: true,
  unreachable: false,
  authEnabled: false,
  signedIn: false,
  setupPending: false,
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

  it("lifts onto the first-run wizard", () => {
    expect(isBootReady(state({ setupPending: true }))).toBe(true);
  });

  it("lifts onto the sign-in form without waiting for a probe that never runs", () => {
    // Auth on, nobody signed in: `/api/setup` sits behind the same bearer gate,
    // so `shouldProbeSetup` suppresses it and `setupPending` stays null.
    expect(isBootReady(state({ authEnabled: true, signedIn: false, setupPending: null }))).toBe(
      true,
    );
  });

  it("lifts onto ConnectingScreen when the server is unreachable", () => {
    // Same trap: `initializeAuth` applied a placeholder status, the setup probe
    // is suppressed, and the screen behind the splash is the diagnosis.
    expect(isBootReady(state({ unreachable: true, setupPending: null }))).toBe(true);
  });

  it("still waits for auth even when the server is unreachable", () => {
    // `unreachable` is only meaningful once auth has settled on the placeholder;
    // before that it is the store's initial value and says nothing.
    expect(isBootReady(state({ authReady: false, unreachable: true, setupPending: null }))).toBe(
      false,
    );
  });
});
