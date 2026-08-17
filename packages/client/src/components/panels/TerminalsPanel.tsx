import { useEffect, useRef, useState } from "react";
import {
  TerminalSquare,
  FolderClosed,
  Plus,
  X,
  CornerDownLeft,
  Activity,
  ChevronRight,
} from "lucide-react";
import type { Chat, TerminalInfo } from "@dispatch/shared";
import {
  isActiveTerminal,
  isLiveChatTerminal,
  useTerminals,
  nextShellName,
  type TerminalLine,
} from "../../stores/terminals.js";
import { api } from "../../lib/api.js";
import { StatusDot } from "../ui/StatusDot.js";
import { Chip } from "../ui/Chip.js";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { cn } from "../../lib/cn.js";
import { midTruncate } from "../../lib/format.js";
import { useProcesses, useTerminalPorts } from "../../stores/processes.js";

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

/**
 * The command line for a shell. Kept dumb on purpose: the request is
 * fire-and-forget because the output, the busy flag and the exit code all
 * arrive over the WS the same way an AGENT-run command's do — so a human
 * command and an agent command narrate through one path, and a `pnpm build`
 * that runs for four minutes doesn't need this promise to stay pending.
 */
function CommandInput({ terminal }: { terminal: TerminalInfo }) {
  const [command, setCommand] = useState("");
  // Whether the next command is a thing that FINISHES or a thing that runs until
  // stopped. Not inferred from the command text: "is this a server?" isn't
  // decidable from a command line (`vitest --watch` is, `vitest` isn't), and
  // guessing wrong either wedges the shell or detaches something you wanted to
  // wait for. So it's an explicit toggle, sticky per shell.
  const [background, setBackground] = useState(false);
  const busy = Boolean(terminal.busy);

  const submit = () => {
    const c = command.trim();
    if (!c || busy) return;
    setCommand("");
    void api.terminals.run(terminal.chatId, terminal.name, c, background).catch(() => {
      /* the failure shows up as stderr in the stream; nothing to add here */
    });
  };

  return (
    <div className="flex items-center gap-1.5 border-t border-line-soft px-2 py-1.5">
      <span className="select-none pl-1 cm-mono !text-xs text-accent-hi">$</span>
      <input
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        spellCheck={false}
        disabled={busy}
        placeholder={
          terminal.background
            ? "hosting a background command — use another shell"
            : busy
              ? "running…"
              : "Run a command…"
        }
        aria-label={`Run a command in ${terminal.name}`}
        className="h-6 min-w-0 flex-1 rounded-md bg-transparent px-1 cm-mono !text-xs text-primary outline-none placeholder:text-faint disabled:opacity-60"
      />
      <Button
        size="sm"
        variant={background ? "toggle" : "ghost"}
        title={
          background
            ? "Background: returns immediately, output keeps streaming here"
            : "Run in the background (dev server, watcher)"
        }
        className="!h-5 !px-1.5 cm-mono !text-2xs"
        onClick={() => setBackground((v) => !v)}
      >
        bg
      </Button>
      <IconButton size="sm" tip="Run" disabled={busy || !command.trim()} onClick={submit}>
        <CornerDownLeft />
      </IconButton>
    </div>
  );
}

/** What the shell is doing, in the two words the header and the collapsed row share. */
function statusText(terminal: TerminalInfo): string {
  // A shell held by a dev server is busy FOREVER by design. Saying "running…"
  // for six hours reads as wedged; naming the command it is hosting is the
  // difference between a bug and a fact.
  if (terminal.background) return `serving · ${terminal.background.command}`;
  if (terminal.busy) return "running…";
  return terminal.status === "live" ? "ready" : "exited";
}

