import { Pause, Play } from "lucide-react";
import { MenuItem } from "../ui/Popover.js";
import { useScheduler } from "../../stores/scheduler.js";

/**
 * "Pause chat" / "Resume chat" for a chat's ⋯ menu — the header's and the
 * sidebar row's share this so the two can never disagree about the state.
 *
 * Pause interrupts the chat's turn if one is open and holds whatever it is
 * sent next until resumed; resume briefs it on what happened. Same mechanics
 * as the global and per-project pauses, scoped to one chat.
 */
export function PauseChatMenuItem({ chatId, onDone }: { chatId: string; onDone: () => void }) {
  const known = useScheduler((s) => s.snapshot !== null);
  const paused = useScheduler((s) => s.snapshot?.chatPauses?.[chatId] !== undefined);
  const busy = useScheduler((s) => s.scopedBusy[`chat:${chatId}`] === true);
  // No snapshot means a server without the scheduler routes: an item that can
  // only fail is worse than none.
  if (!known) return null;
  return (
    <MenuItem
      icon={paused ? <Play className="text-accent-hi" /> : <Pause />}
      disabled={busy}
      title={
        paused
          ? "Resume — let this chat run again, telling it about any turn the pause cut off"
          : "Pause — interrupt this chat's turn and hold anything sent to it until you resume"
      }
      onClick={() => {
        const s = useScheduler.getState();
        void (paused ? s.resumeChat(chatId) : s.pauseChat(chatId));
        onDone();
      }}
    >
      {paused ? "Resume chat" : "Pause chat"}
    </MenuItem>
  );
}
