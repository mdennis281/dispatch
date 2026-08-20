/**
 * Turn the raw connection signals into something a person can act on.
 *
 * Pure on purpose — every input is passed in — so the whole matrix of "network
 * up, HTTP up, socket refused" combinations is testable without a browser or a
 * server. The screen just renders what this returns.
 *
 * The ordering principle: report the FIRST link in the chain that's broken, not
 * every consequence of it. A dead server also fails the socket check and the
 * protocol check, and listing all three as problems buries the one that matters.
 */
import type { CloseInfo, ConnState, ServerProbe } from "../stores/connection.js";

/** Where the server we're talking to actually is, from this tab's point of view. */
export type Reach = "loopback" | "lan" | "remote";

export type CheckState = "ok" | "fail" | "warn" | "pending" | "skip";

export interface Check {
  id: "network" | "server" | "socket" | "protocol";
  label: string;
  state: CheckState;
  /** Short right-hand readout — a few words, not a sentence. */
  value: string;
}

export interface Diagnosis {
  headline: string;
  detail: string;
  /** What to do about it, when there's something to do. */
  hint?: string;
  checks: Check[];
  /** An action worth putting a button on, beyond the always-present retry. */
  action?: "reload" | "sign-in";
}

export interface DiagnosisInput {
  reach: Reach;
  host: string;
  online: boolean;
  state: ConnState;
  probe?: ServerProbe;
  lastClose?: CloseInfo;
  /** `__BUILD_VERSION__` — what this bundle was built as. */
  clientVersion: string;
  /** What the server said in `hello`; absent from a source checkout. */
  serverVersion?: string;
  badFrames: number;
  badFrameTypes: string[];
}

/**
 * Rejected frames tolerated before the mismatch is called out.
 *
 * Not zero: one malformed frame is a curiosity, and a brand-new event type from
 * a server one build ahead is survivable. A repeat is a schema disagreement, and
 * a schema disagreement means the app has silently stopped updating.
 */
export const STALE_FRAME_LIMIT = 3;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/**
 * Which of these checks could plausibly be the cause.
 *
 * The point is to NOT show four rows when only two can be at fault. On loopback
 * the internet is irrelevant and saying "Network: online" is filler; over a
 * proxy it's the first thing worth ruling out.
 */
export function classifyReach(hostname: string): Reach {
  const host = hostname.toLowerCase();
  if (LOOPBACK.has(host) || host.endsWith(".localhost")) return "loopback";
  if (host.endsWith(".local")) return "lan";
  if (/^10\./.test(host)) return "lan";
  if (/^192\.168\./.test(host)) return "lan";
  if (/^169\.254\./.test(host)) return "lan";
  // 172.16.0.0 – 172.31.255.255. The lazy `172\.` would swallow public space.
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return "lan";
  return "remote";
}

/**
 * What a close code means, in the words of the thing that most likely caused it.
 *
 * `1006` gets the most attention because it is the least informative and the
 * most common: it means the connection died without a close frame, which is what
 * both "nothing was listening" and "a proxy refused to forward the upgrade" look
 * like from inside a browser — a rejected upgrade's HTTP status is never exposed
 * to JavaScript. Which of those it was comes from the HTTP probe, not from the
 * code, so this only names the shape and the caller supplies the cause.
 */
export function describeClose(close: CloseInfo | undefined): string {
  if (!close) return "no connection yet";
  switch (close.code) {
    case 1000:
      return "closed normally";
    case 1001:
      return "server going away";
    case 1005:
      return "closed without a reason";
    case 1006:
      return "dropped (1006)";
    case 1011:
      return close.reason ? `server error — ${close.reason}` : "server error";
    case 1012:
      return "server restarting";
    case 1013:
      return "server asked us to wait";
    case 4401:
      return close.reason || "session no longer valid";
    default:
      return close.reason ? `${close.reason} (${close.code})` : `closed (${close.code})`;
  }
}

/** Is the tab holding a bundle the server wasn't built with? */
export function isStaleBundle(clientVersion: string, serverVersion?: string): boolean {
  // No server version means a source checkout, which has no release manifest to
  // compare against. Unknown must read as "fine" — guessing here would put a
  // permanent "reload me" screen in front of every developer.
  if (!serverVersion) return false;
  return clientVersion !== serverVersion;
}

