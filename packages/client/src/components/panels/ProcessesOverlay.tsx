/**
 * ProcessesOverlay — the project-wide "what is still running, and who started
 * it" roster, GROUPED BY CHAT.
 *
 * The per-project `ProcessesPanel` answers "what is on my ports"; it lives two
 * collapses deep inside Run → Apps and is organized by port, which is the wrong
 * axis for the question people actually arrive with: *this chat has been going
 * for four hours — what did it leave running?* Since ProcessService started
 * attributing listeners to the chat shell they descend from, that question has
 * an answer, and this is where it's shown.
 *
 * A group is one chat (plus two unowned buckets: app runners, and orphans that
 * nothing accounts for). Within a group we list the chat's LIVE SHELLS as well
 * as their listeners, because a background command that hasn't bound a port yet
 * is still a process that chat is running — showing only ports would report
 * "nothing here" for a build that has been churning for ten minutes.
 *
 * Killing: every row kills by pid through the same tree-kill endpoint the panel
 * uses; a shell row kills the shell (which reaps its descendants). Group-level
 * and global "kill everything" live here rather than in the chat menu so the
 * click always happens in front of the list of what it will kill.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  MessagesSquare,
  RefreshCw,
  Server,
  Skull,
  SquareTerminal,
  X,
} from "lucide-react";
import type { TerminalInfo } from "@dispatch/shared";
import { Modal, InlineError } from "../sidebar/Modal.js";
import { Button } from "../ui/Button.js";
import { Chip } from "../ui/Chip.js";
import { IconButton } from "../ui/IconButton.js";
import { Spinner } from "../ui/Spinner.js";
import { api, type ProjectProcess } from "../../lib/api.js";
import { useProcesses, useProjectProcesses } from "../../stores/processes.js";
import { useChats } from "../../stores/chats.js";
import { useTerminals } from "../../stores/terminals.js";
import { useProjects } from "../../stores/projects.js";
import { useOverlay } from "../../stores/view.js";
import { cn } from "../../lib/cn.js";

/* --------------------------------------------------------------- grouping */

/** A shell with no listener of its own still belongs in its chat's group. */
export interface ShellRow {
  kind: "shell";
  terminal: TerminalInfo;
}
export interface PortRow {
  kind: "port";
  process: ProjectProcess;
}
export type ProcessRow = ShellRow | PortRow;

export interface ProcessGroup {
  /** `chat:<id>`, `runners`, or `orphans` — stable react key + sort bucket. */
  id: string;
  title: string;
  /** Set for a chat group, so the group can offer "open this chat". */
  chatId?: string;
  rows: ProcessRow[];
  /** Every pid this group would kill (shell pids + listener pids, deduped). */
  pids: number[];
}

/** Sort: chats first (most rows first), then runners, then orphans last. */
const BUCKET_ORDER = (id: string): number =>
  id === "orphans" ? 2 : id === "runners" ? 1 : 0;

/**
 * Fold listeners + live shells into per-chat groups.
 *
 * Exported and pure so the grouping rules are testable without mounting the
 * modal — the ordering and the "a shell with no port still counts" rule are the
 * parts most likely to regress.
 */
export function groupProcesses(
  processes: ProjectProcess[],
  terminals: TerminalInfo[],
  chatTitle: (chatId: string) => string | undefined,
): ProcessGroup[] {
  const groups = new Map<string, ProcessGroup>();
  const ensure = (id: string, title: string, chatId?: string): ProcessGroup => {
    let g = groups.get(id);
    if (!g) {
      g = { id, title, chatId, rows: [], pids: [] };
      groups.set(id, g);
    }
    return g;
  };

  // Shells first, so a chat's group is ordered shell-then-its-ports and a chat
  // that is running a shell with no listener still appears at all.
  for (const t of terminals) {
    if (t.status !== "live") continue;
    const g = ensure(`chat:${t.chatId}`, chatTitle(t.chatId) ?? "Untitled chat", t.chatId);
    g.rows.push({ kind: "shell", terminal: t });
    if (typeof t.pid === "number") g.pids.push(t.pid);
  }

  for (const p of processes) {
    const g =
      p.source === "terminal" && p.chatId
        ? ensure(`chat:${p.chatId}`, p.chatTitle ?? chatTitle(p.chatId) ?? "Untitled chat", p.chatId)
        : p.source === "runner"
          ? ensure("runners", "App runners")
          : ensure("orphans", "Unaccounted for");
    g.rows.push({ kind: "port", process: p });
    g.pids.push(p.pid);
  }

  for (const g of groups.values()) g.pids = [...new Set(g.pids)];

  return [...groups.values()].sort(
    (a, b) =>
      BUCKET_ORDER(a.id) - BUCKET_ORDER(b.id) ||
      b.rows.length - a.rows.length ||
      a.title.localeCompare(b.title),
  );
}

/* ------------------------------------------------------------------ view */

