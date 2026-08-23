import { memo } from "react";
import { Bot } from "lucide-react";
import type { UserMessageRow } from "@dispatch/shared";
import { RowShell } from "./RowShell.js";
import { Chip } from "../../ui/Chip.js";
import { Button } from "../../ui/Button.js";
import { MediaGroup } from "./MediaGroup.js";
import { ComposedParts } from "./ComposedParts.js";
import { actions } from "../../../lib/actions.js";
import { useHasCheckpoint } from "../../../stores/checkpoints.js";
import { selectChat } from "../../../stores/navigation.js";

/**
 * A user turn: avatar initial, text, attached image thumbnails, effort chip.
 *
 * A turn the APP composed (a launched task's briefing, or a plain message that
 * carried injected memory context) arrives with `parts` — an authorship
 * breakdown. Those render instead of the flat text, so the app's words are
 * quoted rather than passed off as typed; see ComposedParts. Rows written before
 * that existed have no `parts` and render exactly as they always did.
 *
 * A turn ANOTHER CHAT sent (`chat_send` / `chat_ask`) arrives with
 * `origin: "peer"`. It has to be a `user` row — that is the only input channel a
 * session has — so this is the one place the human can ever find out an agent
 * said it and they did not. That makes the attribution here load-bearing rather
 * than decorative: `chat_send` deliberately has NO consent prompt, and this row
 * is what was traded for the prompt. Absent `origin` still means human, which is
 * every row written before peer messaging existed.
 */
export const UserRow = memo(function UserRow({
  chatId,
  row,
}: {
  chatId: string;
  row: UserMessageRow;
}) {
  const canRollback = useHasCheckpoint(chatId, row.id);
  const composed = row.parts && row.parts.length > 0 ? row.parts : null;
  // Keyed on `origin`, not on `peer`: the sender object is optional on the
  // schema, and a row that says "peer" with no sender must still not be dressed
  // up as something the human typed.
  const fromPeer = row.origin === "peer";
  const peer = row.peer;
  return (
    <RowShell
      tint="user"
      align="right"
      who={fromPeer ? (peer?.title ?? "Another chat") : "You"}
      ts={row.ts}
      rollback={canRollback}
      onRollback={() => actions.rollback(chatId, row.id)}
      meta={
        <>
          {fromPeer &&
            (peer?.chatId ? (
              <Button
                variant="subtle"
                size="sm"
                className="gap-1 px-1.5 text-2xs"
                title={`Sent by another chat, not by you. Open ${peer.title ?? peer.chatId}.`}
                onClick={() => selectChat(peer.chatId)}
                leftIcon={<Bot />}
              >
                from another chat
              </Button>
            ) : (
              <Chip tone="agent" icon={<Bot />}>
                from another chat
              </Chip>
            ))}
          {/* Says what this row IS, not what is happening right now.
              Transcripts are append-only and nothing rewrites `peer.askId` when
              the ask resolves, so a live claim here ("awaiting reply") would go
              on insisting somebody is blocked long after they answered — the
              exact species of lie this row exists to prevent. That a message was
              sent as a question stays true forever, so that is what it says.
              `info` rather than `accent` for the same reason: accent is reserved
              for live-and-yours, and this is settled metadata. */}
          {peer?.askId && (
            <Chip tone="info" title="Sent as a question via chat_ask, not a plain message.">
              question
            </Chip>
          )}
          {row.steering && <Chip tone="accent">steering</Chip>}
          {composed?.some((p) => p.kind === "brief") && <Chip tone="muted">composed</Chip>}
          {row.effort && <Chip tone="muted">{row.effort}</Chip>}
        </>
      }
      gutter={
        fromPeer ? (
          // NOT the human's initial. That avatar is the single strongest "you
          // typed this" signal in the row, and it is exactly the lie a peer
          // message would otherwise tell.
          <span className="flex size-6 items-center justify-center rounded-md bg-accent-2-ghost text-accent-2-hi ring-1 ring-accent-2-line [&_svg]:size-3.5">
            <Bot />
          </span>
        ) : (
          <span className="flex size-6 items-center justify-center rounded-md bg-bubble text-2xs font-semibold text-primary ring-1 ring-bubble-line">
            M
          </span>
        )
      }
    >
      {composed ? (
        <ComposedParts chatId={chatId} parts={composed} harness={row.harness} />
      ) : (
        row.text && (
          <div className="inline-block max-w-full rounded-2xl rounded-tr-sm border border-bubble-line bg-bubble px-3 py-1.5 text-left align-top text-base leading-[1.6] text-primary whitespace-pre-wrap">
            {row.text}
          </div>
        )
      )}
      {row.images && row.images.length > 0 && (
        <MediaGroup chatId={chatId} assets={row.images} className="mt-2 justify-end" />
      )}
    </RowShell>
  );
});
