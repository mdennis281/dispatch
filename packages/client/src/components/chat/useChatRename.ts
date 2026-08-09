/**
 * Inline chat rename — the ONE rename interaction, shared by the sidebar row
 * and the transcript header.
 *
 * There used to be two: a modal (sidebar pencil) and an in-place input (header
 * double-click). They disagreed about more than looks — the modal offered an
 * "AI generate" button the inline path didn't, and only one of them stripped
 * `**` marks for editing — so which affordance you happened to reach for
 * changed what renaming a chat could do. AI titling now lives where the other
 * whole-chat actions live (the ⋯ menu and the command palette), and renaming is
 * the same edit-in-place everywhere.
 */
import { useCallback, useState } from "react";
import { stripTitleMarks } from "@dispatch/shared";
import type { Chat } from "@dispatch/shared";
import { actions } from "../../lib/actions.js";
import { useChats } from "../../stores/chats.js";

export interface ChatRename {
  editing: boolean;
  draft: string;
  setDraft: (v: string) => void;
  start: () => void;
  cancel: () => void;
  commit: () => void;
  /** Spread onto the <input>: Enter commits, Escape cancels, blur commits. */
  inputProps: {
    value: string;
    autoFocus: true;
    onChange: (e: { target: { value: string } }) => void;
    onBlur: () => void;
    onFocus: (e: { currentTarget: { select: () => void } }) => void;
    onKeyDown: (e: {
      key: string;
      preventDefault: () => void;
      stopPropagation: () => void;
    }) => void;
  };
}

export function useChatRename(chat: Chat | undefined): ChatRename {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const start = useCallback(() => {
    if (!chat) return;
    // Edited as plain text: `**` in an input box reads as a typo, not as the
    // accent it renders to (see ui/TitleText). Typing them back still works.
    setDraft(stripTitleMarks(chat.title));
    setEditing(true);
  }, [chat]);

  const cancel = useCallback(() => setEditing(false), []);

  const commit = useCallback(() => {
    setEditing(false);
    if (!chat) return;
    const next = draft.trim();
    // No-op on empty / unchanged — don't churn the title or emit a needless turn.
    if (!next || next === chat.title || next === stripTitleMarks(chat.title)) return;
    actions.setTitle(chat.id, next);
    // Optimistic: reflect the rename immediately; the server's chat-update reconciles.
    useChats.getState().upsertChat({ ...chat, title: next });
  }, [chat, draft]);

  return {
    editing,
    draft,
    setDraft,
    start,
    cancel,
    commit,
    inputProps: {
      value: draft,
      autoFocus: true,
      onChange: (e) => setDraft(e.target.value),
      onBlur: commit,
      onFocus: (e) => e.currentTarget.select(),
      onKeyDown: (e) => {
        // Stopped, not just defaulted: in the sidebar this input sits inside a
        // row that treats Enter/Escape as "open"/"clear selection", so an
        // unstopped keystroke would rename AND navigate in the same press.
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setEditing(false);
        }
      },
    },
  };
}