function TerminalCard({
  terminal,
  projectId,
}: {
  terminal: TerminalInfo;
  projectId: string;
}) {
  const lines = useTerminals((s) => s.lines[terminal.id] ?? EMPTY_LINES);
  useScrollbackFetch(terminal.id, lines.length > 0);

  const live = terminal.status === "live";
  const active = isActiveTerminal(terminal);
  const ports = useTerminalPorts(projectId, terminal.id);
  const killPort = async (pid: number) => {
    await api.processes.kill(projectId, [pid]).catch(() => []);
    void useProcesses.getState().scan(projectId);
  };

  // Open when the shell is DOING something; a one-line stub when it's an idle
  // prompt. A chat that ran four setup commands used to hand you four full
  // cards of finished output — a screen and a half of scrollback for work that
  // already succeeded, with the shell that's actually serving pushed below the
  // fold. The override lets you open a finished one to read what it said, and
  // is dropped whenever `active` flips so a shell that starts running comes
  // back on its own.
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => setOverride(null), [active]);
  const open = override ?? active;

  // Follow the tail as output streams in.
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, open]);

  const exitChip = terminal.lastExitCode !== undefined && terminal.lastExitCode !== null && (
    <Chip tone={terminal.lastExitCode === 0 ? "success" : "danger"} mono>
      exit {terminal.lastExitCode}
    </Chip>
  );

  const closeButton = (
    <IconButton
      size="sm"
      tip="Close shell"
      onClick={() => void api.terminals.kill(terminal.id).catch(() => {})}
    >
      <X />
    </IconButton>
  );

  if (!open) {
    return (
      <div className="flex items-center gap-1.5 rounded-md border border-line-soft bg-panel-2/30 pl-2 pr-1">
        <Button
          variant="ghost"
          aria-expanded={false}
          title={`${terminal.name} — ${statusText(terminal)}`}
          onClick={() => setOverride(true)}
          className="min-w-0 flex-1 !justify-start !px-1 !gap-1.5 text-left !text-muted [&_svg]:shrink-0"
        >
          <ChevronRight className="size-3 text-faint" />
          <TerminalSquare className="size-3 text-faint" />
          <span className="truncate">{terminal.name}</span>
          <StatusDot tone={live ? "success" : "muted"} size={4} />
          <span className="truncate text-2xs text-faint">{statusText(terminal)}</span>
        </Button>
        {/* A collapsed shell can still be holding a port — the one thing about
            it that isn't recoverable by expanding it later, because it's what
            makes the next launch fail. */}
        {ports.length > 0 && (
          <Chip tone="info" mono>
            :{ports[0]!.port}
            {ports.length > 1 && ` +${ports.length - 1}`}
          </Chip>
        )}
        {exitChip}
        {closeButton}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-line bg-panel-2/50">
      <div className="flex items-center gap-2 px-3 py-2">
        <Button
          variant="ghost"
          aria-expanded
          title="Collapse"
          onClick={() => setOverride(false)}
          // `text-left`: a <button> inherits the UA's centred text, and the name
          // and status inside this one are a block, not a label.
          className="min-w-0 flex-1 !h-auto !justify-start !px-0 !py-0 !gap-2 text-left hover:!bg-transparent"
        >
          <span
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-md ring-1 [&_svg]:size-3.5",
              live ? "bg-accent-ghost text-accent-hi ring-accent-line" : "bg-panel-2 text-muted ring-line",
            )}
          >
            <TerminalSquare />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-primary">{terminal.name}</span>
            <span className="flex items-center gap-1.5 text-2xs text-faint">
              <StatusDot
                tone={terminal.busy ? "working" : live ? "success" : "muted"}
                pulse={terminal.busy}
                size={5}
              />
              <span className="truncate">{statusText(terminal)}</span>
            </span>
          </span>
        </Button>
        {exitChip}
        {closeButton}
      </div>

      <div className="flex items-center gap-1.5 border-t border-line-soft px-3 py-1.5 text-2xs text-faint">
        <FolderClosed className="size-3 shrink-0" />
        <span className="cm-mono !text-2xs truncate" title={terminal.cwd}>
          {midTruncate(terminal.cwd, 44)}
        </span>
      </div>

      {/* What this shell is actually holding. A background dev server is
          invisible from the transcript and from the shell's own output once it
          settles — the port is the only durable evidence it's still up, and it
          is the thing you came here to kill. */}
      {ports.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line-soft px-3 py-1.5">
          <Activity className="size-3 shrink-0 text-muted" />
          {ports.map((p) => (
            <Button
              key={`${p.port}:${p.pid}`}
              size="sm"
              variant="ghost"
              title={`${p.name ?? "process"} · pid ${p.pid} — click to kill (tree)`}
              onClick={() => void killPort(p.pid)}
              className="group !h-5 !px-1.5 cm-mono !text-2xs !text-success hover:!text-danger"
            >
              <span className="group-hover:hidden">:{p.port}</span>
              <span className="hidden group-hover:inline">kill :{p.port}</span>
            </Button>
          ))}
        </div>
      )}

      {lines.length > 0 && (
        <div ref={logRef} className="cm-scroll max-h-64 overflow-y-auto border-t border-line-soft bg-inset px-3 py-2">
          {lines.map((l, i) => (
            <div key={i} className="py-px cm-mono !text-2xs leading-relaxed">
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

      {live && <CommandInput terminal={terminal} />}
    </div>
  );
}

export function TerminalsPanel({ chat }: { chat: Chat }) {
  const byId = useTerminals((s) => s.byId);
  const order = useTerminals((s) => s.order);
  const mine = order.map((id) => byId[id]!).filter((t) => t && t.chatId === chat.id);
  const live = mine.filter((t) => isLiveChatTerminal(t, chat.id));
  const [opening, setOpening] = useState(false);

  // Open a shell the way the agent's `terminal` tool does — same service, same
  // cwd rule. Until this button existed the ONLY door into this panel was
  // mcp__manager__terminal, so a human who had never watched an agent run one
  // saw an empty tab and no way to fill it.
  const openShell = () => {
    if (opening) return;
    setOpening(true);
    const name = nextShellName(mine.map((t) => t.name));
    // No local upsert: the server publishes `terminal-update` on spawn, which is
    // the same path an agent-opened shell arrives by. One source of truth.
    void api.terminals
      .create(chat.id, name)
      .catch(() => {})
      .finally(() => setOpening(false));
  };

  if (live.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <TerminalSquare className="mx-auto mb-2 size-5 text-faint" />
        <p className="text-sm text-muted">No terminals running.</p>
        <p className="mt-0.5 text-xs text-faint">
          Persistent shells — cwd and env survive across commands. The agent opens
          them with its <span className="cm-mono !text-2xs">terminal</span> tool;
          you can open one too.
        </p>
        <div className="mt-3 flex justify-center">
          <Button size="sm" variant="subtle" leftIcon={<Plus />} disabled={opening} onClick={openShell}>
            New shell
          </Button>
        </div>
      </div>
    );
  }

  return (
    // `gap-2`, not the old `space-y-2.5`: most rows in here are now one-line
    // stubs, and card spacing wider than the row itself reads as a gap in the
    // list rather than a list of small things.
    <div className="flex flex-col gap-2 p-3">
      {live.map((t) => (
        <TerminalCard key={t.id} terminal={t} projectId={chat.projectId} />
      ))}
      <div className="flex justify-center pt-0.5">
        <Button size="sm" variant="ghost" leftIcon={<Plus />} disabled={opening} onClick={openShell}>
          New shell
        </Button>
      </div>
    </div>
  );
}
