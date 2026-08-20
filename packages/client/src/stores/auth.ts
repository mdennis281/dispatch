import { create } from "zustand";
import type { AuthSessionResponse, AuthStatus, AuthUserSummary } from "@dispatch/shared";

interface AuthStore {
  ready: boolean;
  status: AuthStatus | null;
  /**
   * `initializeAuth` could not reach the server, so `status` below is a
   * PLACEHOLDER rather than an answer.
   *
   * It has to be a placeholder — the shell needs a shape to render against — but
   * the placeholder says "auth is off", and if auth is in fact on that is a lie
   * with consequences: the app boots an unauthenticated shell whose every
   * control fails, and the WS upgrade is refused with a 401 the browser never
   * surfaces. This flag is how the connecting screen knows to ask again once the
   * server answers, instead of leaving the tab wrong until someone reloads.
   */
  unreachable: boolean;
  accessToken: string | null;
  user: AuthUserSummary | null;
  applyStatus: (status: AuthStatus) => void;
  markUnreachable: () => void;
  applySession: (session: AuthSessionResponse) => void;
  clear: () => void;
}

function tellWorker(token: string | null): void {
  if (typeof navigator === "undefined") return;
  navigator.serviceWorker?.controller?.postMessage({ type: "auth-token", token });
  navigator.serviceWorker?.ready.then((registration) => registration.active?.postMessage({ type: "auth-token", token })).catch(() => {});
}

export const useAuth = create<AuthStore>((set) => ({
  ready: false, status: null, unreachable: false, accessToken: null, user: null,
  applyStatus: (status) => set({ ready: true, status, user: status.user, unreachable: false }),
  markUnreachable: () => set({ unreachable: true }),
  applySession: (session) => {
    tellWorker(session.accessToken);
    set((state) => ({ accessToken: session.accessToken, user: session.user,
      status: state.status ? { ...state.status, user: session.user } : state.status }));
  },
  clear: () => { tellWorker(null); set((state) => ({ accessToken: null, user: null,
    status: state.status ? { ...state.status, user: null } : state.status })); },
}));

let refreshInFlight: Promise<boolean> | null = null;

async function refreshAttempt(retryConflict = true): Promise<boolean> {
  const response = await fetch("/api/auth/refresh", { method: "POST", credentials: "same-origin",
    headers: { "x-dispatch-session": "refresh" } });
  if (response.status === 409 && retryConflict) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return refreshAttempt(false);
  }
  if (!response.ok) return false;
  useAuth.getState().applySession(await response.json() as AuthSessionResponse);
  return true;
}

async function refresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshAttempt().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

export async function initializeAuth(): Promise<void> {
  try {
    const first = await fetch("/api/auth/status", { credentials: "same-origin" });
    const status = await first.json() as AuthStatus;
    useAuth.getState().applyStatus(status);
    if (status.enabled && !status.user) {
      if (await refresh()) {
        const token = useAuth.getState().accessToken;
        const response = await fetch("/api/auth/status", { headers: token ? { authorization: `Bearer ${token}` } : undefined });
        if (response.ok) useAuth.getState().applyStatus(await response.json() as AuthStatus);
      }
    }
  } catch {
    // Keep the normal reconnecting shell when the server is temporarily down —
    // but FLAG it, because this answer is a guess. `ConnectingScreen` re-runs
    // this the moment the server starts answering again, so a tab that booted
    // during an outage ends up with the real auth state rather than this stand-in.
    useAuth.getState().applyStatus({ enabled: false, configured: false, firstRunDismissed: true, user: null });
    useAuth.getState().markUnreachable();
  }
}

export async function sessionFetch(input: RequestInfo | URL, init: RequestInit = {}, retry = true): Promise<Response> {
  const token = useAuth.getState().accessToken;
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(input, { ...init, headers, credentials: "same-origin" });
  if (response.status === 401 && retry && useAuth.getState().status?.enabled && await refresh()) {
    return sessionFetch(input, init, false);
  }
  return response;
}

export async function authPost<T>(path: string, body?: unknown): Promise<T> {
  // Only declare a JSON body when there is one: a bodyless POST that still
  // announces application/json is rejected by Fastify's parser with
  // FST_ERR_CTP_EMPTY_JSON_BODY (400) before the route ever runs, which is what
  // silently broke TOTP setup, passkey enrollment, invites, logout and disable.
  const headers: Record<string, string> = { "x-dispatch-session": "refresh" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await sessionFetch(path, { method: "POST", headers,
    body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(json.error ?? "Authentication request failed");
  return json as T;
}

export async function authDelete<T>(path: string, body?: unknown): Promise<T> {
  const response = await sessionFetch(path, { method: "DELETE", headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(json.error ?? "Authentication request failed");
  return json as T;
}

export async function authPut<T>(path: string, body: unknown): Promise<T> {
  const response = await sessionFetch(path, { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) });
  const json = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(json.error ?? "Authentication request failed");
  return json as T;
}
