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
