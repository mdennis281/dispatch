import { useEffect, useMemo, useRef, useState } from "react";
import { Circle } from "lucide-react";
import type { RunnerLogLine } from "@dispatch/shared";
import { api } from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { clock } from "../../lib/format.js";
import { useRunners } from "../../stores/runners.js";

const EMPTY_LOGS: RunnerLogLine[] = [];

/**
 * Merge a REST snapshot with the websocket tail without dropping two identical
 * lines emitted in the same millisecond. A timestamp watermark did exactly
 * that; treating the snapshot as a multiset lets us remove only real overlap.
 */
export function mergeRunnerLogs(
  snapshot: RunnerLogLine[],
  live: RunnerLogLine[],
): RunnerLogLine[] {
  const overlap = new Map<string, number>();
  for (const line of snapshot) {
    const key = JSON.stringify([line.ts, line.stream, line.line]);
    overlap.set(key, (overlap.get(key) ?? 0) + 1);
  }
  const tail: RunnerLogLine[] = [];
  for (const line of live) {
    const key = JSON.stringify([line.ts, line.stream, line.line]);
    const count = overlap.get(key) ?? 0;
    if (count > 0) {
      overlap.set(key, count - 1);
    } else {
      tail.push(line);
    }
  }
  return [...snapshot, ...tail];
}

export function RunnerTranscript({
  runnerId,
  active = false,
  className,
  textSize = "text-2xs",
}: {
  runnerId: string;
  active?: boolean;
  className?: string;
  textSize?: "text-2xs" | "text-xs";
}) {
  const live = useRunners((s) => s.logs[runnerId] ?? EMPTY_LOGS);
  const [snapshot, setSnapshot] = useState<RunnerLogLine[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let current = true;
    setSnapshot([]);
    setLoading(true);
    api.runners
      .logs(runnerId)
      .then((lines) => {
        if (current) setSnapshot(lines);
      })
      .catch(() => {})
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  // Re-fetch when a run settles: the websocket store is intentionally bounded,
  // while the durable snapshot contains the complete retained transcript.
  }, [runnerId, active]);

  const lines = useMemo(() => mergeRunnerLogs(snapshot, live), [snapshot, live]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  useEffect(() => {
    const el = bodyRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div
      ref={bodyRef}
      onScroll={() => {
        const el = bodyRef.current;
        if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className={cn("cm-scroll overflow-y-auto bg-inset px-3 py-2", className)}
    >
      {lines.length === 0 ? (
        <div className="flex h-full min-h-16 items-center justify-center text-xs text-faint">
          {active && <Circle className="mr-1.5 size-2 animate-pulse" />}
          {loading ? "loading output…" : active ? "waiting for output…" : "no output captured"}
        </div>
      ) : (
        lines.map((entry, index) => (
          <div
            key={`${entry.ts}:${entry.stream}:${index}`}
            className={cn("flex gap-2 py-px cm-mono leading-relaxed", textSize)}
          >
            <span className="shrink-0 text-faint">{clock(entry.ts)}</span>
            <span
              className={cn(
                "min-w-0 flex-1 whitespace-pre-wrap break-all",
                entry.stream === "stderr" ? "text-warn" : "text-secondary",
              )}
            >
              {entry.line}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
