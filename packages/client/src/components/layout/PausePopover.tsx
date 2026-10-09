import { useEffect, useState } from "react";
import { Pause, Play, Skull, ArrowRight } from "lucide-react";
import type { SchedulerSnapshot } from "@dispatch/shared";
import { Popover } from "../ui/Popover.js";
import { Button } from "../ui/Button.js";
import { RowButton } from "../ui/RowButton.js";
import { Chip } from "../ui/Chip.js";
import { StatusDot } from "../ui/StatusDot.js";
import { relTime } from "../../lib/format.js";
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
      className="group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-active"
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
 * The cap as a row of slots: filled for a chat doing work, hollow-outlined for
 * one with a turn open but blocked (it has given its slot back), and the queue
 * trailing behind. The question it answers at a glance is "is the app busy, or
 * just waiting" — which a single running count conflated.
 */
function SlotMeter({ snapshot }: { snapshot: SchedulerSnapshot }) {
  const occupied = snapshot.running.filter((r) => r.occupied).length;
  const blocked = snapshot.running.length - occupied;
  const slots = Math.max(snapshot.cap, occupied);
  return (
    <div className="flex items-center gap-1" aria-hidden>
      {Array.from({ length: slots }, (_, i) => (
        <span
          key={i}
          className={cn(
            "h-2 flex-1 rounded-full",
            snapshot.paused
              ? i < occupied
                ? "bg-warn/70"
                : "bg-line"
              : i < occupied
                ? "bg-accent cm-anim-pulse"
                : "bg-line",
          )}
        />
      ))}
      {blocked > 0 && (
        <span className="ml-1 cm-mono !text-2xs text-faint">+{blocked} blocked</span>
      )}
    </div>
  );
}

