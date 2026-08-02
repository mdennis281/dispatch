import { useEffect, useState } from "react";
import { PauseCircle, PlayCircle, X, CalendarClock } from "lucide-react";
import type { ResultRow, ResumePlan } from "@cm/shared";
import { RowShell } from "./RowShell.js";
import { Button } from "../../ui/Button.js";
import { Chip } from "../../ui/Chip.js";
import { Spinner } from "../../ui/Spinner.js";
import { cn } from "../../../lib/cn.js";
import { untilShort } from "../../../lib/format.js";
import { actions } from "../../../lib/actions.js";
import { useChats } from "../../../stores/chats.js";

/** A wall clock in the reset's own zone — "4:50pm", the way the notice said it. */
function atClock(plan: ResumePlan): string {
  const d = new Date(plan.at);
  const text = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  // Only worth naming a day when it isn't today.
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? text
    : `${text} ${d.toLocaleDateString(undefined, { weekday: "short" })}`;
}

/** Re-render on a slow tick so the countdown stays honest without churn. */
function useMinuteTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export interface LimitPausedCardProps {
  row: ResultRow;
  /** The limit sentence, already matched by the caller. */
  reason: string;
}

/**
 * What a usage limit looks like now: a PAUSE, not a failure.
 *
 * The raw row said "You've hit your session limit · resets 4:50pm" in red and
 * left you with nothing to do. The chat now schedules itself to continue when
 * the window reopens (see server/services/resume-scheduler.ts), so this card
 * leads with when that happens and offers the one decision that matters —
 * cancel it and take the chat back.
 *
 * The plan lives on the chat record, so this reads live state rather than the
 * frozen row: cancel from any tab and every tab re-renders.
 */
export function LimitPausedCard({ row, reason }: LimitPausedCardProps) {
  const plan = useChats((s) => s.byId[row.chatId]?.resume);
  const [busy, setBusy] = useState(false);
  const pending = !!plan && !plan.cancelledAt && !plan.firedAt;
  const now = useMinuteTick(pending);

  const cancel = async () => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      await actions.cancelResume(row.chatId);
    } finally {
      setBusy(false);
    }
  };

  // No plan on the chat (an older transcript, or the server couldn't read a
  // reset time): still reframe the sentence, just without a schedule.
  const headline = pending
    ? `Continuing at ${atClock(plan)}`
    : plan?.firedAt
      ? "Continued automatically"
      : plan?.cancelledAt
        ? "Auto-resume cancelled"
        : "Paused by a usage limit";

  return (
    <RowShell
      gutter={
        <span
          className={cn(
            "flex size-6 items-center justify-center rounded-md ring-1 [&_svg]:size-3.5",
            pending ? "bg-warn-ghost text-warn ring-warn/30" : "bg-panel-2 text-muted ring-line",
          )}
        >
          {plan?.firedAt ? <PlayCircle /> : <PauseCircle />}
        </span>
      }
    >
      <div
        className={cn(
          "overflow-hidden rounded-md border",
          pending ? "border-warn/25 bg-warn-ghost/15" : "border-line bg-panel-2/50",
        )}
      >
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <span className="text-[12.5px] font-medium text-primary">{headline}</span>
          {pending && (
            <Chip tone="warn" icon={<CalendarClock />}>
              in {untilShort(plan.at, now)}
            </Chip>
          )}
          {pending && (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={busy ? <Spinner size={12} /> : <X />}
              className="ml-auto"
              disabled={busy}
              onClick={cancel}
            >
              {busy ? "Cancelling…" : "Cancel"}
            </Button>
          )}
        </div>
        <div className="border-t border-line-soft px-3 py-1.5">
          <p className="text-[11px] text-muted">{reason}</p>
          {plan?.cancelledAt && (
            <p className="mt-0.5 text-[11px] text-faint">
              Send a message when you're ready — nothing will run on its own.
            </p>
          )}
        </div>
      </div>
    </RowShell>
  );
}
