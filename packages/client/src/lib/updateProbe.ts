/**
 * The two probes the updating screen runs, deliberately outside `lib/api.ts`.
 *
 * `api` is built for a server that is there: it throws on a non-2xx, refreshes
 * the session on a 401, and surfaces failures as errors worth reporting. During
 * an update every one of those is wrong. The server going away is the expected
 * middle of the process, not a fault; a 401 must not trigger a re-auth dance
 * against a process that is being replaced; and a 503 from a half-started build
 * is information, not an exception. So these two speak `fetch` directly and
 * answer `null` for "could not tell", which the caller reads as "still down".
 *
 * Both send `cache: "no-store"`. The service worker registered by the OLD bundle
 * is still installed and will happily serve a cached 200 for a health probe,
 * which reads as "it's back" while the swap is still running.
 */
import type { UpdateProgress } from "@dispatch/shared";
import { useAuth } from "../stores/auth.js";

/**
 * The identity half of `/api/health`. `pid` and `startedAt` are what make the
 * difference between "a server answered" and "the NEW server answered" — the
 * same pair `tools/app/upgrade.mjs` gates its own swaps on, and the pair whose
 * absence let the old screen reload itself in a loop against the pre-swap
 * server for the entire install.
 */
export interface HealthProbe {
  ok: boolean;
  pid: number | null;
  startedAt: number | null;
  sha: string | null;
}

export async function probeHealth(): Promise<HealthProbe | null> {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    // 503 is a degraded but LIVE server — a new build whose SPA or store has a
    // problem. That is still "it came back", and the reloaded page is where the
    // problem gets reported, so it must not be filtered out here.
    if (res.status !== 200 && res.status !== 503) return null;
    const body = (await res.json()) as Partial<HealthProbe>;
    return {
      ok: body.ok === true,
      pid: typeof body.pid === "number" ? body.pid : null,
      startedAt: typeof body.startedAt === "number" ? body.startedAt : null,
      sha: typeof body.sha === "string" ? body.sha : null,
    };
  } catch {
    return null; // down — the expected state for most of the swap
  }
}

/**
 * Whether `probe` is a DIFFERENT process from the one that accepted the install.
 *
 * Unknown identity answers false, which is the safe direction: it means "keep
 * waiting" rather than "declare victory and reload", and waiting is recoverable
 * by the patience timer while a wrong reload is the bug being fixed.
 */
export function isNewProcess(
  probe: HealthProbe,
  fromPid: number | null,
  fromStartedAt: number | null,
): boolean {
  if (fromPid === null && fromStartedAt === null) return false;
  if (probe.pid !== null && fromPid !== null && probe.pid !== fromPid) return true;
  // A recycled pid is not far-fetched on a machine that just restarted a service,
  // so process start time is checked independently rather than as a tiebreak.
  if (probe.startedAt !== null && fromStartedAt !== null && probe.startedAt > fromStartedAt) return true;
  return false;
}

export async function probeProgress(): Promise<UpdateProgress | null> {
  try {
    const token = useAuth.getState().accessToken;
    const res = await fetch("/api/update/progress", {
      cache: "no-store",
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    });
    if (!res.ok) return null;
    return (await res.json()) as UpdateProgress;
  } catch {
    return null;
  }
}
