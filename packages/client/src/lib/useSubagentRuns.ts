/**
 * The one way the UI gets subagent runs for a chat.
 *
 * Runs are derived, never stored, so a live run is always current. Deriving
 * needs the chat's turn status as well as its transcript — an async spawn's tool
 * result is only a launch ack, so the parent turn ending is the sole proof that
 * a background subagent has stopped (see deriveSubagentRuns). Centralising that
 * here keeps the transcript card, the Agents rail and the inspector from drifting
 * into three different answers about whether a run is still going.
 */
import { useMemo } from "react";
import { useChatMessages } from "../stores/messages.js";
import { useChats } from "../stores/chats.js";
import { deriveSubagentRuns, type SubagentRun } from "./subagentRuns.js";

export function useSubagentRuns(chatId: string): SubagentRun[] {
  const messages = useChatMessages(chatId);
  // A scalar selector: the transcript re-renders on status changes anyway, and
  // this keeps a chat-object identity change from invalidating the memo.
  const chatRunning = useChats((s) => s.byId[chatId]?.status === "running");
  return useMemo(
    () => deriveSubagentRuns(messages, { chatRunning }),
    [messages, chatRunning],
  );
}
