/**
 * The in-app Restart control, beside Stop.
 *
 * It exists because Stop alone was a dead end. Picking up a hand edit to
 * config.json (a plugin that holds its settings in memory, say) meant stopping
 * from here, then leaving the app to find the Start-menu shortcut. This posts
 * to `/api/restart`. The server runs the same teardown Stop does and exits with
 * the code the launcher answers by starting it again (see `launch.py`
 * supervise()).
 *
 * The switch decides whether chats that were mid-turn carry on. On, which is
 * what every graceful stop already did, the restart-resume pass continues them
 * once the server is back. Off, they come back idle. That's the restart you
 * want when the run itself is what you're restarting to get away from.
 *
 * Only offered when the launcher will actually bring the server back. Under
 * `pnpm dev` nothing would, so the button is disabled and says why. A Restart
 * that is secretly a Stop is worse than no button at all.
 */
import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "../ui/Button.js";
import { SectionLabel } from "../ui/Panel.js";
import { ToggleRow } from "../ui/ToggleRow.js";
import { api } from "../../lib/api.js";
import { useChats } from "../../stores/chats.js";
import { useNotices } from "../../stores/notices.js";
import { BUSY } from "./StopDispatch.js";

/** Remembered per browser: whoever restarts to get unstuck usually does it the same way next time. */
const RESUME_KEY = "dispatch:restart-resume-agents";

function readResumePref(): boolean {
  try {
    return localStorage.getItem(RESUME_KEY) !== "0";
  } catch {
    return true;
  }
}

export function RestartDispatch() {
  const busyChats = useChats(
    (s) => Object.values(s.byId).filter((c) => BUSY.has(c.status ?? "")).length,
  );
  const pushToast = useNotices((s) => s.push);

  const [resume, setResume] = useState(readResumePref);
  // undefined while asking; the answer decides whether the button is live.
  const [support, setSupport] = useState<{ supported: boolean; error?: string }>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.restart
      .status()
      .then((s) => !cancelled && setSupport(s))
      // A server older than this route can't restart either.
      .catch(() => !cancelled && setSupport({ supported: false }));
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleResume(next: boolean) {
    setResume(next);
    try {
      localStorage.setItem(RESUME_KEY, next ? "1" : "0");
    } catch {
      /* private mode: the choice still applies to this click */
    }
  }

  async function restart() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.restart.request(resume);
      if (!res.ok) {
        pushToast({ level: "error", text: "Couldn't restart Dispatch", detail: res.error });
        setBusy(false);
        setConfirming(false);
      }
      // On success, stay busy: `server-shutdown` (restarting) is in flight and
      // RestartingScreen is about to cover the app.
    } catch (e) {
      // Same as Stop: teardown can outrun its own reply, and the socket event
      // is the source of truth.
      pushToast({
        level: "warn",
        text: "Restart requested, but the reply never arrived",
        detail: e instanceof Error ? e.message : String(e),
      });
      setBusy(false);
      setConfirming(false);
    }
  }

  const unsupported = support !== undefined && !support.supported;
  const working =
    busyChats > 0
      ? `${busyChats} ${busyChats === 1 ? "agent is" : "agents are"} working right now`
      : null;

  return (
    <div>
      <SectionLabel className="mb-1.5 px-0">
        <span className="inline-flex items-center gap-1.5 [&_svg]:size-3">
          <RotateCw /> Restart
        </span>
      </SectionLabel>
      <div className="rounded-md border border-line bg-inset/40 px-2.5 py-2">
        <p className="text-xs leading-snug text-faint">
          Stops the server cleanly and starts it again, which reloads config and plugins.
          Sub-apps are stopped and not restarted. This page reconnects by itself.
        </p>
        <ToggleRow
          className="mt-2"
          checked={resume}
          onChange={toggleResume}
          disabled={busy}
          title="Resume agents that were working"
          description={
            resume
              ? "Chats that were mid-turn carry on once the server is back."
              : "Chats that were mid-turn come back idle. Nothing is resumed."
          }
        />
        {working && (
          <p className="mt-1.5 text-xs font-medium leading-snug text-warn">
            {working}. {resume ? "They'll be resumed." : "They'll be interrupted."}
          </p>
        )}
        {unsupported && (
          <p className="mt-1.5 text-xs leading-snug text-muted">
            {support?.error ??
              "This server can't restart itself. Stop it and start it again by hand."}
          </p>
        )}
        <div className="mt-2 flex items-center gap-2">
          {confirming ? (
            <>
              <Button variant="primary" onClick={() => void restart()} disabled={busy}>
                {busy ? "Restarting…" : "Yes, restart Dispatch"}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </Button>
            </>
          ) : (
            <Button
              variant="default"
              leftIcon={<RotateCw />}
              onClick={() => setConfirming(true)}
              disabled={support === undefined || unsupported}
            >
              Restart Dispatch
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
