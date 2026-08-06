import { useEffect, useRef } from "react";
import { TerminalSquare, FolderClosed } from "lucide-react";
import type { Chat, TerminalInfo } from "@dispatch/shared";
import { useTerminals, type TerminalLine } from "../../stores/terminals.js";
import { api } from "../../lib/api.js";
import { StatusDot } from "../ui/StatusDot.js";
import { Chip } from "../ui/Chip.js";
import { cn } from "../../lib/cn.js";
import { midTruncate } from "../../lib/format.js";

const EMPTY_LINES: TerminalLine[] = [];

/** Fetch a terminal's retained scrollback once (reconnect hydration). */
function useScrollbackFetch(id: string, hasLines: boolean): void {
  const fetched = useRef(false);
  useEffect(() => {
    if (fetched.current || hasLines) return;
    fetched.current = true;
    void api.terminals
      .output(id)
      .then((lines) => {
        if (lines.length) useTerminals.getState().setLines(id, lines);
      })
      .catch(() => {
        /* best-effort — live events still fill the view */
      });
  }, [id, hasLines]);
}

function TerminalCard({ terminal }: { terminal: TerminalInfo }) {
  const lines = useTerminals((s) => s.lines[terminal.id] ?? EMPTY_LINES);
  useScrollbackFetch(terminal.id, lines.length > 0);

  const live = terminal.status === "live";

  // Follow the tail as output streams in.
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="overflow-hidden rounded-md border border-line bg-panel-2/50">
      <div className="flex items-center gap-2 px-3 py-2">
        <span
          className={cn(
            "flex size-6 items-center justify-center rounded-md ring-1 [&_svg]:size-3.5",
            live ? "bg-accent-ghost text-accent-hi ring-accent-line" : "bg-panel-2 text-muted ring-line",
          )}
        >
          <TerminalSquare />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium text-primary">{terminal.name}</span>
          <span className="flex items-center gap-1.5 text-[10.5px] text-faint">
            <StatusDot
              tone={terminal.busy ? "working" : live ? "success" : "muted"}
              pulse={terminal.busy}
              size={5}
            />
            {terminal.busy ? "running…" : live ? "ready" : "exited"}
          </span>
        </span>
        {terminal.lastExitCode !== undefined && terminal.lastExitCode !== null && (
          <Chip tone={terminal.lastExitCode === 0 ? "success" : "danger"} mono>
            exit {terminal.lastExitCode}
          </Chip>
        )}
      </div>

      <div className="flex items-center gap-1.5 border-t border-line-soft px-3 py-1.5 text-[10.5px] text-faint">
        <FolderClosed className="size-3 shrink-0" />
        <span className="cm-mono !text-[10.5px] truncate" title={terminal.cwd}>
          {midTruncate(terminal.cwd, 44)}
        </span>
      </div>

      {lines.length > 0 && (
        <div ref={logRef} className="cm-scroll max-h-64 overflow-y-auto border-t border-line-soft bg-inset px-3 py-2">
          {lines.map((l, i) => (
            <div key={i} className="py-px cm-mono !text-[10.5px] leading-relaxed">
              {l.stream === "command" ? (
                <span className="flex gap-1.5">
                  <span className="shrink-0 select-none text-accent-hi">$</span>
                  <span className="min-w-0 flex-1 break-all text-primary">{l.chunk}</span>
                </span>
              ) : (
                <span
                  className={cn(
                    "block break-all",
                    l.stream === "stderr" ? "text-warn" : "text-secondary",
                  )}
                >
                  {l.chunk}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TerminalsPanel({ chat }: { chat: Chat }) {
  const byId = useTerminals((s) => s.byId);
  const order = useTerminals((s) => s.order);
  const mine = order.map((id) => byId[id]!).filter((t) => t && t.chatId === chat.id);

  if (mine.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <TerminalSquare className="mx-auto mb-2 size-5 text-faint" />
        <p className="text-[12px] text-muted">No terminals yet.</p>
        <p className="mt-0.5 text-[11px] text-faint">
          The agent opens persistent shells here (cwd + env survive across commands).
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 p-3">
      {mine.map((t) => (
        <TerminalCard key={t.id} terminal={t} />
      ))}
    </div>
  );
}
