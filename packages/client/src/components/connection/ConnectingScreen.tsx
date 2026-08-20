/**
 * The page you get when Dispatch isn't answering — and, more to the point, the
 * page that says WHY.
 *
 * Before this, every way of not being connected looked the same: a grey dot in
 * the corner reading "Offline" over a full shell whose every control silently
 * failed. Six genuinely different faults collapsed into that one non-answer —
 * the server not running, a proxy that answers but has nothing behind it, a
 * proxy that won't forward the WebSocket upgrade, an expired session, a
 * half-applied upgrade, and a tab holding a bundle the server was never built
 * against. They need six different responses and four of them aren't "wait".
 *
 * Three things make it honest rather than decorative:
 *
 *   1. **It probes rather than infers.** The page you're reading may well have
 *      come from the service worker's cache, so "the app rendered" proves
 *      nothing about the server. `/api/health` is fetched `no-store`, and it is
 *      auth-exempt precisely so it can be reached in this situation.
 *   2. **It only shows checks that could be the cause.** On loopback the
 *      internet is irrelevant; over a reverse proxy it's the first thing to rule
 *      out. See `classifyReach`.
 *   3. **It waits.** A server restart takes a few hundred milliseconds, and
 *      throwing a diagnostic panel up for that would make every restart look
 *      like a fault. Nothing appears until the connection has been down past
 *      `GRACE_MS`.
 *
 * It renders OUTSIDE `AuthGate`, like `UpdatingScreen`, because a server you
 * can't reach is also a server you can't authenticate against — putting a login
 * form in front of an unreachable host is the failure this replaces, not a
 * feature of it.
 */
import { useEffect, useState } from "react";
import { PlugZap, RotateCw, ServerCrash, ShieldAlert, Unplug, WifiOff } from "lucide-react";
import { Button } from "../ui/Button.js";
import { StatusDot, type DotTone } from "../ui/StatusDot.js";
import { useConnection } from "../../stores/connection.js";
import { useUpdate } from "../../stores/update.js";
import { initializeAuth, useAuth } from "../../stores/auth.js";
import { LAYER } from "../../lib/layers.js";
import { ws } from "../../lib/ws.js";
import { probeNeedsLogin, probeServer } from "../../lib/connectionProbe.js";
import {
  classifyReach,
  diagnose,
  isStaleBundle,
  STALE_FRAME_LIMIT,
  type Check,
  type CheckState,
  type Diagnosis,
} from "../../lib/connectionDiagnosis.js";

/**
 * How long the connection must be down before this takes over.
 *
 * Long enough that a normal server restart — which is well under a second on
 * loopback — never shows it, short enough that a real outage doesn't leave you
 * clicking into a dead UI wondering. Measured from `downSince`, which a `hello`
 * clears and nothing else does.
 */
const GRACE_MS = 2_000;

/** Re-probe cadence while the screen is up. Two stats and a small JSON read. */
const POLL_MS = 4_000;

const TONE: Record<CheckState, DotTone> = {
  ok: "success",
  fail: "danger",
  warn: "warn",
  pending: "info",
  skip: "muted",
};

function CheckRow({ check }: { check: Check }) {
  const dim = check.state === "skip";
  return (
    <li className="flex items-center gap-2.5 py-1.5">
      <StatusDot tone={TONE[check.state]} pulse={check.state === "pending"} />
      <span className={dim ? "text-xs text-faint" : "text-xs text-secondary"}>{check.label}</span>
      <span className="ml-auto text-right text-xs text-muted">{check.value}</span>
    </li>
  );
}

function HeadIcon({ diagnosis }: { diagnosis: Diagnosis }) {
  const failing = diagnosis.checks.find((c) => c.state === "fail");
  const icon =
    diagnosis.action === "sign-in" ? (
      <ShieldAlert />
    ) : failing?.id === "network" ? (
      <WifiOff />
    ) : failing?.id === "server" ? (
      <ServerCrash />
    ) : failing?.id === "protocol" ? (
      <RotateCw />
    ) : failing?.id === "socket" ? (
      <Unplug />
    ) : (
      <PlugZap className="cm-anim-pulse" />
    );
  const tone = failing
    ? "border-danger-line text-danger"
    : "border-accent-line text-accent-hi";
  return (
    <span
      className={`mb-3.5 flex size-12 items-center justify-center rounded-xl border bg-panel-2 [&_svg]:size-5 ${tone}`}
    >
      {icon}
    </span>
  );
}

/**
 * Poll the server while the screen is up, and re-ask the auth question if the
 * answer we're holding was a guess.
 *
 * That second part matters more than it looks. When `initializeAuth` can't reach
 * the server it falls back to "auth is off" so the shell has something to render
 * against — but if auth is actually ON, the tab is now wrong in a way it will
 * never notice: the WS upgrade gets a 401 the browser never surfaces to
 * JavaScript, so it retries forever against a server that is up and healthy.
 * Asking again the moment `/api/health` answers is what closes that loop without
 * a reload.
 */
