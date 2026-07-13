/**
 * The typed action layer — the ONE way features mutate live state.
 *
 * Every WsClientAction has a named function here that sends a validated frame
 * over the singleton `ws` client (queued while the socket is down, so a click
 * during a blip still lands). REST-only affordances (image upload, file/diff
 * reads for Monaco) live here too, so a feature component never touches `fetch`,
 * `ws.send`, or a raw wire shape directly.
 *
 * Feature components: import `actions` and call e.g.
 *   actions.sendMessage(chat.id, { text, images, effort })
 *   actions.answerPermission(chat.id, req.id, "allow")
 *   const ref = await uploadChatImage(chat.id, file)
 */
import type {
  Effort,
  ImageRef,
  PermissionDecision,
} from "@cm/shared";
import { ws } from "./ws.js";
import { api } from "./api.js";

type Priority = "now" | "next" | "later";

/** Answer options for a permission card (allow with edited input / deny reason). */
export interface AnswerPermissionOptions {
  updatedInput?: Record<string, unknown>;
  /** Deny reason. */
  message?: string;
  /** Persist an "always allow" rule. */
  remember?: boolean;
}

/** The full client→server action surface. One function per WsClientAction. */
export const actions = {
  /* ------------------------------------------------------------ chats */

  createChat(input: {
    projectId: string;
    title?: string;
    modeId?: string;
    agentId?: string;
    effort?: Effort;
  }): void {
    ws.send({ type: "create-chat", ...input });
  },

  /** Subscribe/unsubscribe a chat's fine-grained stream (server fans out all). */
  subscribe(chatId: string): void {
    ws.send({ type: "subscribe", chatId });
  },
  unsubscribe(chatId: string): void {
    ws.send({ type: "unsubscribe", chatId });
  },

  /** Send a user message (starts a turn, or injects as steering mid-run). */
  sendMessage(
    chatId: string,
    opts: {
      text?: string;
      images?: ImageRef[];
      effort?: Effort;
      priority?: Priority;
    } = {},
  ): void {
    ws.send({
      type: "send-message",
      chatId,
      text: opts.text,
      images: opts.images,
      effort: opts.effort,
      priority: opts.priority,
    });
  },

  /** Queue a steering message while a turn is running. */
  steer(chatId: string, text: string, priority?: Priority): void {
    ws.send({ type: "steer", chatId, text, priority });
  },

  /* ----------------------------------------------------- attention/answers */

  answerPermission(
    chatId: string,
    requestId: string,
    decision: PermissionDecision,
    opts: AnswerPermissionOptions = {},
  ): void {
    ws.send({
      type: "answer-permission",
      chatId,
      requestId,
      decision,
      updatedInput: opts.updatedInput,
      message: opts.message,
      remember: opts.remember,
    });
  },

  answerQuestion(
    chatId: string,
    requestId: string,
    opts: {
      optionId?: string;
      answer?: string;
      /** Per-question answers for a multi-question ask (supersedes optionId/answer). */
      answers?: { questionIndex: number; optionId?: string; answer?: string }[];
    } = {},
  ): void {
    ws.send({
      type: "answer-question",
      chatId,
      requestId,
      optionId: opts.optionId,
      answer: opts.answer,
      answers: opts.answers,
    });
  },

  /** Decline an AskUserQuestion prompt without answering it. */
  declineQuestion(chatId: string, requestId: string): void {
    ws.send({ type: "decline-question", chatId, requestId });
  },

  /* ------------------------------------------------ mode / agent / effort */

  setMode(chatId: string, modeId: string): void {
    ws.send({ type: "set-mode", chatId, modeId });
  },
  setAgent(chatId: string, agentId: string | null): void {
    ws.send({ type: "set-agent", chatId, agentId });
  },
  setEffort(chatId: string, effort: Effort): void {
    ws.send({ type: "set-effort", chatId, effort });
  },
  /** Switch the model backing the chat's session (applies live + persists). */
  setModel(chatId: string, model: string): void {
    ws.send({ type: "set-model", chatId, model });
  },

  /* ---------------------------------------------------------------- title */

  /** (Re)generate the chat's AI title from its recent messages. */
  regenerateTitle(chatId: string): void {
    ws.send({ type: "regenerate-title", chatId });
  },

  /** Rename the chat to an explicit title (persists + emits chat-update). */
  setTitle(chatId: string, title: string): void {
    ws.send({ type: "set-title", chatId, title });
  },

  /* --------------------------------------------------- run control / rollback */

  interrupt(chatId: string): void {
    ws.send({ type: "interrupt", chatId });
  },
  /** Compact the model's context in place (native SDK `/compact`). */
  compactContext(chatId: string): void {
    ws.send({ type: "compact-context", chatId });
  },
  /** Clear the model's context (native SDK `/clear`); the transcript is kept. */
  clearContext(chatId: string): void {
    ws.send({ type: "clear-context", chatId });
  },
  rollback(chatId: string, messageId: string): void {
    ws.send({ type: "rollback", chatId, messageId });
  },

  /* ---------------------------------------------------------- runners */

  startRunner(input: {
    subAppId: string;
    /** Explicit dir to run in, or omit and pass `branch` to resolve one. */
    worktreePath?: string;
    /** Branch to run on (resolves to / creates a worktree server-side). */
    branch?: string;
    projectId?: string;
    chatId?: string;
  }): void {
    ws.send({ type: "start-runner", ...input });
  },
  stopRunner(runnerId: string): void {
    ws.send({ type: "stop-runner", runnerId });
  },

  /* --------------------------------------------------------- worktrees */

  createWorktree(input: {
    chatId: string;
    projectId: string;
    branch: string;
  }): void {
    ws.send({ type: "create-worktree", ...input });
  },
  removeWorktree(input: { worktreePath: string; chatId?: string }): void {
    ws.send({ type: "remove-worktree", ...input });
  },
  /** Unlink a worktree from a chat's attribution (keeps it on disk) — fixes a
   *  worktree wrongly shown under this chat. */
  detachWorktree(input: { chatId: string; worktreePath: string }): void {
    ws.send({ type: "detach-worktree", ...input });
  },

  /* ---------------------------------------------- github control plane */

  ghAction(input: {
    op:
      | "ship"
      | "refresh"
      | "merge"
      | "hold"
      | "unhold"
      | "label"
      | "unlabel"
      | "rerun"
      | "resolve-thread"
      | "review"
      | "dispatch";
    chatId?: string;
    projectId?: string;
    prNumber?: number;
    label?: string;
    threadId?: string;
    workflow?: string;
    ref?: string;
    inputs?: Record<string, string>;
  }): void {
    ws.send({ type: "gh-action", ...input });
  },
};

