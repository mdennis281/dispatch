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
import { useEffect, useMemo, useRef, useState } from "react";
import { Circle, Terminal, ExternalLink } from "lucide-react";
import { api } from "../../lib/api.js";
import { useRunners, type RunnerLogLine } from "../../stores/runners.js";
import { useConnection } from "../../stores/index.js";
import { StatusDot } from "../ui/StatusDot.js";
import { clock } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";

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
  const liveLogs = useRunners((s) => s.logs[runnerId]);
  const conn = useConnection((s) => s.state);

  // One-shot backfill of history (the fresh WS only carries lines from now on).
  const [backfill, setBackfill] = useState<RunnerLogLine[]>([]);
  const [backfillMaxTs, setBackfillMaxTs] = useState(0);
  useEffect(() => {
    if (!runnerId) return;
    let live = true;
    api.runners
      .logs(runnerId)
      .then((lines) => {
        if (!live) return;
        const norm = lines.map((l) => ({
          stream: l.stream === "stderr" ? "stderr" : "stdout",
          line: l.line,
          ts: l.ts,
        })) as RunnerLogLine[];
        setBackfill(norm);
        setBackfillMaxTs(norm.length ? norm[norm.length - 1]!.ts : 0);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [runnerId]);

  // Backfill (history) followed by only the live lines newer than it, so the
  // handoff between the REST snapshot and the WS stream doesn't duplicate.
  const lines = useMemo(() => {
    const tail = (liveLogs ?? []).filter((l) => l.ts > backfillMaxTs);
    return [...backfill, ...tail];
  }, [backfill, liveLogs, backfillMaxTs]);

  // Title reflects the app so the OS window/taskbar entry is identifiable.
  useEffect(() => {
    document.title = runner ? `logs · ${runner.subAppId}` : "runner logs";
  }, [runner]);

  // Follow the tail.
  const bodyRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  useEffect(() => {
    const el = bodyRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const status = runner?.status;
  const active = status ? ACTIVE.has(status) : false;

  return (
    <div className="flex h-screen flex-col bg-inset text-primary">
      {/* header */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <Terminal className="size-4 shrink-0 text-accent-hi" />
        <span className="truncate text-[12px] font-medium">
          {runner?.subAppId ?? "runner"}
        </span>
        <span className="flex items-center gap-1.5 text-[10.5px] text-faint">
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
          <span className="text-[10.5px] text-warn">· {conn}</span>
        )}
        {runner?.url && (
          <a
            href={runner.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto flex items-center gap-1 text-[10.5px] text-accent-hi hover:underline [&_svg]:size-3"
          >
            <ExternalLink />
            <span className="cm-mono !text-[10px]">{runner.url}</span>
          </a>
        )}
      </div>

      {/* body */}
      <div
        ref={bodyRef}
        onScroll={onScroll}
        className="cm-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2"
      >
        {lines.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[11px] text-faint">
            <Circle className="mr-1.5 size-2 animate-pulse" />
            waiting for output…
          </div>
        ) : (
          lines.map((l, i) => (
            <div
              key={i}
              className="flex gap-2 py-px cm-mono !text-[11px] leading-relaxed"
            >
              <span className="shrink-0 text-faint">{clock(l.ts)}</span>
              <span
                className={cn(
                  "min-w-0 flex-1 whitespace-pre-wrap break-all",
                  l.stream === "stderr" ? "text-warn" : "text-secondary",
                )}
              >
                {l.line}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
