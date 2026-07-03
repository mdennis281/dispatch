import { useMemo } from "react";
import type { ChatMessage, ToolResultRow } from "@cm/shared";
import { UserRow } from "./rows/UserRow.js";
import { AssistantRow } from "./rows/AssistantRow.js";
import { ToolCallCard } from "./rows/ToolCallCard.js";
import { PermissionCard } from "./rows/PermissionCard.js";
import {
  WorkingRow,
  NoticeRowView,
  ResultRowView,
  SystemRowView,
  StreamingRow,
} from "./rows/MiscRows.js";
import { actions } from "../../lib/actions.js";

/** An in-flight assistant turn assembled from `message-chunk` deltas. */
export interface StreamRow {
  messageId: string;
  text: string;
  thinking: string;
}

export interface MessageListProps {
  chatId: string;
  messages: ChatMessage[];
  /** Live streaming buffers not yet finalized as a `chat-message` row. */
  streamRows?: StreamRow[];
  /** Show the live "working…" row after the last message. */
  working?: boolean;
  workingLabel?: string;
}

/** Renders a transcript: pairs tool_use↔tool_result, folds cards, streams live. */
export function MessageList({
  chatId,
  messages,
  streamRows = [],
  working,
  workingLabel,
}: MessageListProps) {
  const resultsByUse = useMemo(() => {
    const m = new Map<string, ToolResultRow>();
    for (const row of messages) {
      if (row.kind === "tool_result") m.set(row.toolUseId, row);
    }
    return m;
  }, [messages]);

  const decide = (requestId: string) => (decision: "allow" | "deny", remember?: boolean) => {
    actions.answerPermission(chatId, requestId, decision, { remember });
  };

  // A live streaming bubble supersedes the plain "working…" indicator.
  const liveStreams = streamRows.filter((s) => s.text || s.thinking);
  const showWorking = working && liveStreams.length === 0;

  return (
    <div className="flex flex-col divide-y divide-line-soft/70">
      {messages.map((row) => {
        switch (row.kind) {
          case "user":
            return <UserRow key={row.id} chatId={chatId} row={row} />;
          case "assistant":
            return <AssistantRow key={row.id} chatId={chatId} row={row} />;
          case "tool_use":
            return (
              <ToolCallCard
                key={row.id}
                use={row}
                result={resultsByUse.get(row.toolUseId)}
              />
            );
          case "tool_result":
            return null; // folded into its ToolCallCard
          case "permission":
            return <PermissionCard key={row.id} row={row} onDecide={decide(row.requestId)} />;
          case "result":
            return <ResultRowView key={row.id} row={row} />;
          case "system":
            return <SystemRowView key={row.id} row={row} />;
          case "notice":
            return <NoticeRowView key={row.id} row={row} />;
          default:
            return null;
        }
      })}
      {liveStreams.map((s) => (
        <StreamingRow key={`stream-${s.messageId}`} text={s.text} thinking={s.thinking} />
      ))}
      {showWorking && <WorkingRow label={workingLabel} />}
    </div>
  );
}
