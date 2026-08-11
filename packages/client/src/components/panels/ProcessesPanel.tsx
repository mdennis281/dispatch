import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  RefreshCw,
  Skull,
  X,
  ChevronRight,
  ChevronDown,
  AlertTriangle,
} from "lucide-react";
import { api } from "../../lib/api.js";
import { useProcesses, useProjectProcesses } from "../../stores/processes.js";
import { Button } from "../ui/Button.js";
import { Chip } from "../ui/Chip.js";
import { IconButton } from "../ui/IconButton.js";
import { SectionLabel } from "../ui/Panel.js";
import { cn } from "../../lib/cn.js";

/**
 * OS-level process inspector for a project: what's ACTUALLY listening on its
 * sub-apps' ports, cross-referenced with Dispatch's live runners AND with the
 * shells its chats own — a dev server an agent started on a port nobody declared
 * shows up here labelled with the chat that started it, which is the only place
 * it is visible at all. Untracked listeners (orphans a server restart or a
 * half-killed tree left behind) are flagged so you can reap them — individually
 * or in bulk — even though the runner records lost track of them. This is the
 * escape hatch for "port already in use" when the UI shows nothing running.
 */
export function ProcessesPanel({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);

  // Rows live in the store, not here: held locally they only existed once this
  // section had been expanded, which made the collapsed "N orphans" chip below
  // dead code — the one hint that the panel had something to say could only
  // appear after you'd already looked. See stores/processes.ts.
  const rows = useProjectProcesses(projectId);
  const loading = useProcesses((s) => s.scanning[projectId] ?? false);
  const scanError = useProcesses((s) => s.errors[projectId] ?? null);
  const error = killError ?? scanError;

  const refresh = useCallback(
    () => useProcesses.getState().scan(projectId),
    [projectId],
  );

  // Expanding is an explicit "show me now", so re-scan even though the store may
  // already hold rows — an on-demand OS scan, never a poll.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const kill = useCallback(
    async (pids: number[]) => {
      if (pids.length === 0) return;
      setBusy(true);
      setKillError(null);
      try {
        const results = await api.processes.kill(projectId, pids);
        const failed = results.filter((r) => !r.ok);
        if (failed.length) {
          setKillError(
            `Failed to kill ${failed.length} process(es): ${failed
              .map((f) => `${f.pid} (${f.error ?? "unknown"})`)
              .join(", ")}`,
          );
        }
      } catch (err) {
        setKillError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [projectId, refresh],
  );

  const orphans = rows.filter((r) => !r.tracked);
  const Caret = open ? ChevronDown : ChevronRight;

  return (
    <div className="rounded-md border border-line bg-panel-2/40">
      <div className="flex items-center gap-1.5 px-3 py-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <Caret className="size-3.5 text-faint" />
          <Activity className="size-3.5 text-muted" />
          <SectionLabel className="px-0">Ports &amp; processes</SectionLabel>
          {open && rows.length > 0 && (
            <Chip tone="muted" mono>
              {rows.length}
            </Chip>
          )}
          {orphans.length > 0 && (
            <Chip tone="warn" mono>
              {orphans.length} orphan{orphans.length === 1 ? "" : "s"}
            </Chip>
          )}
        </button>
        {open && (
          <IconButton size="sm" tip="Rescan ports" onClick={() => void refresh()}>
            <RefreshCw className={cn(loading && "animate-spin")} />
          </IconButton>
        )}
      </div>

      {open && (
        <div className="border-t border-line-soft">
          {error && (
            <div className="flex items-start gap-1.5 px-3 py-2 text-xs text-danger [&_svg]:size-3 [&_svg]:mt-px">
              <AlertTriangle />
              <span className="min-w-0 flex-1 break-words">{error}</span>
            </div>
          )}

          {rows.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-faint">
              {loading ? "Scanning ports…" : "Nothing listening on this project's ports."}
            </div>
          ) : (
            <div className="p-1">
              {rows.map((p) => (
                <div
                  key={`${p.port}:${p.pid}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5"
                >
                  <Chip tone={p.tracked ? "success" : "warn"} mono>
                    :{p.port}
                  </Chip>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-secondary">
                      {p.name ?? "unknown"}
                      {p.subAppId && (
                        <span className="text-faint"> · {p.subAppId}</span>
                      )}
                      {/* A chat's shell started this one: say WHOSE, because that
                          is the actionable half — you stop it by stopping the
                          chat's terminal, not by hunting the pid. */}
                      {p.source === "terminal" && (
                        <span className="text-faint">
                          {" "}
                          · {p.chatTitle ?? "chat"}
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-1.5 cm-mono !text-2xs text-faint">
                      pid {p.pid}
                      {p.branch && <span className="truncate">· {p.branch}</span>}
                      {p.terminalName && (
                        <span className="truncate">· {p.terminalName}</span>
                      )}
                    </span>
                  </span>
                  <Chip tone={p.source === "orphan" ? "warn" : "muted"}>
                    {p.source === "runner"
                      ? "tracked"
                      : p.source === "terminal"
                        ? "chat"
                        : "orphan"}
                  </Chip>
                  <IconButton
                    size="sm"
                    tip={`Kill pid ${p.pid} (tree)`}
                    disabled={busy}
                    onClick={() => void kill([p.pid])}
                  >
                    <X />
                  </IconButton>
                </div>
              ))}
            </div>
          )}

          {rows.length > 0 && (
            <div className="flex items-center gap-1.5 border-t border-line-soft px-3 py-2">
              {orphans.length > 0 && (
                <Button
                  size="sm"
                  variant="subtle"
                  leftIcon={<Skull />}
                  disabled={busy}
                  onClick={() => void kill(orphans.map((o) => o.pid))}
                >
                  Kill orphans ({orphans.length})
                </Button>
              )}
              <Button
                size="sm"
                variant="danger"
                leftIcon={<Skull />}
                disabled={busy}
                className="ml-auto"
                onClick={() => void kill(rows.map((r) => r.pid))}
              >
                Kill all ({rows.length})
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