export type Actions = typeof actions;

/* ------------------------------------------------------- REST-only helpers */

/** Read a Blob/File as a `data:` URL (for image upload). */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Upload a pasted/dropped image (File/Blob or a data URL) to a chat's assets and
 * return an ImageRef ready to hand to `actions.sendMessage({ images: [ref] })`.
 */
export async function uploadChatImage(
  chatId: string,
  source: File | Blob | string,
  meta?: { alt?: string; width?: number; height?: number },
): Promise<ImageRef> {
  let data: string;
  let mimeType: string | undefined;
  let filename: string | undefined;
  if (typeof source === "string") {
    data = source;
  } else {
    data = await blobToDataUrl(source);
    mimeType = source.type || undefined;
    filename = source instanceof File ? source.name : undefined;
  }
  return api.chats.uploadAsset(chatId, {
    data,
    mimeType,
    filename,
    alt: meta?.alt,
    width: meta?.width,
    height: meta?.height,
  });
}

/**
 * Delete a chat server-side (DELETE /api/chats/:id): stops its live broker
 * session, clears its Attention Queue items, and removes the transcript +
 * checkpoints on disk. The caller purges the client stores + reselects a chat
 * (see `useChats.removeChat`) — deletion is REST-only, with no bus broadcast.
 */
export function deleteChat(chatId: string): Promise<void> {
  return api.chats.remove(chatId);
}

// Re-export the read helpers features use for Monaco so they import from one place.
export { assetUrl } from "./api.js";
export type { WorktreeFileContent, ServerWorktreeDiff, ServerFileDiff } from "./api.js";

/** Read a worktree file (working tree, or at `ref` for the base side of a diff). */
export const readWorktreeFile = (
  worktreePath: string,
  relPath: string,
  ref?: string,
) => api.worktrees.file(worktreePath, relPath, ref);

/** Save edited working-tree file content (editable Monaco config editor). */
export const writeWorktreeFile = (
  worktreePath: string,
  relPath: string,
  content: string,
) => api.worktrees.writeFile(worktreePath, relPath, content);

/** Structured worktree-vs-base diff (per-file patch + counts) for the diff view. */
export const readWorktreeDiff = (worktreePath: string, base = "main") =>
  api.worktrees.diff(worktreePath, base);
