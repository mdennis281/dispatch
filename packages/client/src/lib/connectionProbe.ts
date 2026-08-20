/**
 * The HTTP-side probe behind the connecting screen: "can I reach the server at
 * all, and if something answered, was it Dispatch?"
 *
 * Deliberately separate from `lib/api.ts`, for the reasons `updateProbe.ts`
 * spells out — `api` throws on a non-2xx and re-authenticates on a 401, and both
 * are wrong when the question IS whether the server is there. It is also
 * separate from `updateProbe.probeHealth`, whose contract is narrower on
 * purpose: that one collapses everything that isn't 200-or-503 into `null`,
 * because an update only needs to know "is the new process up yet". Here the
 * codes it discards are the entire diagnosis.
 *
 * `cache: "no-store"` throughout. The service worker is still installed and
 * still holds a shell, and a cached 200 for a health probe reads as "the server
 * is back" while it is very much not.
 */
import type { ServerProbe, ProbeKind } from "../stores/connection.js";

/** A probe that hasn't answered by now is not going to; the caller retries. */
const PROBE_TIMEOUT_MS = 8_000;

/**
 * Statuses that mean "an edge answered, the thing behind it did not".
 *
 * 502/504 are the nginx/Caddy/Traefik pair; 520-526 are Cloudflare's own range
 * for the same condition. All of them need a different instruction from "start
 * Dispatch" — the tunnel is up, so the machine is reachable and it is the app
 * that is missing.
 */
function isGatewayStatus(status: number): boolean {
  return status === 502 || status === 504 || (status >= 520 && status <= 526);
}

async function fetchWithTimeout(path: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(path, { cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface HealthBody {
  ok?: unknown;
  status?: unknown;
  problems?: unknown;
  spa?: unknown;
  store?: unknown;
  pid?: unknown;
}

/** Only strings survive into the report — a malformed body must not render as `[object Object]`. */
function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length ? out : undefined;
}

/**
 * Probe `/api/health`, which is exempt from the auth gate precisely so it can be
 * reached in this situation (see server/src/app.ts).
 */
export async function probeServer(): Promise<ServerProbe> {
  const at = Date.now();
  let response: Response;
  try {
    response = await fetchWithTimeout("/api/health");
  } catch {
    // A rejected fetch is indistinguishable from DNS failure, a refused
    // connection and a TLS error — the browser deliberately doesn't say which.
    // "Nothing answered" is the most it can honestly be called.
    return { kind: "unreachable", at };
  }

  const status = response.status;
  if (status === 401 || status === 403) {
    // Not Dispatch: `/api/health` is unauthenticated, so a 401 here came from
    // something in front of it.
    return { kind: "unauthorized", status, at };
  }

  let body: HealthBody | null = null;
  try {
    body = (await response.json()) as HealthBody;
  } catch {
    body = null;
  }

  // A body that isn't Dispatch's health report means something else answered on
  // this origin — a proxy's own error page, or a captive portal's login page
  // handing back HTML with a 200. Both look like success to a status-code check.
  // `pid` is the tell: it is unconditional in the report and in nothing else.
  if (body === null || typeof body.pid !== "number") {
    return { kind: isGatewayStatus(status) ? "gateway" : "not-json", status, at };
  }

  // Below here it IS Dispatch answering, so a 503 is its own degraded report
  // rather than a gateway's — which is why the gateway check above is gated on
  // the body failing to parse as one.
  const kind: ProbeKind = body.ok === true ? "ok" : "degraded";
  return {
    kind,
    status,
    ...(strings(body.problems) ? { problems: strings(body.problems)! } : {}),
    ...(typeof body.spa === "boolean" ? { spa: body.spa } : {}),
    ...(typeof body.store === "boolean" ? { store: body.store } : {}),
    at,
  };
}

/**
 * Whether auth is on server-side while this tab holds no session.
 *
 * Worth asking separately because a rejected WS upgrade is INVISIBLE to the
 * client: the browser never surfaces the 401 response to JavaScript, it just
 * reports close code 1006 — the same code a proxy that ate the upgrade produces.
 * `/api/auth/status` is also auth-exempt, so it can tell the two apart.
 */
export async function probeNeedsLogin(): Promise<boolean | undefined> {
  try {
    const response = await fetchWithTimeout("/api/auth/status");
    if (!response.ok) return undefined;
    const body = (await response.json()) as { enabled?: unknown; user?: unknown };
    if (body.enabled !== true) return false;
    return body.user == null;
  } catch {
    return undefined;
  }
}
