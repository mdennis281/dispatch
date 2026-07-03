import { useMemo, type ReactNode } from "react";
import type { ChatMessage, ToolResultRow } from "@cm/shared";
import { UserRow } from "./rows/UserRow.js";
import { AssistantRow } from "./rows/AssistantRow.js";
import { ToolCallCard } from "./rows/ToolCallCard.js";
import { SubagentCard } from "./rows/SubagentCard.js";
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

  // Subagent nesting: rows a subagent produced tag themselves with the spawning
  // Task tool_use id (`parentToolUseId`). Group those under their parent so each
  // subagent renders as ONE nested sub-transcript (not flat-interleaved), and the
  // top level shows only genuine roots. Parent-missing rows fall back to root so a
  // stray subagent row never vanishes. Grouping by immediate parent means a
  // subagent that itself spawns a subagent nests recursively.
  const { roots, childrenByParent } = useMemo(() => {
    const toolUseIds = new Set<string>();
    for (const r of messages) if (r.kind === "tool_use") toolUseIds.add(r.toolUseId);
    const childrenByParent = new Map<string, ChatMessage[]>();
    const roots: ChatMessage[] = [];
    for (const r of messages) {
      const pid = "parentToolUseId" in r ? r.parentToolUseId : undefined;
      if (pid && toolUseIds.has(pid)) {
        const arr = childrenByParent.get(pid);
        if (arr) arr.push(r);
        else childrenByParent.set(pid, [r]);
      } else {
        roots.push(r);
      }
    }
    return { roots, childrenByParent };
  }, [messages]);

  const decide = (requestId: string) => (decision: "allow" | "deny", remember?: boolean) => {
    actions.answerPermission(chatId, requestId, decision, { remember });
  };

  const renderRow = (row: ChatMessage): ReactNode => {
    switch (row.kind) {
      case "user":
        return <UserRow key={row.id} chatId={chatId} row={row} />;
      case "assistant":
        return <AssistantRow key={row.id} chatId={chatId} row={row} />;
      case "tool_use": {
        const children = childrenByParent.get(row.toolUseId);
        if (children && children.length > 0) {
          return (
            <SubagentCard
              key={row.id}
              use={row}
              result={resultsByUse.get(row.toolUseId)}
              childRows={children}
              renderRows={renderRows}
            />
          );
        }
        return (
          <ToolCallCard key={row.id} use={row} result={resultsByUse.get(row.toolUseId)} />
        );
      }
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
  };

  const renderRows = (rows: ChatMessage[]): ReactNode => rows.map(renderRow);

  // A live streaming bubble supersedes the plain "working…" indicator.
  const liveStreams = streamRows.filter((s) => s.text || s.thinking);
  const showWorking = working && liveStreams.length === 0;

  return (
    <div className="flex flex-col divide-y divide-line-soft/70">
      {renderRows(roots)}
      {liveStreams.map((s) => (
        <StreamingRow key={`stream-${s.messageId}`} text={s.text} thinking={s.thinking} />
      ))}
      {showWorking && <WorkingRow label={workingLabel} />}
    </div>
  );
}