function networkCheck(input: DiagnosisInput): Check {
  if (input.reach === "loopback") {
    // The server is this machine. A dead uplink cannot be the cause, and saying
    // so sends someone to check their wifi over a process that isn't running.
    return { id: "network", label: "Network", state: "skip", value: "not needed for localhost" };
  }
  return input.online
    ? { id: "network", label: "Network", state: "ok", value: "online" }
    : { id: "network", label: "Network", state: "fail", value: "no connection" };
}

function serverCheck(input: DiagnosisInput): Check {
  const probe = input.probe;
  if (!input.online && input.reach !== "loopback") {
    return { id: "server", label: "Server", state: "skip", value: "—" };
  }
  if (!probe) return { id: "server", label: "Server", state: "pending", value: "checking…" };
  switch (probe.kind) {
    case "ok":
      return { id: "server", label: "Server", state: "ok", value: "responding" };
    case "degraded":
      return { id: "server", label: "Server", state: "fail", value: "running but unhealthy" };
    case "gateway":
      return { id: "server", label: "Server", state: "fail", value: `proxy error ${probe.status ?? ""}`.trim() };
    case "unauthorized":
      return { id: "server", label: "Server", state: "fail", value: `blocked ${probe.status ?? ""}`.trim() };
    case "not-json":
      return { id: "server", label: "Server", state: "fail", value: "unexpected response" };
    case "unreachable":
      return { id: "server", label: "Server", state: "fail", value: "no response" };
  }
}

function socketCheck(input: DiagnosisInput, serverOk: boolean): Check {
  const label = "Live updates";
  // Nothing downstream of a dead server is diagnostic — the socket would fail
  // whatever its own state, so reporting it as a second failure is noise.
  if (!serverOk) return { id: "socket", label, state: "skip", value: "—" };
  if (input.state === "open") {
    // Open, yet this screen is up — which means `hello` never landed. See the
    // store's `downSince`, which only a handshake clears.
    return { id: "socket", label, state: "warn", value: "open, awaiting handshake" };
  }
  if (input.state === "connecting" || input.state === "reconnecting") {
    return { id: "socket", label, state: "pending", value: "connecting…" };
  }
  return { id: "socket", label, state: "fail", value: describeClose(input.lastClose) };
}

function protocolCheck(input: DiagnosisInput): Check {
  const label = "Protocol";
  if (isStaleBundle(input.clientVersion, input.serverVersion)) {
    return { id: "protocol", label, state: "fail", value: "build mismatch" };
  }
  if (input.badFrames >= STALE_FRAME_LIMIT) {
    return { id: "protocol", label, state: "fail", value: `${input.badFrames} frames rejected` };
  }
  // Nothing has been exchanged, so there is no agreement to report either way.
  if (input.state !== "open") return { id: "protocol", label, state: "skip", value: "—" };
  return { id: "protocol", label, state: "ok", value: "agreed" };
}

/** The proxy-shaped advice, kept in one place because three branches want it. */
function upgradeHint(reach: Reach): string | undefined {
  if (reach === "loopback") return undefined;
  return "If Dispatch is behind a reverse proxy, check that it forwards the Upgrade and Connection headers for /ws — HTTP working while the socket doesn't is the signature of a proxy that doesn't.";
}

