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

/** Joins the worktree list into one scalar. A newline can't occur in a path. */
const WORKTREE_SEP = "\n";

export function useSubagentRuns(chatId: string): SubagentRun[] {
  const messages = useChatMessages(chatId);
  // A scalar selector: the transcript re-renders on status changes anyway, and
  // this keeps a chat-object identity change from invalidating the memo.
  const chatRunning = useChats((s) => {
    const status = s.byId[chatId]?.status;
    return status === "running" || status === "waiting";
  });
  // Joined for the same reason: `worktrees` is a fresh array on every
  // `chat-update`, and the run fold is not worth re-running for that.
  const worktreeKey = useChats((s) =>
    (s.byId[chatId]?.worktrees ?? []).join(WORKTREE_SEP),
  );
  return useMemo(
    () =>
      deriveSubagentRuns(messages, {
        chatRunning,
        worktrees: worktreeKey ? worktreeKey.split(WORKTREE_SEP) : [],
      }),
    [messages, chatRunning, worktreeKey],
  );
}
