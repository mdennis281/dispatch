/**
 * The in-app Stop control.
 *
 * Stopping Dispatch used to mean leaving it: find a terminal, `pnpm app:stop`.
 * This posts to `/api/shutdown`, which runs the same teardown that command does
 * — sessions disposed, sub-apps and shells killed rather than orphaned onto the
 * ports they hold.
 *
 * It's behind a two-step confirm, and the confirm NAMES what dies. "Are you
 * sure?" is a question nobody can answer; "3 agents are working, 2 sub-apps are
 * running" is. The counts come from the live stores, which the WS keeps current
 * across every connected client — so in host mode this reflects the work started
 * from your laptop even when you're stopping from your phone.
 *
 * Closing the window is still NOT this. That distinction is deliberate and old:
 * a reflex Alt-F4 must not kill a three-hour run. This button is the deliberate
 * verb that was missing.
 */
import { useState } from "react";
import { Power } from "lucide-react";
import { Button } from "../ui/Button.js";
import { SectionLabel } from "../ui/Panel.js";
import { api } from "../../lib/api.js";
import { useChats } from "../../stores/chats.js";
import { useRunners } from "../../stores/runners.js";
import { useNotices } from "../../stores/notices.js";

/** Chat statuses that mean a session is mid-flight and would be interrupted. */
const BUSY: ReadonlySet<string> = new Set(["running", "queued", "awaiting-input"]);
/** Runner statuses that own a live OS process. */
const LIVE: ReadonlySet<string> = new Set(["starting", "running", "stopping"]);

/** "3 agents and 2 sub-apps", or null when nothing is actually in flight. */
function describeLosses(chats: number, runners: number): string | null {
  const parts: string[] = [];
  if (chats > 0) parts.push(`${chats} ${chats === 1 ? "agent is" : "agents are"} working`);
  if (runners > 0)
    parts.push(`${runners} ${runners === 1 ? "sub-app is" : "sub-apps are"} running`);
  return parts.length > 0 ? parts.join(" and ") : null;
}

export function StopDispatch() {
  const busyChats = useChats(
    (s) => Object.values(s.byId).filter((c) => BUSY.has(c.status ?? "")).length,
  );
  const liveRunners = useRunners(
    (s) => Object.values(s.byId).filter((r) => LIVE.has(r.status)).length,
  );
  const pushToast = useNotices((s) => s.push);

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const losses = describeLosses(busyChats, liveRunners);

  async function stop() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.shutdown();
      // A 503 body rather than a throw: the server is up but wasn't wired for
      // shutdown, which is a different problem from the request failing.
      if (!res.ok) {
        pushToast({ level: "error", text: "Couldn't stop Dispatch", detail: res.error });
        setBusy(false);
        setConfirming(false);
      }
      // On success we deliberately stay busy: the `server-shutdown` event is
      // already in flight and ShutdownScreen is about to cover the app. Clearing
      // the flag would just flash the button back to life on the way out.
    } catch (e) {
      // The teardown can outrun its own response on a slow box. The socket will
      // still deliver `server-shutdown`, so treat this as "probably worked" and
      // let the stopped screen be the source of truth rather than crying wolf.
      pushToast({
        level: "warn",
        text: "Stop requested, but the reply never arrived",
        detail: e instanceof Error ? e.message : String(e),
      });
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div>
      <SectionLabel className="mb-1.5 px-0">
        <span className="inline-flex items-center gap-1.5 [&_svg]:size-3">
          <Power /> Stop
        </span>
      </SectionLabel>
      <div className="rounded-md border border-line bg-inset/40 px-2.5 py-2">
        <p className="text-xs leading-snug text-faint">
          Shuts down the server, every agent session, and every sub-app it started.
          Closing the window doesn't do this — nothing else will.
        </p>
        {losses && (
          <p className="mt-1.5 text-xs font-medium leading-snug text-warn">
            Right now, {losses}.
          </p>
        )}
        <div className="mt-2 flex items-center gap-2">
          {confirming ? (
            <>
              <Button variant="danger" onClick={() => void stop()} disabled={busy}>
                {busy ? "Stopping…" : "Yes, stop Dispatch"}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="danger" leftIcon={<Power />} onClick={() => setConfirming(true)}>
              Stop Dispatch
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
