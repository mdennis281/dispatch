/**
 * The mini chat — the mission manager conversation, and the human's only comms
 * path into a run.
 *
 * It is meant to BE a Dispatch chat with the rails a manager has no use for
 * omitted (no terminals, no ship/PR sidebar, no worktree controls), not a
 * lookalike: when this is built it should reuse the real transcript and
 * composer components, because a second implementation of a chat will drift
 * from the first within a month. This mock exists to fix the LAYOUT and the
 * authorship treatment, which are the two decisions that are expensive to
 * change later.
 *
 * The authorship treatment is the important one. A message Dispatch composed
 * renders as a labelled brief block, never as prose in the human's voice —
 * the same rule the transcript already follows elsewhere.
 */
import { ArrowUp, OctagonX, Paperclip, Target } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Button, Chip } from "../../components/ui/index.js";
import { RunStatusPill } from "./chrome.js";
import type { ManagerTurn, RunStatus } from "./types.js";

export function MiniChat({
  turns,
  status,
  onStopAll,
}: {
  turns: ManagerTurn[];
  status: RunStatus;
  onStopAll?: () => void;
}) {
  return (
    <aside className="flex w-[23rem] shrink-0 flex-col border-l border-line bg-panel">
      {/* header — the mission identity, repeated so the panel stands alone */}
      <div className="flex h-11 shrink-0 items-center gap-2 px-2.5 cm-hairline-b">
        <span className="flex size-5 items-center justify-center rounded-[4px] bg-accent-2 text-accent-2-fg">
          <Target className="size-3" />
        </span>
        <span className="text-xs font-semibold text-primary">Mission manager</span>
        <RunStatusPill status={status} />
        <div className="flex-1" />
        <Button
          variant="danger"
          size="sm"
          onClick={onStopAll}
          title="Interrupt every actor in this mission"
          leftIcon={<OctagonX />}
        >
          Stop all
        </Button>
      </div>

      {/* transcript */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-2.5">
        {turns.map((t) => (
          <Turn key={t.id} turn={t} />
        ))}
      </div>

      {/* composer — the real one, minus the rails a manager never uses */}
      <div className="shrink-0 p-2.5 cm-hairline-t">
        <div className="rounded-lg border border-line bg-panel-2 p-2">
          <div className="text-2xs text-faint">
            Ask the manager, or answer its escalation…
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <Paperclip className="size-3.5 text-faint" />
            <div className="flex-1" />
            <Chip tone="neutral">high</Chip>
            <span className="flex size-5 items-center justify-center rounded-md bg-accent text-accent-fg">
              <ArrowUp className="size-3" />
            </span>
          </div>
        </div>
        <p className="mt-1.5 text-2xs leading-relaxed text-faint">
          No terminals rail, no ship rail, no worktree controls — a manager writes no code. The
          transcript, composer, permission prompts and attention badges are the real ones.
        </p>
      </div>
    </aside>
  );
}

function Turn({ turn }: { turn: ManagerTurn }) {
  const human = turn.author === "human";
  return (
    <div className={cn("flex flex-col gap-1", human && "items-end")}>
      <div className="flex items-center gap-1.5 px-0.5">
        <span className="text-2xs leading-4 text-faint">
          {human ? "you" : "manager"} · {new Date(turn.ts).toLocaleTimeString()}
        </span>
      </div>
      {turn.brief && (
        <div className="w-full rounded-md border border-accent-2-line bg-accent-2-ghost px-2 py-1">
          <div className="text-2xs font-semibold leading-4 text-accent-2-hi">
            {turn.brief.label}
          </div>
          <div className="text-2xs text-secondary">{turn.brief.text}</div>
        </div>
      )}
      <div
        className={cn(
          "max-w-[95%] rounded-lg px-2.5 py-1.5 text-2xs leading-relaxed",
          human
            ? "border border-bubble-line bg-bubble text-primary"
            : "border border-line bg-panel-2 text-secondary",
        )}
      >
        {turn.text}
      </div>
    </div>
  );
}
