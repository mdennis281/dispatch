import { useEffect, useState } from "react";
import { Pause, Play, Skull, ArrowRight, Check, ChevronRight } from "lucide-react";
import type { SchedulerSnapshot } from "@dispatch/shared";
import { Popover } from "../ui/Popover.js";
import { IconButton } from "../ui/IconButton.js";
import { RowButton } from "../ui/RowButton.js";
import { Chip } from "../ui/Chip.js";
import { Tooltip } from "../ui/Tooltip.js";
import { StatusDot } from "../ui/StatusDot.js";
import { cn } from "../../lib/cn.js";
import { useScheduler } from "../../stores/scheduler.js";
import { useChats } from "../../stores/chats.js";
import { useProjects } from "../../stores/projects.js";
import { useChatProcesses } from "../../stores/chatProcesses.js";
import { selectChat } from "../../stores/navigation.js";

type Running = SchedulerSnapshot["running"][number];

/** What a turn-live chat is doing, in the words the row shows. */
function runningLabel(r: Running, activityLabel: string | undefined): string {
  if (r.status === "awaiting-input") return "waiting on you";
  if (r.status === "waiting") return "waiting for permission";
  if (!r.occupied) return activityLabel ? `blocked — ${activityLabel}` : "blocked";
  return activityLabel ?? "working";
}

function ChatRow({
  chatId,
  lead,
  detail,
  onGo,
}: {
  chatId: string;
  lead: React.ReactNode;
  detail: string;
  onGo: () => void;
}) {
  const title = useChats((s) => s.byId[chatId]?.title || "Untitled chat");
  const projectId = useChats((s) => s.byId[chatId]?.projectId);
  const project = useProjects((s) => s.projects.find((p) => p.id === projectId)?.name);
  return (
    <RowButton
      onClick={onGo}
      className="group flex w-full items-center gap-2.5 rounded-md px-2 py-1 hover:bg-active"
    >
      <span className="flex w-4 shrink-0 justify-center">{lead}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-primary">{title}</span>
        <span className="block truncate text-xs text-muted">
          {project ? <span className="text-faint">{project} · </span> : null}
          {detail}
        </span>
      </span>
      <ArrowRight className="size-3.5 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
    </RowButton>
  );
}

/**
 * A collapsible list heading. Collapsed by default: the header row and slot
 * meter already answer "how busy is it", and the lists are for when you want
 * to know WHICH chats — a question you ask on purpose, not on every open.
 */
