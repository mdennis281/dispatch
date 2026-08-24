/**
 * The first-run gate, which is two booleans deep and fails OPEN.
 *
 * This exists because `e2e/shell-live.spec.ts` — which drives the whole wizard —
 * is deliberately NOT run in CI (see `.github/workflows/ci.yml`, and the reasons
 * given there). So the only automated thing standing behind first run on a pull
 * request is this file, and the two pieces worth pinning are the ones whose
 * whole behaviour is edges:
 *
 *   - `shouldProbeSetup` — one wrong clause is either a permanent
 *     "Starting Dispatch…" or a wizard that never appears on an install that
 *     needs one.
 *   - `hydrate` — every failure latches `pending: false` for the life of the
 *     tab, which drops a genuinely new install into an empty shell.
 *
 * Failing open is the deliberate choice (a hiccup must not put a four-step
 * takeover over a working install), which is exactly why the cases where it
 * must NOT be reached are worth writing down.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useSetup, shouldProbeSetup, SETUP_PROBE_TIMEOUT_MS } from "./setup.js";
import { api } from "../lib/api.js";

vi.mock("../lib/api.js", () => ({
  api: { setup: { status: vi.fn(), github: vi.fn(), complete: vi.fn() } },
}));

const status = vi.mocked(api.setup.status);

/** The gate's inputs, defaulted to a fresh install with auth off. */
function auth(over: Partial<Parameters<typeof shouldProbeSetup>[0]> = {}) {
  return { ready: true, unreachable: false, authEnabled: false, signedIn: false, ...over };
}

beforeEach(() => {
  useSetup.setState({ pending: null });
  status.mockReset();
});

describe("shouldProbeSetup", () => {
  it("probes a settled, reachable, auth-off install", () => {
    expect(shouldProbeSetup(auth())).toBe(true);
  });

  it("waits for auth to settle", () => {
    // Before `/api/auth/status` answers there is no way to know whether a
    // bearer token is even required.
    expect(shouldProbeSetup(auth({ ready: false }))).toBe(false);
  });

  /**
   * The regression that made this a function. `initializeAuth`'s catch applies a
   * PLACEHOLDER status — auth off, nobody signed in — which satisfies every
   * other clause here. Without the `unreachable` check the probe fires at a
   * server that isn't there, fails, and latches `pending: false`; and since the
   * recovered status for a fresh install is identical to the placeholder in
   * every field this reads, nothing would ever ask again.
   */
  it("does NOT probe while the auth answer is a placeholder for an unreachable server", () => {
    expect(shouldProbeSetup(auth({ unreachable: true }))).toBe(false);
    // …and the flag clearing is what re-opens it, which is the only edge
    // available on a fresh install.
    expect(shouldProbeSetup(auth({ unreachable: false }))).toBe(true);
  });

  it("waits for a session when this install requires a login", () => {
    // `/api/setup` is behind the same bearer gate as everything else, and a 401
    // is indistinguishable here from "already set up".
    expect(shouldProbeSetup(auth({ authEnabled: true, signedIn: false }))).toBe(false);
    expect(shouldProbeSetup(auth({ authEnabled: true, signedIn: true }))).toBe(true);
  });

  it("still refuses an unreachable server even with a session in hand", () => {
    expect(
      shouldProbeSetup(auth({ authEnabled: true, signedIn: true, unreachable: true })),
    ).toBe(false);
  });
});

describe("useSetup.hydrate", () => {
  it("raises the wizard for an install that has never been set up", async () => {
    status.mockResolvedValue({ completed: false });
    await useSetup.getState().hydrate();
    expect(useSetup.getState().pending).toBe(true);
  });

  it("stays out of the way of an install that has", async () => {
    status.mockResolvedValue({ completed: true, completedAt: 1 });
    await useSetup.getState().hydrate();
    expect(useSetup.getState().pending).toBe(false);
  });

  it("fails OPEN — a probe that errors shows the app, not the wizard", async () => {
    status.mockRejectedValue(new Error("boom"));
    await useSetup.getState().hydrate();
    // Deliberate: guessing "needs setup" wrong puts a mandatory four-step
    // takeover over a working install, and its last step creates a project.
    expect(useSetup.getState().pending).toBe(false);
  });

  /**
   * The shell does not render until this resolves, so a server that accepts the
   * connection and then never answers — a reverse proxy holding the request open
   * with nothing behind it — must not strand the tab on "Starting Dispatch…"
   * forever with the connection diagnostics never getting to run.
   */
  it("gives up rather than hanging when the server never answers", async () => {
    vi.useFakeTimers();
    try {
      status.mockReturnValue(new Promise(() => {}));
      const inFlight = useSetup.getState().hydrate();
      await vi.advanceTimersByTimeAsync(SETUP_PROBE_TIMEOUT_MS + 1);
      await inFlight;
      expect(useSetup.getState().pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not give up on an answer that arrives inside the window", async () => {
    vi.useFakeTimers();
    try {
      status.mockReturnValue(
        new Promise((resolve) =>
          setTimeout(() => resolve({ completed: false }), SETUP_PROBE_TIMEOUT_MS - 1),
        ),
      );
      const inFlight = useSetup.getState().hydrate();
      await vi.advanceTimersByTimeAsync(SETUP_PROBE_TIMEOUT_MS);
      await inFlight;
      expect(useSetup.getState().pending).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useSetup.markComplete", () => {
  it("drops the wizard without re-probing", async () => {
    status.mockResolvedValue({ completed: false });
    await useSetup.getState().hydrate();
    expect(useSetup.getState().pending).toBe(true);

    useSetup.getState().markComplete();
    expect(useSetup.getState().pending).toBe(false);
    // The server was told by the wizard itself (POST /api/setup/complete); this
    // is only the local flag, and must not depend on another round trip.
    expect(status).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
