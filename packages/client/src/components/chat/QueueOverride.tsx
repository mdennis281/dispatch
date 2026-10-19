import { useState } from "react";
import { Play } from "lucide-react";
import { QUEUE_TIER_LABELS } from "@dispatch/shared";
import { Button } from "../ui/Button.js";
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
        {/* Colour on the children, not the button: `cn` is plain clsx, so a
            className colour would race `link`'s own `text-muted` on emit order.
            `-my-1` keeps the 24px button from growing the 48px header. */}
        <Button
          variant="link"
          size="sm"
          disabled={pending}
          className="-my-1"
          leftIcon={<Play className="text-accent-hi" />}
          onClick={() => {
            setPending(true);
            void runNow(chatId).finally(() => setPending(false));
          }}
        >
          <span className="text-accent-hi">Run now</span>
        </Button>
      </Tooltip>
    </>
  );
}
