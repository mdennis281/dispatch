import { memo, useCallback, useMemo, type ReactNode } from "react";
import type { ChatMessage, ToolResultRow } from "@dispatch/shared";
import type { SubagentRun } from "../../lib/subagentRuns.js";
import { findTaskStatus, indexTaskStatus } from "../../lib/subagentRuns.js";
import { useSubagentRuns } from "../../lib/useSubagentRuns.js";
import { UserRow } from "./rows/UserRow.js";
import { AssistantRow } from "./rows/AssistantRow.js";
import { ToolCallCard } from "./rows/ToolCallCard.js";
import { ShellRunGroup } from "./rows/ShellRunGroup.js";
import { FileRunGroup } from "./rows/FileRunGroup.js";
import { PrRunGroup } from "./rows/PrRunGroup.js";
import { DispatchToolCard } from "./rows/DispatchToolCard.js";
import { SubagentCard } from "./rows/SubagentCard.js";
import { PermissionCard } from "./rows/PermissionCard.js";
import { NoticeRowView, ResultRowView, SystemRowView } from "./rows/MiscRows.js";
import { LimitPausedCard } from "./rows/LimitPausedCard.js";
import { actions } from "../../lib/actions.js";
import { groupTranscriptRows, toolPresentation } from "../../lib/toolPresentations.js";
import { continuedAssistantIds, isLimitSentence } from "../../lib/messageGrouping.js";

export type { StreamRow } from "../../stores/messages.js";

export interface MessageListProps {
  chatId: string;
  messages: ChatMessage[];
}

/**
 * Renders a transcript: pairs tool_use↔tool_result, folds cards, nests subagents.
 *
 * Deliberately holds NO live-stream state. The streaming tail is a sibling
 * component (see chat/StreamingTail.tsx) so a token delta re-renders one small
 * row instead of the entire history — with a long transcript that difference is
 * the whole ballgame, since each assistant row re-parses markdown and re-runs
 * Prism. For the same reason this component and every row it renders are
 * memoized: an append rebuilds the element tree, but untouched rows bail out.
 */