export function ProcessesOverlay() {
  const { open, close } = useOverlay("processes");
  const projectId = useProjects((s) => s.activeProjectId);
  const [busy, setBusy] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);

  const rows = useProjectProcesses(projectId ?? "");
  const loading = useProcesses((s) => (projectId ? (s.scanning[projectId] ?? false) : false));
  const scanError = useProcesses((s) => (projectId ? (s.errors[projectId] ?? null) : null));

  const terminalsById = useTerminals((s) => s.byId);
  const chatsById = useChats((s) => s.byId);

  const refresh = useCallback(() => {
    if (projectId) void useProcesses.getState().scan(projectId);
  }, [projectId]);

  // Opening IS the "show me now" gesture — the scan is on demand, never polled.
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const groups = useMemo(() => {
    if (!projectId) return [];
    // Terminals are held globally (one store, every chat), so scope them to the
    // project this overlay is about before grouping.
    const mine = Object.values(terminalsById).filter(
      (t) => chatsById[t.chatId]?.projectId === projectId,
    );
    return groupProcesses(rows, mine, (id) => chatsById[id]?.title);
  }, [projectId, rows, terminalsById, chatsById]);

  const allPids = useMemo(
    () => [...new Set(groups.flatMap((g) => g.pids))],
    [groups],
  );

  const kill = useCallback(
    async (pids: number[]) => {
      if (!projectId || pids.length === 0) return;
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
        refresh();
      }
    },
    [projectId, refresh],
  );

  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <Modal
      open={open}
      onClose={close}
      width={620}
      icon={<Activity />}
      title="Running processes"
      description="Every shell and listening port this project has open, grouped by the chat that started it."
      footer={
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="subtle" leftIcon={<RefreshCw />} onClick={refresh}>
            Rescan
          </Button>
          {loading && <Spinner />}
          <Button
            size="sm"
            variant="danger"
            leftIcon={<Skull />}
            className="ml-auto"
            disabled={busy || allPids.length === 0}
            onClick={() => void kill(allPids)}
          >
            Kill everything ({allPids.length})
          </Button>
        </div>
      }
    >
      <InlineError message={killError ?? scanError} />

      {total === 0 ? (
        <div className="px-2 py-8 text-center text-xs text-faint">
          {loading ? "Scanning…" : "Nothing running for this project."}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((g) => (
            <div key={g.id} className="rounded-md border border-line bg-panel-2/40">
              <div className="flex items-center gap-1.5 px-3 py-2">
                {g.chatId ? (
                  <MessagesSquare className="size-3.5 text-muted" />
                ) : g.id === "runners" ? (
                  <Server className="size-3.5 text-muted" />
                ) : (
                  <AlertTriangle className="size-3.5 text-warn" />
                )}
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-primary">
                  {g.title}
                </span>
                <Chip tone={g.id === "orphans" ? "warn" : "muted"} mono>
                  {g.rows.length}
                </Chip>
                <Button
                  size="sm"
                  variant="subtle"
                  leftIcon={<Skull />}
                  disabled={busy || g.pids.length === 0}
                  onClick={() => void kill(g.pids)}
                >
                  Kill
                </Button>
              </div>
              <div className="border-t border-line-soft p-1">
                {g.rows.map((row) =>
                  row.kind === "shell" ? (
                    <Row
                      key={`t:${row.terminal.id}`}
                      icon={<SquareTerminal />}
                      label={row.terminal.name}
                      sub={
                        row.terminal.background
                          ? `serving · ${row.terminal.background.command}`
                          : row.terminal.busy
                            ? "running a command"
                            : "idle shell"
                      }
                      pid={row.terminal.pid}
                      tone={row.terminal.background ? "success" : "muted"}
                      chip="shell"
                      busy={busy}
                      onKill={kill}
                    />
                  ) : (
                    <Row
                      key={`p:${row.process.port}:${row.process.pid}`}
                      icon={<Activity />}
                      label={`:${row.process.port}`}
                      sub={[row.process.name, row.process.subAppId, row.process.terminalName]
                        .filter(Boolean)
                        .join(" · ")}
                      pid={row.process.pid}
                      tone={row.process.tracked ? "success" : "warn"}
                      chip={row.process.source === "orphan" ? "orphan" : "port"}
                      busy={busy}
                      onKill={kill}
                    />
                  ),
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function Row({
  icon,
  label,
  sub,
  pid,
  tone,
  chip,
  busy,
  onKill,
}: {
  icon: React.ReactNode;
  label: string;
  sub?: string;
  pid?: number;
  tone: "success" | "warn" | "muted";
  chip: string;
  busy: boolean;
  onKill: (pids: number[]) => void | Promise<void>;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
      <span
        className={cn(
          "flex size-5 items-center justify-center rounded text-muted [&_svg]:size-3",
          tone === "warn" && "text-warn",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate cm-mono !text-xs text-secondary">{label}</span>
        {sub && <span className="block truncate text-2xs text-faint">{sub}</span>}
      </span>
      {pid !== undefined && (
        <span className="cm-mono !text-2xs text-faint">pid {pid}</span>
      )}
      <Chip tone={tone === "warn" ? "warn" : "muted"}>{chip}</Chip>
      <IconButton
        size="sm"
        tip={pid === undefined ? "No pid to kill" : `Kill pid ${pid} (tree)`}
        disabled={busy || pid === undefined}
        onClick={() => pid !== undefined && void onKill([pid])}
      >
        <X />
      </IconButton>
    </div>
  );
}
