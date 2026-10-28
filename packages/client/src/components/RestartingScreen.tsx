/**
 * The screen between Restart and the new server answering.
 *
 * ShutdownScreen can't cover this. Everything it says ("start it again from the
 * Start menu, then hit Reconnect") is wrong when the launcher is already
 * starting it, and a Reconnect clicked too early lands on a closed port.
 * So this watches `/api/health` and reloads by itself once a DIFFERENT process
 * answers. The old server is still up for the first moments of its own
 * teardown, and reloading into it would just put this screen back.
 *
 * It learns "different" one of two ways. If the first probe reaches the old
 * process, that pid/startedAt becomes the baseline and `isNewProcess` decides.
 * If the port is already closed by then, there is no baseline, and any answer
 * after seeing it down is the new server. That second path is also how a tab
 * on another device, which never clicked anything, gets through.
 */
import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "./ui/Button.js";
import { Spinner } from "./ui/Spinner.js";
import { useConnection } from "../stores/connection.js";
import { LAYER } from "../lib/layers.js";
import { isNewProcess, probeHealth, probeReady, type HealthProbe } from "../lib/updateProbe.js";

const POLL_MS = 1_000;

/**
 * When to stop promising and say something may be wrong. Teardown has a 20s
 * grace window and a cold boot takes a few seconds more, so a minute is a
 * restart that has failed, not one that is slow.
 */
const PATIENCE_MS = 60_000;

export function RestartingScreen() {
  const restarting = useConnection((s) => s.stopped && s.restarting === true);
  const [overdue, setOverdue] = useState(false);

  useEffect(() => {
    if (!restarting) return;
    let cancelled = false;
    let baseline: HealthProbe | null = null;
    let seenDown = false;
    const started = Date.now();

    const tick = async () => {
      if (cancelled) return;
      const probe = await probeHealth();
      if (cancelled) return;
      if (!probe) {
        seenDown = true;
      } else if (!baseline && !seenDown) {
        baseline = probe;
      } else {
        const fresh = baseline
          ? isNewProcess(probe, {
              fromPid: baseline.pid,
              fromStartedAt: baseline.startedAt,
              fromVersion: null,
            })
          : true;
        // The health route answers before the SPA is served. Reloading into a
        // page that isn't there yet would leave no script on screen to retry.
        if (fresh && (await probeReady())) {
          location.reload();
          return;
        }
      }
      if (Date.now() - started > PATIENCE_MS) setOverdue(true);
      if (!cancelled) setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [restarting]);

  if (!restarting) return null;

  return (
    <div
      style={{ zIndex: LAYER.shutdown }}
      className="fixed inset-0 flex flex-col items-center justify-center bg-app/95 backdrop-blur-sm"
    >
      <span className="mb-3.5 flex size-12 items-center justify-center rounded-xl border border-line bg-panel-2 text-muted">
        <Spinner size={20} />
      </span>
      <p className="text-lg font-medium text-primary">Restarting Dispatch…</p>
      <p className="mt-1 max-w-[420px] text-center text-sm leading-relaxed text-muted">
        Shutting down cleanly and starting again. This page reloads by itself when the
        server is back.
      </p>
      {overdue && (
        <>
          <p className="mt-3.5 max-w-[420px] text-center text-xs leading-relaxed text-warn">
            It hasn't come back after a minute. The reason is usually at the end of{" "}
            <code className="cm-mono rounded bg-inset px-1 py-px text-2xs">boot-&lt;port&gt;.log</code>{" "}
            in the Dispatch folder.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button variant="ghost" leftIcon={<RotateCw />} onClick={() => location.reload()}>
              Reload now
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
