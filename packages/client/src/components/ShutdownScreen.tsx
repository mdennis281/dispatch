/**
 * The screen you get after Dispatch stops on purpose.
 *
 * It exists so a deliberate stop doesn't look like a bug. Without it the app
 * keeps rendering a full UI whose every control silently fails, behind a status
 * dot that says "reconnecting" to a process that has to be started by hand — and
 * in host mode that lie is served to every other device that had a tab open.
 *
 * So it covers the app completely rather than sitting in a corner: nothing below
 * it works any more, and pretending otherwise just wastes clicks. Reconnecting
 * is a reload, because the stores need rehydrating from a server that has
 * restarted with fresh state anyway.
 */
import { Power, RotateCw } from "lucide-react";
import { Button } from "./ui/Button.js";
import { useConnection } from "../stores/connection.js";
import { LAYER } from "../lib/layers.js";

export function ShutdownScreen() {
  const stopped = useConnection((s) => s.stopped);
  const reason = useConnection((s) => s.stoppedReason);
  if (!stopped) return null;

  return (
    // Above EVERY other layer (see lib/layers). Anything that outranked this
    // would be a dialog floating over a dead server, still taking clicks that
    // can no longer do anything — and the Settings modal you pressed Stop in is
    // exactly that case.
    <div
      style={{ zIndex: LAYER.shutdown }}
      className="fixed inset-0 flex flex-col items-center justify-center bg-app/95 backdrop-blur-sm"
    >
      <span className="mb-3.5 flex size-12 items-center justify-center rounded-xl border border-line bg-panel-2 text-muted [&_svg]:size-5">
        <Power />
      </span>
      <p className="text-lg font-medium text-primary">Dispatch has stopped</p>
      <p className="mt-1 max-w-[420px] text-center text-sm leading-relaxed text-muted">
        Every agent session and sub-app was shut down cleanly
        {reason ? ` (${reason})` : ""}. Nothing is running on this machine.
      </p>
      <div className="mt-4 flex items-center gap-2">
        <Button variant="primary" leftIcon={<RotateCw />} onClick={() => location.reload()}>
          Reconnect
        </Button>
      </div>
      <p className="mt-3.5 text-xs text-faint">
        Start it again from the Start-menu shortcut, or{" "}
        <code className="cm-mono rounded bg-inset px-1 py-px text-2xs">pnpm app</code> in
        the checkout — then hit Reconnect.
      </p>
    </div>
  );
}
