import { memo } from "react";
import { AlertTriangle, PencilLine, RotateCw } from "lucide-react";
import { RowShell } from "./RowShell.js";
import { Chip } from "../../ui/Chip.js";
import { Button } from "../../ui/Button.js";
import { Spinner } from "../../ui/Spinner.js";
import { MediaGroup } from "./MediaGroup.js";
import { SPEECH_BUBBLE } from "./ComposedParts.js";
import { cn } from "../../../lib/cn.js";
import { actions } from "../../../lib/actions.js";
import {
  useChatPendingSends,
  usePendingSends,
  type PendingSend,
} from "../../../stores/pendingSends.js";

/**
 * The composer's sends the server hasn't answered for yet, drawn where their
 * real rows will land — directly under the transcript, in send order.
 *
 * Same shell, gutter and bubble as a human `UserRow`, so when the real row
 * replaces one nothing moves; only the dashed border and the dimming go. The
 * dashes are the whole signal and deliberately NOT the accent: accent already
 * means "live and yours" on the composer's queue chips, and a message the
 * server has not even received is a different, earlier state than one the
 * agent is holding.
 */
export const PendingSendRows = memo(function PendingSendRows({ chatId }: { chatId: string }) {
  const sends = useChatPendingSends(chatId);
  if (!sends.length) return null;
  return (
    <>
      {sends.map((send) => (
        <PendingSendRow key={send.clientId} chatId={chatId} send={send} />
      ))}
    </>
  );
});

function PendingSendRow({ chatId, send }: { chatId: string; send: PendingSend }) {
  const failed = send.state === "failed";
  return (
    <div data-testid="pending-send" data-state={send.state}>
      <RowShell
        tint="user"
        align="right"
        who="You"
        ts={send.ts}
        meta={
          // `-my-1`: the chip is taller than the header's text line, and the
          // real row that replaces this one has no chip — without it the row
          // nudges up 3px at the exact moment it is supposed to not move.
          <span className="-my-1 inline-flex">
          {failed ? (
            <Chip tone="danger" icon={<AlertTriangle />} title={send.error}>
              not sent
            </Chip>
          ) : (
            <Chip tone="muted" icon={<Spinner size={10} />} title="Waiting for the server to receive this.">
              sending
            </Chip>
          )}
          </span>
        }
        gutter={
          <span
            className={cn(
              "flex size-6 items-center justify-center rounded-md bg-bubble text-2xs font-semibold text-primary ring-1 ring-bubble-line",
              "opacity-60",
            )}
          >
            M
          </span>
        }
      >
        {send.text && (
          <div
            className={cn(
              SPEECH_BUBBLE,
              "border-dashed",
              failed
                ? "border-danger-line bg-danger-ghost text-primary"
                : "bg-transparent text-muted",
            )}
          >
            {send.text}
          </div>
        )}
        {send.images && send.images.length > 0 && (
          <MediaGroup
            chatId={chatId}
            assets={send.images}
            className={cn("mt-2 justify-end", !failed && "opacity-60")}
          />
        )}
        {failed && (
          <div className="mt-1.5 flex items-center justify-end gap-1.5">
            {send.error && (
              <span className="mr-auto min-w-0 truncate text-left text-2xs text-danger" title={send.error}>
                {send.error}
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              leftIcon={<PencilLine />}
              title="Take this message back into the composer to edit or discard it."
              onClick={() => usePendingSends.getState().restoreToComposer(chatId, send.clientId)}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="danger"
              leftIcon={<RotateCw />}
              onClick={() => actions.retrySend(chatId, send.clientId)}
            >
              Retry
            </Button>
          </div>
        )}
      </RowShell>
    </div>
  );
}