function useServerProbe(active: boolean): void {
  const setProbe = useConnection((s) => s.setProbe);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async (): Promise<void> => {
      const probe = await probeServer();
      if (cancelled) return;
      if (probe.kind === "ok") {
        const needsLogin = await probeNeedsLogin();
        if (cancelled) return;
        if (needsLogin !== undefined) probe.needsLogin = needsLogin;
        if (useAuth.getState().unreachable) {
          await initializeAuth();
          if (cancelled) return;
          // The next attempt now knows whether to fetch a ticket. Don't make the
          // user sit out the remaining backoff to find out.
          ws.retryNow();
        }
      }
      setProbe(probe);
      timer = setTimeout(() => void run(), POLL_MS);
    };

    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, setProbe]);
}

/** True once `downSince` is older than `GRACE_MS`; false whenever we're connected. */
function useAfterGrace(downSince: number | undefined): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (downSince === undefined) {
      setElapsed(false);
      return;
    }
    const remaining = downSince + GRACE_MS - Date.now();
    if (remaining <= 0) {
      setElapsed(true);
      return;
    }
    setElapsed(false);
    const timer = setTimeout(() => setElapsed(true), remaining);
    return () => clearTimeout(timer);
  }, [downSince]);
  return elapsed;
}

/** Seconds until the next scheduled retry, ticking; null when none is armed. */
function useCountdown(nextRetryAt: number | undefined, active: boolean): number | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (!active || nextRetryAt === undefined) return;
    const timer = setInterval(() => force((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [active, nextRetryAt]);
  if (nextRetryAt === undefined) return null;
  return Math.max(0, Math.ceil((nextRetryAt - Date.now()) / 1000));
}

export function ConnectingScreen() {
  const state = useConnection((s) => s.state);
  const downSince = useConnection((s) => s.downSince);
  const nextRetryAt = useConnection((s) => s.nextRetryAt);
  const attempts = useConnection((s) => s.attempts);
  const lastClose = useConnection((s) => s.lastClose);
  const serverVersion = useConnection((s) => s.serverVersion);
  const badFrames = useConnection((s) => s.badFrames);
  const badFrameTypes = useConnection((s) => s.badFrameTypes);
  const probe = useConnection((s) => s.probe);
  const online = useConnection((s) => s.online);
  const stopped = useConnection((s) => s.stopped);
  const mockSeeded = useConnection((s) => s.mockSeeded);
  const liveStarted = useConnection((s) => s.liveStarted);
  // An update stops the server on purpose and narrates itself; a shutdown says
  // something this screen can't know. Both are more specific answers than
  // "can't connect", so both win.
  const updating = useUpdate((s) => s.flight !== null);

  const clientVersion = typeof __BUILD_VERSION__ === "string" ? __BUILD_VERSION__ : "dev";
  const graced = useAfterGrace(downSince);
  // A protocol break is the exception to the grace gate, and it has to be: it is
  // the failure that presents as SUCCESS. The socket is open, `hello` landed —
  // so `downSince` is clear and the timer would never fire — and frames are
  // being dropped on the floor the whole time. Gating this on "down for 2s"
  // would hide the only case with no other symptom.
  const protocolBroken =
    isStaleBundle(clientVersion, serverVersion) || badFrames >= STALE_FRAME_LIMIT;
  const visible =
    liveStarted && (graced || protocolBroken) && !stopped && !updating && !mockSeeded;

  useServerProbe(visible);
  const countdown = useCountdown(nextRetryAt, visible);

  if (!visible) return null;

  const diagnosis = diagnose({
    reach: classifyReach(location.hostname),
    host: location.host,
    online,
    state,
    probe,
    lastClose,
    clientVersion,
    serverVersion,
    badFrames,
    badFrameTypes,
  });

  return (
    <div
      role="alertdialog"
      aria-label="Connection problem"
      style={{ zIndex: LAYER.connecting }}
      className="fixed inset-0 flex flex-col items-center justify-center bg-app/95 px-5 backdrop-blur-sm cm-safe-pad"
    >
      <HeadIcon diagnosis={diagnosis} />
      <p className="text-center text-lg font-medium text-primary">{diagnosis.headline}</p>
      <p className="mt-1 max-w-[440px] text-center text-sm leading-relaxed text-muted">
        {diagnosis.detail}
      </p>

      <ul className="mt-4 w-full max-w-[340px] divide-y divide-line rounded-lg border border-line bg-inset px-3 py-1">
        {diagnosis.checks.map((check) => (
          <CheckRow key={check.id} check={check} />
        ))}
      </ul>

      {diagnosis.hint && (
        <p className="mt-3.5 max-w-[440px] text-center text-xs leading-relaxed text-secondary">
          {diagnosis.hint}
        </p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <Button
          variant="primary"
          leftIcon={<RotateCw />}
          onClick={() => ws.retryNow()}
        >
          Retry now
        </Button>
        {(diagnosis.action === "reload" || diagnosis.action === "sign-in") && (
          <Button onClick={() => location.reload()}>
            {diagnosis.action === "sign-in" ? "Go to sign in" : "Reload"}
          </Button>
        )}
      </div>

      <p className="mt-3.5 text-xs text-faint">
        {attempts > 0 ? `Attempt ${attempts}` : "Not yet attempted"}
        {countdown !== null && ` · retrying in ${countdown}s`}
        {countdown === null && state !== "closed" && " · trying now"}
      </p>
    </div>
  );
}
