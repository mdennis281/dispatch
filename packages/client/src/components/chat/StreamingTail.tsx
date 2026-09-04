import { useLayoutEffect } from "react";
import { WorkingRow, StreamingRow } from "./rows/MiscRows.js";
import { useStreamRows } from "../../stores/messages.js";

export interface StreamingTailProps {
  chatId: string;
  /** The turn is actually running (a blocked/finished turn has no live stream). */
  running: boolean;
  /** Human "what is the agent doing" label for the fallback working row. */
  workingLabel?: string;
  /** Called after each growth commit so the view can follow the stream. */
  onGrow?: () => void;
}

/**
 * The LIVE tail of a transcript: in-flight assistant text plus the "working…"
 * indicator. Split out from {@link MessageList} on purpose.
 *
 * `message-chunk` fires per token, so whatever subscribes to the streaming
 * buffers re-renders per token. Keeping that subscription here — behind a
 * per-chat, content-compared selector — means a token re-renders this one small
 * row, not the hundreds of rows above it (each of which would otherwise re-parse
 * markdown and re-run syntax highlighting). Before this split, a background chat
 * streaming was enough to lock up the foreground transcript.
 */
export function StreamingTail({ chatId, running, workingLabel, onGrow }: StreamingTailProps) {
  const streamRows = useStreamRows(chatId, running);

  // Follow the stream: the parent owns the scroll container and decides whether
  // the reader is pinned to the bottom, so it just gets told "content grew".
  const chars = streamRows.reduce((n, r) => n + r.text.length + r.thinking.length, 0);
  useLayoutEffect(() => {
    onGrow?.();
  }, [chars, running, onGrow]);

  // A live streaming bubble supersedes the plain "working…" indicator.
  const showWorking = running && streamRows.length === 0;

  return (
    <>
      {streamRows.map((s, i) => (
        <StreamingRow
          key={`stream-${s.messageId}`}
          chatId={chatId}
          text={s.text}
          thinking={s.thinking}
          // Live rows are consecutive by construction, so all but the first
          // continue the one above — matching how they'll read once settled.
          continued={i > 0}
        />
      ))}
      {showWorking && <WorkingRow label={workingLabel} />}
    </>
  );
}
