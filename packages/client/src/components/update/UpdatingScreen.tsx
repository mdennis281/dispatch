/**
 * The single page an update happens on, from clicking Update to the new build
 * answering — or to being told, honestly, that it failed and rolled back.
 *
 * This used to be a spinner over a two-second `location.reload()` poll, and the
 * combination produced the flapping this replaced. The reason is worth writing
 * down, because it is not obvious: `tools/install.mjs` does not stop the server
 * early. It resolves the release, downloads a tarball, verifies its checksum,
 * unpacks it and runs a full `pnpm install` against the staged payload BEFORE it
 * ever calls `launch.py --stop`. That is minutes, and for every second of it the
 * old server is up and healthy. A poll that reloads on any 200 therefore reloads
 * two seconds after you click Update, and again two seconds after that, cycling
 * login → shell → updating for the whole install, until the server finally dies
 * mid-cycle and leaves you on a shutdown screen that says to go start it from
 * the Start menu — which during an update is both false and the opposite of what
 * to do.
 *
 * Three rules follow, and they are the whole design:
 *
 *   1. **Never reload until a DIFFERENT process answers.** `/api/health` reports
 *      `pid` and `startedAt`; the identity of the server that accepted the
 *      install is recorded in `cm:update-inflight` before it starts going down.
 *      This is the same gate `tools/app/upgrade.mjs` applies to its own swaps.
 *   2. **Survive a reload.** The marker is in localStorage, and the store adopts
 *      it on the first frame, so a refresh (or a crash, or session restore) lands
 *      back here rather than on a login form. The screen also renders ABOVE
 *      `AuthGate` for the same reason: an update is not a thing you should have
 *      to sign in to watch.
 *   3. **Say what is happening.** Phases come from `/api/update/progress`, which
 *      reads the installer's own output. While the old server is alive that is
 *      live truth; once it goes down the phase is inferred (`swapping`), and the
 *      new server re-reads the same log to report the outcome.
 *
 * The reload at the end is still a reload: an update replaces the SPA bundle and
 * the service worker, so resuming in the old bundle would leave a client talking
 * to a server it no longer matches.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowUpCircle, Check, ChevronDown, RotateCw } from "lucide-react";
import type { UpdatePhase } from "@dispatch/shared";
import { Button } from "../ui/Button.js";
import { useUpdate } from "../../stores/update.js";
import type { UpdateFlight } from "../../lib/updatePrefs.js";
import { LAYER } from "../../lib/layers.js";
import { isNewProcess, probeHealth, probeProgress } from "../../lib/updateProbe.js";

/** Fast enough to feel live, slow enough to be free — the probe is two stats. */
const POLL_MS = 1_500;

/**
 * Consecutive failed probes before the server counts as genuinely down.
 *
 * One miss is not evidence: the installer saturates the disk during `pnpm
 * install` and a single request can be dropped. Three across ~4.5s of loopback
 * is a closed port, and treating it as such is what lets the screen move to
 * `swapping` at the right moment instead of flickering there and back.
 */
const DOWN_STREAK = 3;

/**
 * When to stop promising and offer a manual reload. The installer re-runs `pnpm
 * install` twice against a possibly-cold store, so this is generous on purpose —
 * an update that is merely slow must not be reported as broken.
 */
const PATIENCE_MS = 8 * 60 * 1000;

/**
 * The ordered story of an install. Index drives the bar, so this must stay in
 * the same order as `UpdatePhaseSchema` — see the note there.
 */
const STEPS: ReadonlyArray<{ phase: UpdatePhase; label: string }> = [
  { phase: "launching", label: "Starting the installer" },
  { phase: "resolving", label: "Finding the release" },
  { phase: "downloading", label: "Downloading" },
  { phase: "verifying", label: "Checking the download" },
  { phase: "extracting", label: "Unpacking" },
  { phase: "dependencies", label: "Installing dependencies" },
  { phase: "stopping", label: "Stopping Dispatch" },
  { phase: "swapping", label: "Swapping in the new build" },
  { phase: "relinking", label: "Linking dependencies" },
  { phase: "starting", label: "Starting the new build" },
  { phase: "done", label: "Done" },
];