function Section({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const empty = count === 0;
  return (
    <div>
      <RowButton
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        disabled={empty}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-faint hover:bg-active hover:text-secondary disabled:pointer-events-none"
      >
        <ChevronRight
          className={cn("size-3 transition-transform", open && "rotate-90", empty && "opacity-0")}
        />
        <span className="flex-1">{label}</span>
        <span className="cm-mono">{count}</span>
      </RowButton>
      {open && !empty && <div className="pb-1">{children}</div>}
    </div>
  );
}

/**
 * The global pause: a header control with a live panel of what is running and
 * what is queued, Pause / Resume, and — once paused — a way to kill every
 * chat's processes.
 *
 * Pause interrupts; it cannot freeze. Neither runtime can suspend a turn, so
 * the tooltips say "interrupt" plainly rather than promising a resume-in-place
 * the runtimes cannot deliver. What resume DOES do is tell each interrupted chat
 * what happened, which is why its tooltip names how many will be told.
 */
export function PausePopover({ compact }: { compact?: boolean }) {
  const snapshot = useScheduler((s) => s.snapshot);
  const busy = useScheduler((s) => s.busy);
  const activity = useChats((s) => s.activity);
  const chatsById = useChats((s) => s.byId);
  const processes = useChatProcesses((s) => s.byChat);
  const refreshProcesses = useChatProcesses((s) => s.refresh);
  const [confirmKill, setConfirmKill] = useState(false);
  const paused = snapshot?.paused ?? null;

  // The process count only matters once paused (that is when Kill is offered),
  // and the store's own poll is 30s — too slow to watch it drop to zero.
  useEffect(() => {
    if (!paused) return;
    void refreshProcesses();
    const t = setInterval(() => void refreshProcesses(), 3_000);
    return () => clearInterval(t);
  }, [paused, refreshProcesses]);

  // An armed Kill disarms itself. A confirm that stays live indefinitely is a
  // single click waiting for whoever next touches the panel.
  useEffect(() => {
    if (!confirmKill) return;
    const t = setTimeout(() => setConfirmKill(false), 5_000);
    return () => clearTimeout(t);
  }, [confirmKill]);

  if (!snapshot) return null;

  const working = snapshot.running.filter((r) => r.occupied).length;
  const blocked = snapshot.running.length - working;
  const busyIds = new Set([...snapshot.running, ...snapshot.queued].map((c) => c.chatId));
  const interruptedIdle = (paused?.interrupted ?? []).filter((id) => !busyIds.has(id));
  // Only chats this instance knows. The server's process scan is machine-wide,
  // so the tally also carries the other instance's chats — which the kill
  // (correctly) will not touch, and a count including them would overpromise.
  const mine = Object.entries(processes).filter(([id]) => id in chatsById);
  const procTotal = mine.reduce((n, [, t]) => n + t.session + t.shells, 0);
  const procChats = mine.length;
  const killOff = !paused || procTotal === 0 || busy !== null;
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  return (
    <Popover
      align="end"
      width={320}
      className="p-0"
      trigger={({ open, toggle }) => (
        <button
          onClick={toggle}
          aria-expanded={open}
          aria-label={
            paused
              ? "All chats paused"
              : `Agents — ${working} running, ${snapshot.queued.length} queued`
          }
          className={cn(
            "inline-flex items-center border transition-colors",
            paused
              ? "h-6 gap-1.5 rounded-md border-warn/30 bg-warn-ghost px-2 text-sm font-medium text-warn hover:bg-warn/15 [&_svg]:size-3.5"
              : "relative size-8 justify-center rounded-sm border-transparent text-secondary hover:bg-active hover:text-primary [&_svg]:size-4",
            open && !paused && "bg-active text-primary",
          )}
        >
          <Pause />
          {paused ? (
            !compact && <span>Paused</span>
          ) : (
            working + snapshot.queued.length > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 cm-mono !text-2xs leading-none text-accent-fg">
                {working}
                {snapshot.queued.length > 0 ? `+${snapshot.queued.length}` : ""}
              </span>
            )
          )}
        </button>
      )}
    >
      {(close) => {
        const go = (chatId: string) => {
          selectChat(chatId);
          close();
        };
        return (
          <div className="w-full">
            {/* One row: what the scheduler is doing, then every action as an
                icon. The tooltips carry the explanation, so the body is just
                the lists. */}
            <div className="flex items-center gap-1 py-1.5 pl-3 pr-1.5 cm-hairline-b">
              <span className="text-sm font-semibold text-primary">Agents</span>
              {/* The chip replaced a bar-per-slot meter that needed explaining:
                  "what are the two yellow bars?" is a meter failing at its one
                  job. A number with a tooltip says the same thing outright. */}
              <Tooltip
                label={
                  paused
                    ? "Paused — nothing starts until you resume"
                    : `${working} of ${snapshot.cap} active slots in use` +
                      (blocked > 0 ? ` · ${blocked} more blocked (waiting, not using a slot)` : "")
                }
              >
                <Chip tone={paused ? "warn" : working > 0 ? "accent" : "muted"} className="ml-1">
                  {paused ? "paused" : `${working}/${snapshot.cap} slots`}
                </Chip>
              </Tooltip>
              <span className="flex-1" />
              {paused ? (
                <IconButton
                  size="md"
                  tip={
                    busy === "resume"
                      ? "Resuming…"
                      : paused.interrupted.length
                        ? `Resume — tell ${plural(paused.interrupted.length, "interrupted chat")} what happened and to restart their shells, then run the queue`
                        : "Resume — run the queue"
                  }
                  disabled={busy !== null}
                  onClick={() => {
                    setConfirmKill(false);
                    void useScheduler.getState().resume();
                  }}
                >
                  {/* Colour on the glyph, not the button: IconButton's own
                      `text-secondary` and a className colour would both survive
                      clsx, and stylesheet order picks the winner. */}
                  <Play className="text-accent-hi" />
                </IconButton>
              ) : (
                <IconButton
                  size="md"
                  tip={
                    busy === "pause"
                      ? "Pausing…"
                      : `Pause all — interrupt ${plural(snapshot.running.length, "turn")} and hold every new one`
                  }
                  disabled={busy !== null}
                  onClick={() => void useScheduler.getState().pause()}
                >
                  <Pause className="text-danger" />
                </IconButton>
              )}
              <IconButton
                size="md"
                tip={
                  !paused
                    ? "Kill chat processes — pause first"
                    : busy === "kill"
                      ? "Killing…"
                      : procTotal === 0
                        ? "No chat processes left"
                        : confirmKill
                          ? `Click again to kill ${plural(procTotal, "process", "processes")} across ${plural(procChats, "chat")} — dev servers and shells too`
                          : `Kill chat processes (${procTotal})`
                }
                // Not `disabled`: a disabled button takes no pointer events, so
                // its tooltip — the only thing saying WHY it is off — never shows.
                aria-disabled={killOff}
                className={cn(
                  (!paused || procTotal === 0) && "opacity-40",
                  confirmKill && "bg-danger-ghost",
                )}
                onClick={() => {
                  if (killOff) return;
                  if (!confirmKill) {
                    setConfirmKill(true);
                    return;
                  }
                  void useScheduler
                    .getState()
                    .kill()
                    .then(() => {
                      setConfirmKill(false);
                      void refreshProcesses();
                    });
                }}
              >
                {confirmKill ? <Check className="text-danger" /> : <Skull className="text-danger" />}
              </IconButton>
            </div>

            <div className="max-h-[340px] cm-scroll overflow-y-auto px-1.5 py-1">
              <Section label="Running" count={snapshot.running.length}>
                {snapshot.running.map((r) => (
                  <ChatRow
                    key={r.chatId}
                    chatId={r.chatId}
                    onGo={() => go(r.chatId)}
                    lead={
                      <StatusDot
                        tone={r.occupied ? "working" : r.status === "running" ? "muted" : "warn"}
                        pulse={r.occupied}
                        hollow={!r.occupied}
                      />
                    }
                    detail={runningLabel(r, activity[r.chatId]?.label)}
                  />
                ))}
              </Section>
              {/* The chats the pause cut off. An interrupted turn settles to idle,
                  so without this they would vanish from the panel — and they are
                  exactly the ones resume is going to message. */}
              {paused && (
                <Section label="Interrupted" count={interruptedIdle.length}>
                  {interruptedIdle.map((id) => (
                    <ChatRow
                      key={id}
                      chatId={id}
                      onGo={() => go(id)}
                      lead={<StatusDot tone="warn" hollow />}
                      detail={
                        paused.killed?.includes(id)
                          ? "processes killed · notified on resume"
                          : "notified on resume"
                      }
                    />
                  ))}
                </Section>
              )}
              <Section label="Queued" count={snapshot.queued.length}>
                {snapshot.queued.map((q, i) => (
                  <ChatRow
                    key={q.chatId}
                    chatId={q.chatId}
                    onGo={() => go(q.chatId)}
                    lead={<span className="cm-mono !text-2xs text-faint">{i + 1}</span>}
                    detail={
                      paused
                        ? paused.interrupted.includes(q.chatId)
                          ? "interrupted — resumes first"
                          : "held by pause"
                        : "waiting for a slot"
                    }
                  />
                ))}
              </Section>
            </div>
          </div>
        );
      }}
    </Popover>
  );
}