/**
 * The global pause: a header control with a live panel of what is running and
 * what is queued, Pause / Resume, and — once paused — a way to kill every
 * chat's processes.
 *
 * Pause interrupts; it cannot freeze. Neither runtime can suspend a turn, so
 * the copy says "interrupt" plainly rather than promising a resume-in-place it
 * cannot deliver. What resume DOES do is tell each interrupted chat what
 * happened, which is why the panel names how many will be told.
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

  if (!snapshot) return null;

  const working = snapshot.running.filter((r) => r.occupied).length;
  const busyIds = new Set([...snapshot.running, ...snapshot.queued].map((c) => c.chatId));
  const interruptedIdle = (paused?.interrupted ?? []).filter((id) => !busyIds.has(id));
  // Only chats this instance knows. The server's process scan is machine-wide,
  // so the tally also carries the other instance's chats — which the kill
  // (correctly) will not touch, and a count including them would overpromise.
  const mine = Object.entries(processes).filter(([id]) => id in chatsById);
  const procTotal = mine.reduce((n, [, t]) => n + t.session + t.shells, 0);
  const procChats = mine.length;

  return (
    <Popover
      align="end"
      width={360}
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
          {paused ? (
            <>
              <Pause />
              {!compact && <span>Paused</span>}
            </>
          ) : (
            <>
              <Pause />
              {working + snapshot.queued.length > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 cm-mono !text-2xs leading-none text-accent-fg">
                  {working}
                  {snapshot.queued.length > 0 ? `+${snapshot.queued.length}` : ""}
                </span>
              )}
            </>
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
            <div className="flex items-center justify-between gap-2 px-3 py-2.5 cm-hairline-b">
              <span className="text-sm font-semibold text-primary">Agents</span>
              <div className="flex items-center gap-1.5">
                <Chip tone={paused ? "warn" : working > 0 ? "accent" : "muted"}>
                  {working}/{snapshot.cap} slots
                </Chip>
                <Chip tone={snapshot.queued.length > 0 ? "info" : "muted"}>
                  {snapshot.queued.length} queued
                </Chip>
              </div>
            </div>

            <div className="px-3 pt-2.5">
              <SlotMeter snapshot={snapshot} />
            </div>

            {paused && (
              <div className="mx-3 mt-2.5 rounded-md border border-warn/30 bg-warn-ghost px-2.5 py-2 text-xs text-warn">
                <div className="font-medium">
                  Paused {relTime(paused.since)} · {paused.interrupted.length}{" "}
                  {paused.interrupted.length === 1 ? "turn" : "turns"} interrupted
                </div>
                <div className="mt-0.5 text-secondary">
                  Nothing starts until you resume. On resume, interrupted chats are told what
                  happened and that their shells need restarting.
                  {paused.killedAt ? ` Processes killed ${relTime(paused.killedAt)}.` : ""}
                </div>
              </div>
            )}

            <div className="max-h-[340px] cm-scroll overflow-y-auto p-1.5">
              <div className="px-2 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wide text-faint">
                Running · {snapshot.running.length}
              </div>
              {snapshot.running.length === 0 ? (
                <div className="px-2 pb-2 text-xs text-muted">
                  {paused ? "Nothing running — everything is held." : "Nothing running."}
                </div>
              ) : (
                snapshot.running.map((r) => (
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
                ))
              )}

              {/* The chats the pause cut off. An interrupted turn settles to idle,
                  so without this they would vanish from the panel — and they are
                  exactly the ones resume is going to message. */}
              {paused && interruptedIdle.length > 0 && (
                <>
                  <div className="px-2 pb-1 pt-2.5 text-2xs font-semibold uppercase tracking-wide text-faint">
                    Interrupted · {interruptedIdle.length}
                  </div>
                  {interruptedIdle.map((id) => (
                    <ChatRow
                      key={id}
                      chatId={id}
                      onGo={() => go(id)}
                      lead={<StatusDot tone="warn" hollow />}
                      detail={
                        paused.killed?.includes(id)
                          ? "stopped · processes killed · notified on resume"
                          : "stopped · notified on resume"
                      }
                    />
                  ))}
                </>
              )}

              <div className="px-2 pb-1 pt-2.5 text-2xs font-semibold uppercase tracking-wide text-faint">
                Queued · {snapshot.queued.length}
              </div>
              {snapshot.queued.length === 0 ? (
                <div className="px-2 pb-2 text-xs text-muted">Nothing waiting for a slot.</div>
              ) : (
                snapshot.queued.map((q, i) => (
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
                ))
              )}
            </div>

            <div className="flex flex-col gap-2 px-3 py-2.5 cm-hairline-t">
              {!paused ? (
                <>
                  <Button
                    variant="danger"
                    size="md"
                    className="w-full justify-center"
                    leftIcon={<Pause className="size-3.5" />}
                    disabled={busy !== null}
                    onClick={() => void useScheduler.getState().pause()}
                  >
                    {busy === "pause" ? "Pausing…" : "Pause all chats"}
                  </Button>
                  <p className="text-2xs text-faint">
                    Interrupts {snapshot.running.length}{" "}
                    {snapshot.running.length === 1 ? "turn" : "turns"} and holds every new one — human
                    messages, peers, PR reviews and usage-limit resumes alike.
                  </p>
                </>
              ) : (
                <>
                  <Button
                    variant="primary"
                    size="md"
                    className="w-full justify-center"
                    leftIcon={<Play className="size-3.5" />}
                    disabled={busy !== null}
                    onClick={() => {
                      setConfirmKill(false);
                      void useScheduler.getState().resume();
                    }}
                  >
                    {busy === "resume"
                      ? "Resuming…"
                      : `Resume${paused.interrupted.length ? ` · notify ${paused.interrupted.length}` : ""}`}
                  </Button>
                  {confirmKill ? (
                    <div className="flex items-center gap-1.5">
                      <span className="flex-1 text-xs text-danger">
                        Kill {procTotal} {procTotal === 1 ? "process" : "processes"} across {procChats}{" "}
                        {procChats === 1 ? "chat" : "chats"}? Dev servers and shells die too.
                      </span>
                      <Button size="sm" variant="link" onClick={() => setConfirmKill(false)}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busy !== null}
                        onClick={() =>
                          void useScheduler
                            .getState()
                            .kill()
                            .then(() => {
                              setConfirmKill(false);
                              void refreshProcesses();
                            })
                        }
                      >
                        {busy === "kill" ? "Killing…" : "Kill"}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="danger"
                      size="sm"
                      className="w-full justify-center"
                      leftIcon={<Skull className="size-3.5" />}
                      disabled={busy !== null || procTotal === 0}
                      onClick={() => setConfirmKill(true)}
                    >
                      {procTotal === 0
                        ? "No chat processes left"
                        : `Kill chat processes · ${procTotal}`}
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        );
      }}
    </Popover>
  );
}
