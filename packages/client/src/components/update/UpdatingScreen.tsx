/**
 * The screen you get between clicking Update and the new build answering.
 *
 * An update is not a normal shutdown, and `ShutdownScreen` would be the wrong
 * answer to it: that screen says "nothing is running on this machine, start it
 * from the Start menu", which during an update is both false and the opposite of
 * what to do. The socket dies either way, so this has to outrank it — hence the
 * same `LAYER.shutdown` band and a mount ABOVE it in `App.tsx`.
 *
 * It cannot be driven by the WS, because the WS is the first thing to go. It
 * polls `/api/health` directly, which is exempt from the auth gate
 * (`app.ts:109`) and is the same probe `tools/app/upgrade.mjs` gates its own
 * swaps on. When the server answers again the page is RELOADED rather than
 * resumed: an update changes the SPA bundle and the service worker, so
 * continuing in the old bundle would leave a client talking to a server it no
 * longer matches.
 */
import { useEffect, useState } from "react";
import { ArrowUpCircle, RotateCw } from "lucide-react";
import { Button } from "../ui/Button.js";
import { useUpdate } from "../../stores/update.js";
import { LAYER } from "../../lib/layers.js";

/** How often to ask whether the new server is up. Cheap; the probe is two stats. */
const POLL_MS = 2_000;

/**
 * When to stop promising and start offering a reload button. The installer
 * re-runs `pnpm install` against the swapped payload, which on a cold store is
 * minutes, so this is generous on purpose — an update that is merely slow must
 * not be reported as broken.
 */
const PATIENCE_MS = 8 * 60 * 1000;

export function UpdatingScreen() {
  const installing = useUpdate((s) => s.installing);
  const latest = useUpdate((s) => s.status?.latest);
  const [waited, setWaited] = useState(0);

  useEffect(() => {
    if (!installing) return;
    const startedAt = Date.now();
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      setWaited(Date.now() - startedAt);
      try {
        // `cache: no-store` matters: the service worker from the OLD bundle is
        // still installed and would happily serve a cached 200 for the health
        // probe, which reads as "it's back" while the swap is still running.
        const res = await fetch("/api/health", { cache: "no-store" });
        // Any answer at all means a server is listening again. A 503 (degraded)
        // still means the swap finished — the reloaded page will show why.
        if (res.status === 200 || res.status === 503) location.reload();
      } catch {
        /* still down — that is the expected state for most of this */
      }
    };

    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [installing]);

  if (!installing) return null;
  const patient = waited > PATIENCE_MS;

  return (
    <div
      style={{ zIndex: LAYER.shutdown }}
      className="fixed inset-0 flex flex-col items-center justify-center bg-app/95 backdrop-blur-sm"
    >
      <span className="mb-3.5 flex size-12 items-center justify-center rounded-xl border border-accent-line bg-panel-2 text-accent-hi [&_svg]:size-5">
        <ArrowUpCircle className="cm-anim-pulse" />
      </span>
      <p className="text-lg font-medium text-primary">
        Updating Dispatch{latest ? ` to v${latest.version}` : ""}
      </p>
      <p className="mt-1 max-w-[440px] text-center text-sm leading-relaxed text-muted">
        {patient
          ? "This is taking longer than usual. The installer keeps the previous build and rolls back on its own if the new one doesn't come up — check update.log next to the app directory."
          : "The installer is verifying the download, swapping the app, and starting it again. This page reloads on its own when it's back."}
      </p>
      {patient && (
        <div className="mt-4 flex items-center gap-2">
          <Button variant="primary" leftIcon={<RotateCw />} onClick={() => location.reload()}>
            Reload now
          </Button>
        </div>
      )}
      <p className="mt-3.5 text-xs text-faint">
        Agents that were mid-run were stopped with the server; their transcripts are intact.
      </p>
    </div>
  );
}
