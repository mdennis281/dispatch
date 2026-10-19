import { useState } from "react";
import { Play } from "lucide-react";
import { QUEUE_TIER_LABELS } from "@dispatch/shared";
import { Tooltip } from "../ui/Tooltip.js";
import { useScheduler } from "../../stores/scheduler.js";

/**
 * "Run now" beside a queued chat's status: start it past the cap and ahead of
 * everything ranked above it.
 *
 * Keyed off the scheduler snapshot, not `chat.status`. A chat parked to RESUME
 * (its answer held for a slot) is still `waiting`, never `queued` — and it is
 * the one the human most often wants to push through, having just answered it.
 *
 * Hidden while paused: the server refuses then (the pause promises nothing
 * starts), and a button that can only fail is worse than none.
 */
export function QueueOverride({ chatId }: { chatId: string }) {
  const snapshot = useScheduler((s) => s.snapshot);
  const runNow = useScheduler((s) => s.runNow);
  const [pending, setPending] = useState(false);
  if (!snapshot || snapshot.paused) return null;
  const index = snapshot.queued.findIndex((q) => q.chatId === chatId);
  if (index < 0) return null;
  const entry = snapshot.queued[index]!;
  const tip =
    `#${index + 1} of ${snapshot.queued.length} in the queue — ${QUEUE_TIER_LABELS[entry.tier]}. ` +
    `Start it now, over the ${snapshot.cap}-slot cap.`;
  return (
    <>
      <span className="text-faint">·</span>
      <Tooltip label={tip}>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setPending(true);
            void runNow(chatId).finally(() => setPending(false));
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1 font-medium text-accent-hi hover:bg-accent-ghost disabled:opacity-50 [&_svg]:size-3"
        >
          <Play />
          Run now
        </button>
      </Tooltip>
    </>
  );
}