const stepIndex = (phase: UpdatePhase): number => STEPS.findIndex((s) => s.phase === phase);

type Stage = "working" | "failed";

export function UpdatingScreen() {
  const flight = useUpdate((s) => s.flight);
  const statusInstalling = useUpdate((s) => s.status?.installing);
  const adopt = useUpdate((s) => s.adopt);

  // An install this tab did not start (a second tab, or the server still
  // reporting one after a reload) needs a marker of its own before `Attempt`
  // has anything to watch for. This lives out here because it has to run while
  // there is no flight at all — which is exactly when `Attempt` is not mounted.
  useEffect(() => {
    if (statusInstalling && !flight) void adopt();
  }, [statusInstalling, flight, adopt]);

  if (!flight) return null;

  // Keyed, so a second install in the same tab gets a genuinely fresh render
  // rather than inheriting the last one. This component stays mounted forever
  // (it renders `null` between updates), and a FAILED update ends without a
  // reload — the user clicks "Back to Dispatch" and carries on. Without the key,
  // the next update would open still saying "Update failed", still showing the
  // previous run's log, and with `highWater` already ratcheted forward so every
  // early phase of the new install was discarded as backwards movement.
  return <Attempt key={flight.startedAt} flight={flight} />;
}

function Attempt({ flight }: { flight: UpdateFlight }) {
  const endFlight = useUpdate((s) => s.endFlight);

  const [phase, setPhase] = useState<UpdatePhase>("launching");
  const [stage, setStage] = useState<Stage>("working");
  const [failure, setFailure] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [waited, setWaited] = useState(0);
  const [showLog, setShowLog] = useState(false);

  // The bar only ever moves forwards. The phase is derived from a log that is
  // read by two different processes either side of a restart, and a momentary
  // disagreement between them must not look like the update coming undone.
  const highWater = useRef(0);
  const ratchet = useCallback((next: UpdatePhase) => {
    const index = stepIndex(next);
    if (index < 0 || index < highWater.current) return;
    highWater.current = index;
    setPhase(next);
  }, []);

  useEffect(() => {
    let stopped = false;
    let downStreak = 0;
    // Decided on the FIRST answering probe. If the very first thing we see is
    // already a different process, this page was loaded AFTER the swap — it is
    // running the new bundle — so the update is simply over and reloading it
    // again would be the loop this screen exists to end.
    let mountedAfterSwap: boolean | null = null;

    const finish = (reload: boolean) => {
      stopped = true;
      endFlight();
      if (reload) location.reload();
    };

    const tick = async () => {
      if (stopped) return;
      setWaited(Date.now() - flight.startedAt);

      const health = await probeHealth();
      if (stopped) return;

      if (!health) {
        downStreak += 1;
        // Only once it is properly down: the swap is the one phase nothing can
        // report, because the process that would report it is the one being
        // replaced.
        if (downStreak >= DOWN_STREAK) {
          if (mountedAfterSwap === null) mountedAfterSwap = false;
          ratchet("swapping");
        }
        return;
      }

      const wentDown = downStreak >= DOWN_STREAK;
      downStreak = 0;

      const fresh = isNewProcess(health, flight.fromPid, flight.fromStartedAt);
      if (mountedAfterSwap === null) mountedAfterSwap = fresh;

      const progress = await probeProgress();
      if (stopped) return;
      if (progress) {
        if (progress.log) setLog(progress.log);
        ratchet(progress.phase === "failed" ? "swapping" : progress.phase);
      }

      // The installer's own error line. This can arrive while the OLD server is
      // still up and always will when the install dies before the stop (a bad
      // download, a checksum mismatch) — in which case no restart is coming and
      // waiting for one would hang here forever.
      if (progress?.phase === "failed") {
        stopped = true;
        setFailure(progress.failure ?? "the installer did not say why");
        setStage("failed");
        return;
      }

      // `wentDown` is the fallback for a server too old to report `pid` in its
      // health payload: watching it go and come back proves a restart happened
      // even when there is no identity to compare.
      if (!fresh && !wentDown) return;

      // A new build is answering. Reload — unless this page already IS the new
      // build, having been loaded after the swap, in which case the marker is
      // just stale bookkeeping to clear.
      finish(mountedAfterSwap !== true);
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [flight, endFlight, ratchet]);

  const index = Math.max(0, stepIndex(phase));
  const patient = waited > PATIENCE_MS;

  return (
    <div
      style={{ zIndex: LAYER.shutdown }}
      className="fixed inset-0 flex flex-col items-center justify-center bg-app/95 p-6 backdrop-blur-sm"
    >
      <div className="w-full max-w-[440px]">
        <div className="flex flex-col items-center text-center">
          <span
            className={
              stage === "failed"
                ? "mb-3.5 flex size-12 items-center justify-center rounded-xl border border-danger-line bg-panel-2 text-danger [&_svg]:size-5"
                : "mb-3.5 flex size-12 items-center justify-center rounded-xl border border-accent-line bg-panel-2 text-accent-hi [&_svg]:size-5"
            }
          >
            {stage === "failed" ? <AlertTriangle /> : <ArrowUpCircle className="cm-anim-pulse" />}
          </span>
          <p className="text-lg font-medium text-primary">
            {stage === "failed"
              ? "Update failed"
              : `Updating Dispatch${flight.version ? ` to v${flight.version}` : ""}`}
          </p>
        </div>

        {stage === "failed" ? (
          <>
            <p className="mt-1 text-center text-sm leading-relaxed text-muted">
              The installer stopped and put the previous build back. Dispatch is still running the
              version you had.
            </p>
            <p className="mt-3 rounded-lg border border-line bg-inset p-3 text-left text-xs leading-relaxed text-secondary">
              {failure}
            </p>
          </>
        ) : (
          <>
            <Progress index={index} total={STEPS.length - 1} />
            <p className="mt-2.5 text-center text-sm text-secondary">
              {STEPS[index]?.label ?? "Working"}
              <span className="ml-1.5 text-faint">{elapsed(waited)}</span>
            </p>
            <p className="mt-1 text-center text-xs leading-relaxed text-muted">
              {phase === "swapping"
                ? "Dispatch is restarting. This page is waiting for the new build — you don't need to do anything."
                : patient
                  ? "This is taking longer than usual. The installer keeps the previous build and rolls it back on its own if the new one doesn't come up."
                  : "You can leave this page open. It takes over as soon as the new build answers."}
            </p>
          </>
        )}

        <div className="mt-4 flex items-center justify-center gap-2">
          {stage === "failed" ? (
            <Button variant="primary" leftIcon={<Check />} onClick={endFlight}>
              Back to Dispatch
            </Button>
          ) : (
            patient && (
              <Button variant="primary" leftIcon={<RotateCw />} onClick={() => location.reload()}>
                Reload now
              </Button>
            )
          )}
          {log.length > 0 && (
            <Button
              leftIcon={<ChevronDown className={showLog ? "rotate-180 transition-transform" : "transition-transform"} />}
              onClick={() => setShowLog((v) => !v)}
            >
              {showLog ? "Hide log" : "Show log"}
            </Button>
          )}
        </div>

        {showLog && log.length > 0 && (
          <pre className="cm-mono mt-3 max-h-56 overflow-auto rounded-lg border border-line bg-inset p-3 text-left text-2xs leading-relaxed text-secondary">
            {log.join("\n")}
          </pre>
        )}

        {stage !== "failed" && (
          <p className="mt-3.5 text-center text-xs text-faint">
            Agents that were mid-run are stopped with the server and pick themselves
            back up a few seconds after it returns; their transcripts are intact
            either way.
          </p>
        )}
      </div>
    </div>
  );
}

/** Determinate where we know, and never jumping backwards — see `highWater`. */
function Progress({ index, total }: { index: number; total: number }) {
  const pct = Math.round((Math.min(index, total) / total) * 100);
  return (
    <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-inset">
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
        style={{ width: `${Math.max(pct, 4)}%` }}
      />
    </div>
  );
}

function elapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}
