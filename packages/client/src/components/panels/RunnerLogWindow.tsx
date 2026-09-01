/**
 * RunnerLogWindow — the standalone, read-only log terminal rendered in a DETACHED
 * browser window (opened via {@link openRunnerLogWindow}). `main.tsx` mounts this
 * INSTEAD of the full app when the URL carries `?logs=<runnerId>`, so it loads the
 * same bundle but shows only one runner's stdout/stderr.
 *
 * Data path: the window opens its own WS (the shared `ws` singleton + `startLiveData`
 * bootstrap in main.tsx), so `runner-log` events append to the runners store live.
 * Because a fresh connection has no history, we ALSO backfill once from
 * `GET /api/runners/:id/logs` and stitch it in front of the live tail.
 */
import { useEffect, useMemo } from "react";
import { Terminal, ExternalLink } from "lucide-react";
import { useRunners } from "../../stores/runners.js";
import { useConnection } from "../../stores/index.js";
import { StatusDot } from "../ui/StatusDot.js";
import { RunnerTranscript } from "./RunnerTranscript.js";

const ACTIVE = new Set(["starting", "running"]);

/** Open the read-only log terminal for a runner in a detached popup window. */
export function openRunnerLogWindow(runnerId: string, label?: string): void {
  const url = `${location.origin}/?logs=${encodeURIComponent(runnerId)}`;
  const name = `cm-logs-${runnerId}`;
  const features = "popup=yes,width=760,height=560,noopener=no";
  const win = window.open(url, name, features);
  // A blocked popup returns null — fall back to a normal tab so the click isn't lost.
  if (!win) window.open(url, name);
  else if (label) win.focus();
}

export function RunnerLogWindow() {
  const runnerId = useMemo(
    () => new URLSearchParams(location.search).get("logs") ?? "",
    [],
  );
  const runner = useRunners((s) => s.byId[runnerId]);
  const conn = useConnection((s) => s.state);

  // Title reflects the app so the OS window/taskbar entry is identifiable.
  useEffect(() => {
    document.title = runner ? `logs · ${runner.subAppId}` : "runner logs";
  }, [runner]);

  const status = runner?.status;
  const active = status ? ACTIVE.has(status) : false;

  return (
    <div className="flex h-screen flex-col bg-inset text-primary">
      {/* header */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <Terminal className="size-4 shrink-0 text-accent-hi" />
        <span className="truncate text-sm font-medium">
          {runner?.subAppId ?? "runner"}
        </span>
        <span className="flex items-center gap-1.5 text-2xs text-faint">
          <StatusDot
            tone={
              active ? "working" : status === "crashed" ? "danger" : "muted"
            }
            pulse={active}
            size={5}
          />
          {status ?? "unknown"}
          {runner?.pid && <span className="cm-mono">· pid {runner.pid}</span>}
        </span>
        {conn !== "open" && (
          <span className="text-2xs text-warn">· {conn}</span>
        )}
        {runner?.url && (
          <a
            href={runner.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto flex items-center gap-1 text-2xs text-accent-hi hover:underline [&_svg]:size-3"
          >
            <ExternalLink />
            <span className="cm-mono !text-2xs">{runner.url}</span>
          </a>
        )}
      </div>

      <RunnerTranscript
        runnerId={runnerId}
        active={active}
        className="min-h-0 flex-1"
        textSize="text-xs"
      />
    </div>
  );
}