export const MessageList = memo(function MessageList({ chatId, messages }: MessageListProps) {
  const resultsByUse = useMemo(() => {
    const m = new Map<string, ToolResultRow>();
    for (const row of messages) {
      if (row.kind === "tool_result") m.set(row.toolUseId, row);
    }
    return m;
  }, [messages]);

  // Settle verdicts for BACKGROUNDED tool calls (a `Bash` sent to the background
  // answers its tool call with a launch ack in milliseconds and keeps running).
  // Without this the card would read "ok" while the command is still going.
  const taskStatus = useMemo(() => indexTaskStatus(messages), [messages]);

  // Subagent runs: rows a subagent produced tag themselves with the spawning Task
  // tool_use id (`parentToolUseId`). Those rows are lifted OUT of the transcript
  // entirely — the run gets its own surface (the inspector), and the chat shows
  // only the spawning card. Rows whose parent Task isn't in the window fall back
  // to root so a stray subagent row never vanishes.
  //
  // NOTE: with a WINDOWED transcript the parent Task row can be above the loaded
  // window — `toolUseIds` then won't contain it and the child renders at root,
  // which is the intended fallback (visible, just not grouped yet). Paging the
  // parent in folds them into its run.
  const runs = useSubagentRuns(chatId);
  const { roots, runsById } = useMemo(() => {
    const runsById = new Map<string, SubagentRun>();
    for (const run of runs) runsById.set(run.id, run);
    const toolUseIds = new Set<string>();
    for (const r of messages) if (r.kind === "tool_use") toolUseIds.add(r.toolUseId);
    const roots: ChatMessage[] = [];
    for (const r of messages) {
      const pid = "parentToolUseId" in r ? r.parentToolUseId : undefined;
      if (pid && toolUseIds.has(pid)) continue; // belongs to a run, not the chat
      roots.push(r);
    }
    return { roots, runsById };
  }, [messages, runs]);

  // Provider-specific tool names are normalized by presentation handlers. Only
  // handled shell calls take this grouped route; everything else reaches the
  // existing renderRow/ToolCallCard fallback unchanged.
  const transcriptItems = useMemo(() => groupTranscriptRows(roots), [roots]);

  // Two messages from the same speaker with nothing between them are one thing
  // being said, not two: only the first keeps its avatar/name/model/time.
  const continued = useMemo(() => continuedAssistantIds(transcriptItems), [transcriptItems]);

  // Stable across renders (deps only change when the transcript does) so the
  // memoized row components actually get to bail out.
  const renderRow = useCallback(
    (row: ChatMessage): ReactNode => {
      switch (row.kind) {
        case "user":
          return <UserRow key={row.id} chatId={chatId} row={row} />;
        case "assistant":
          // A usage limit is announced TWICE — as this message and as the
          // errored result that follows. The result becomes the pause card
          // (with the schedule + cancel), so the bare echo is dropped. Only a
          // message that is nothing BUT the sentence qualifies.
          if (isLimitSentence(row.text)) return null;
          return (
            <AssistantRow
              key={row.id}
              chatId={chatId}
              row={row}
              continued={continued.has(row.id)}
            />
          );
        case "tool_use": {
          // A Task spawn renders as its run's card, whether or not the subagent
          // has produced any rows yet — so a just-launched run is visible
          // immediately rather than appearing once its first row lands.
          const run = runsById.get(row.toolUseId);
          if (run) return <SubagentCard key={row.id} run={run} />;
          const result = resultsByUse.get(row.toolUseId);
          const presentation = toolPresentation(row);
          if (presentation?.kind === "dispatch") {
            return (
              <DispatchToolCard
                key={row.id}
                use={row}
                result={result}
                task={findTaskStatus(taskStatus, row.toolUseId, result)}
              />
            );
          }
          return (
            <ToolCallCard
              key={row.id}
              use={row}
              result={result}
              task={findTaskStatus(taskStatus, row.toolUseId, result)}
            />
          );
        }
        case "tool_result":
          return null; // folded into its ToolCallCard
        case "permission":
          return (
            <PermissionCard
              key={row.id}
              row={row}
              onDecide={(decision, remember) =>
                actions.answerPermission(chatId, row.requestId, decision, { remember })
              }
            />
          );
        case "result":
          // A turn killed by a usage limit isn't a failure, it's a pause — and
          // the chat has already scheduled itself to continue.
          if (row.isError && isLimitSentence(row.result)) {
            return <LimitPausedCard key={row.id} row={row} reason={row.result!} />;
          }
          return <ResultRowView key={row.id} row={row} />;
        case "system":
          return <SystemRowView key={row.id} row={row} />;
        case "notice":
          return <NoticeRowView key={row.id} row={row} />;
        default:
          return null;
      }
    },
    [chatId, continued, resultsByUse, runsById, taskStatus],
  );

  return (
    <>
      {transcriptItems.map((item, itemIndex) => {
        if (item.kind === "files") {
          const first = item.rows[0]!;
          return (
            <div key={`files:${first.id}`} className="cm-row-cv">
              <FileRunGroup
                entries={item.rows.map((use) => {
                  const result = resultsByUse.get(use.toolUseId);
                  return { use, result, task: findTaskStatus(taskStatus, use.toolUseId, result) };
                })}
              />
            </div>
          );
        }
        if (item.kind === "pr") {
          const first = item.rows[0]!;
          return (
            <div key={`pr:${first.id}`} className="cm-row-cv">
              <PrRunGroup
                entries={item.rows.map((use) => {
                  const result = resultsByUse.get(use.toolUseId);
                  return { use, result, task: findTaskStatus(taskStatus, use.toolUseId, result) };
                })}
              />
            </div>
          );
        }
        if (item.kind === "shell") {
          const first = item.rows[0]!;
          return (
            <div key={`shell:${first.id}`} className="cm-row-cv">
              <ShellRunGroup
                active={itemIndex === transcriptItems.length - 1}
                entries={item.rows.map((use) => {
                  const result = resultsByUse.get(use.toolUseId);
                  return {
                    use,
                    result,
                    task: findTaskStatus(taskStatus, use.toolUseId, result),
                  };
                })}
              />
            </div>
          );
        }
        const row = item.row;
        const node = renderRow(row);
        // Rows that render nothing (a tool_result folded into its card) must emit
        // NO element — the parent's `divide-y` would draw a hairline for an empty
        // wrapper, and there are more folded results than visible rows.
        if (!node) return null;
        // `cm-row-cv` (content-visibility) lets the browser skip layout + paint
        // for off-screen rows. A long transcript keeps hundreds of rows in the
        // DOM; without this, scroll cost grows with history rather than with
        // what's on screen. Native scroll/anchoring/find-in-page all still work.
        return (
          <div key={row.id} data-row-id={row.id} className="cm-row-cv">
            {node}
          </div>
        );
      })}
    </>
  );
});