export function diagnose(input: DiagnosisInput): Diagnosis {
  const serverOk = input.probe?.kind === "ok";
  const checks: Check[] = [
    networkCheck(input),
    serverCheck(input),
    socketCheck(input, serverOk),
    protocolCheck(input),
  ];

  const withChecks = (d: Omit<Diagnosis, "checks">): Diagnosis => ({ ...d, checks });

  // Protocol first, ahead of everything. A stale bundle is the one failure that
  // presents as full health — green dot, live socket, frames quietly dropped —
  // so if it's ruled in, no other headline would be honest.
  if (isStaleBundle(input.clientVersion, input.serverVersion)) {
    return withChecks({
      headline: "This tab is running an old build",
      detail: `The page was built as ${input.clientVersion} and the server is ${input.serverVersion}. They no longer agree on the protocol, so updates are being dropped.`,
      hint: "Reload to pick up the current build. If it comes straight back, the service worker is holding a cached copy — a hard reload clears it.",
      action: "reload",
    });
  }

  if (!input.online && input.reach !== "loopback") {
    return withChecks({
      headline: "This device is offline",
      detail: "No network connection, so there's nothing to reach the server over.",
      hint: "It reconnects on its own the moment the network is back — nothing to do here.",
    });
  }

  const probe = input.probe;
  if (!probe) {
    return withChecks({
      headline: "Checking the connection",
      detail: "Working out whether the server is reachable.",
    });
  }

  switch (probe.kind) {
    case "unreachable":
      return withChecks(
        input.reach === "loopback"
          ? {
              headline: "Dispatch isn't running",
              detail: "Nothing is listening on this machine — there's no process to connect to.",
              hint: "Start it from the Start-menu shortcut, or run `pnpm app` in the checkout.",
            }
          : {
              headline: `Can't reach ${input.host}`,
              detail:
                input.reach === "lan"
                  ? "Nothing answered. The host may be asleep, off this network, or on a different address."
                  : "Nothing answered — no proxy, no tunnel, no DNS. The request didn't get far enough to be refused.",
              hint:
                input.reach === "remote"
                  ? "Check the tunnel or reverse proxy is up, and that DNS still points at it."
                  : "Check the machine is awake and on the same network.",
            },
      );

    case "gateway":
      return withChecks({
        headline: "The proxy is up, Dispatch isn't",
        detail: `${input.host} answered with ${probe.status}, which is a gateway reporting that the service behind it didn't respond.`,
        hint: "The tunnel and DNS are fine — it's the Dispatch process on the host that needs starting.",
      });

    case "not-json":
      return withChecks({
        headline: `Something else is answering at ${input.host}`,
        detail: `The health endpoint returned ${probe.status} with a body that isn't Dispatch's. That's usually a proxy's own error page, a captive portal, or another site on this hostname.`,
        hint: "On public wifi, sign in to the network first. Otherwise check the proxy is still routing this hostname to Dispatch.",
      });

    case "unauthorized":
      return withChecks({
        headline: "Blocked before reaching Dispatch",
        detail: `The health endpoint came back ${probe.status}. Dispatch never authenticates that route, so something in front of it is refusing the request.`,
        hint: "Check the access control on the reverse proxy — an expired edge session looks exactly like this.",
      });

    case "degraded":
      return withChecks({
        headline: "Dispatch is running, but unhealthy",
        detail: probe.problems?.length
          ? probe.problems.join(" · ")
          : "The server reports itself degraded but didn't say why.",
        hint:
          probe.spa === false
            ? "The web assets are missing from the payload — a build that didn't finish, or a swap that half-applied. Re-running the upgrade is the fix."
            : probe.store === false
              ? "The state directory can't be read. Check permissions on the data root."
              : "It answered, so it's up — but it will fail on first use until this clears.",
      });

    case "ok":
      break;
  }

  // ── HTTP is healthy. Everything from here is about the socket itself.

  if (probe.needsLogin) {
    return withChecks({
      headline: "Sign in again",
      detail:
        "The server is fine, but this tab has no valid session — so the live connection is being refused before it opens.",
      hint: "Reload to get the sign-in screen.",
      action: "sign-in",
    });
  }

  if (input.lastClose?.code === 4401) {
    return withChecks({
      headline: "Session no longer valid",
      detail: `The server closed the connection: ${describeClose(input.lastClose)}.`,
      hint: "Reload to sign in again.",
      action: "sign-in",
    });
  }

  if (input.badFrames >= STALE_FRAME_LIMIT) {
    const types = input.badFrameTypes.filter(Boolean);
    return withChecks({
      headline: "The server is speaking a protocol this build doesn't know",
      detail: `${input.badFrames} frames were rejected${types.length ? ` (${types.join(", ")})` : ""}. They're being dropped, which is why the app can look connected while it has stopped updating.`,
      hint: "Reload to pick up a matching build.",
      action: "reload",
    });
  }

  if (input.state === "open") {
    return withChecks({
      headline: "Connected, but the server hasn't said hello",
      detail:
        "The socket opened and then went quiet. Something is holding the connection open without carrying anything over it.",
      hint: upgradeHint(input.reach) ?? "The server accepted the connection but never completed the handshake.",
    });
  }

  if (input.lastClose?.code === 1011) {
    return withChecks({
      headline: "The server hit an error on this connection",
      detail: describeClose(input.lastClose),
      hint: "It'll be retried automatically. If it keeps happening, the server log has the detail.",
    });
  }

  if (input.state === "connecting" || input.state === "reconnecting") {
    return withChecks({
      headline: "Reconnecting",
      detail: "The server is responding over HTTP — reopening the live connection.",
    });
  }

  return withChecks({
    headline: "The live connection won't open",
    detail: `HTTP requests to ${input.host} are working, but the WebSocket ${describeClose(input.lastClose)}.`,
    hint: upgradeHint(input.reach) ?? "The server is answering but refusing the socket — its log will say why.",
  });
}
