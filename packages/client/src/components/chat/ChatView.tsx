import { useEffect, useMemo, useRef, useState } from "react";
import {
  GitBranch,
  GitPullRequest,
  Square,
  MoreHorizontal,
  Hash,
  ChevronDown,
  MessagesSquare,
  RefreshCw,
  Pencil,
  Trash2,
} from "lucide-react";
import type { AgentActivity, Chat } from "@cm/shared";
import { ScrollArea } from "../ui/ScrollArea.js";
import { IconButton } from "../ui/IconButton.js";
import { Popover, MenuItem } from "../ui/Popover.js";
import { Chip } from "../ui/Chip.js";
import { StatusDot, statusMeta } from "../ui/StatusDot.js";
import { Button } from "../ui/Button.js";
import { Modal, InlineError } from "../sidebar/Modal.js";
import { MessageList, type StreamRow } from "./MessageList.js";
import { TodosStrip } from "./TodosStrip.js";
import { Composer } from "./Composer.js";
import { useChatMessages, useMessages } from "../../stores/messages.js";
import { useChats } from "../../stores/chats.js";
import { useAttention } from "../../stores/attention.js";
import { useProjects } from "../../stores/projects.js";
import { actions, deleteChat } from "../../lib/actions.js";
import { cn } from "../../lib/cn.js";

function branchName(path: string | undefined): string | null {
  if (!path) return null;
  const leaf = path.split(/[\\/]/).pop() ?? path;
  return leaf.replace(/^[a-z]+-/, (m) => `${m.slice(0, -1)}/`);
}

/** A human "what is the agent doing" label from the live activity state. */
function workingLabelFor(a: AgentActivity | undefined): string {
  if (a?.label) return a.label;
  switch (a?.state) {
    case "responding":
      return "Responding…";
    case "tool":
      return a.toolName ? `Running ${a.toolName}…` : "Running a tool…";
    case "thinking":
      return "Thinking…";
    default:
      return "Working…";
  }
}

/** Quiet empty state for a chat with no transcript yet. */
function EmptyTranscript() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
      <span className="flex size-10 items-center justify-center rounded-lg border border-line bg-panel-2 text-muted [&_svg]:size-5">
        <MessagesSquare />
      </span>
      <p className="text-[12.5px] text-secondary">No messages yet</p>
      <p className="text-[11.5px] text-muted">Send a message below to start the turn.</p>
    </div>
  );
}

export function ChatView({ chat }: { chat: Chat }) {
  const messages = useChatMessages(chat.id);
  const activity = useChats((s) => s.activity[chat.id]);
  const streamingBuffers = useMessages((s) => s.streaming);
  const agents = useProjects((s) => s.agents);
  const modes = useProjects((s) => s.modes);

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  // Inline title rename (header) + delete confirmation dialog.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const startRename = () => {
    setTitleDraft(chat.title);
    setEditingTitle(true);
  };
  const commitRename = () => {
    const next = titleDraft.trim();
    setEditingTitle(false);
    // No-op on empty / unchanged — don't churn the title or emit a needless turn.
    if (!next || next === chat.title) return;
    actions.setTitle(chat.id, next);
    // Optimistic: reflect the rename immediately; the server's chat-update reconciles.
    useChats.getState().upsertChat({ ...chat, title: next });
  };

  const runDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteChat(chat.id);
      // Purge local state + move focus off the now-gone chat (deletion is REST-only,
      // so there's no bus event to drive these client stores).
      useAttention.getState().clearChat(chat.id);
      useChats.getState().removeChat(chat.id);
      setConfirmDelete(false);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  const meta = statusMeta(chat.status);
  const running = chat.status === "running";
  const branch = branchName(chat.worktrees[0]);
  const pr = chat.prs[0];

  // Live streaming rows: `message-chunk` deltas for this chat not yet finalized
  // as a persisted `chat-message` row (deduped by id once the full row lands).
  const streamRows = useMemo<StreamRow[]>(() => {
    // Only in-flight while the turn runs; a stale buffer never outlives its turn.
    if (!running) return [];
    const prefix = `${chat.id}:`;
    const finalized = new Set(messages.map((m) => m.id));
    const rows: StreamRow[] = [];
    for (const [key, buf] of Object.entries(streamingBuffers)) {
      if (!key.startsWith(prefix)) continue;
      const messageId = key.slice(prefix.length);
      if (finalized.has(messageId)) continue;
      if (!buf.text && !buf.thinking) continue;
      rows.push({ messageId, text: buf.text, thinking: buf.thinking });
    }
    return rows;
  }, [streamingBuffers, messages, chat.id, running]);

  const streamChars = streamRows.reduce((n, r) => n + r.text.length + r.thinking.length, 0);
  const workingLabel = workingLabelFor(activity);

  const scrollToBottom = (behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    atBottomRef.current = true;
    setAtBottom(true);
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const b = dist < 80;
    atBottomRef.current = b;
    setAtBottom(b);
  };

  // Switching chats: snap to the latest and reset the follow + header-edit state.
  useEffect(() => {
    atBottomRef.current = true;
    setAtBottom(true);
    setEditingTitle(false);
    setConfirmDelete(false);
    setDeleteError(null);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.id]);

  // New content: only auto-follow if the reader is already pinned to the bottom.
  useEffect(() => {
    if (atBottomRef.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, streamChars, running]);

  const isEmpty = messages.length === 0 && streamRows.length === 0 && !running;

  return (
    <div className="flex h-full min-w-0 flex-col bg-app">
      {/* header */}
      <div className="relative shrink-0">
        <div className="flex h-12 items-center gap-3 px-4 cm-hairline-b">
          <StatusDot tone={meta.tone} pulse={meta.pulse} size={8} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {editingTitle ? (
                <input
                  autoFocus
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitRename();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setEditingTitle(false);
                    }
                  }}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="Rename chat"
                  className="w-[min(60vw,420px)] rounded-sm border border-accent-line bg-inset px-1.5 py-0.5 text-[13.5px] font-semibold tracking-tight text-primary outline-none"
                />
              ) : (
                <h1
                  onDoubleClick={startRename}
                  title="Double-click to rename"
                  className="truncate text-[13.5px] font-semibold tracking-tight text-primary"
                >
                  {chat.title}
                </h1>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-muted">
              <span className={cn(running && "text-accent-hi")}>{meta.label}</span>
              {activity?.label && (
                <>
                  <span className="text-faint">·</span>
                  <span className="truncate">{activity.label}</span>
                </>
              )}
            </div>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            {branch && (
              <Chip tone="neutral" icon={<GitBranch />} mono>
                {branch}
              </Chip>
            )}
            {pr && (
              <Chip tone="accent" icon={<GitPullRequest />}>
                #{pr.number}
              </Chip>
            )}
            {chat.sessionId && (
              <Chip tone="muted" icon={<Hash />} mono className="hidden lg:inline-flex">
                {chat.sessionId}
              </Chip>
            )}
            {running && (
              <IconButton tip="Interrupt turn" onClick={() => actions.interrupt(chat.id)}>
                <Square />
              </IconButton>
            )}
            <Popover
              align="end"
              width={200}
              className="p-1"
              trigger={({ open, toggle }) => (
                <IconButton tip="Chat options" active={open} onClick={toggle}>
                  <MoreHorizontal />
                </IconButton>
              )}
            >
              {(close) => (
                <div className="flex flex-col">
                  <MenuItem
                    icon={<Pencil />}
                    onClick={() => {
                      startRename();
                      close();
                    }}
                  >
                    Rename
                  </MenuItem>
                  <MenuItem
                    icon={<RefreshCw />}
                    onClick={() => {
                      actions.regenerateTitle(chat.id);
                      close();
                    }}
                  >
                    Regenerate title
                  </MenuItem>
                  <div className="my-1 h-px bg-line" />
                  <MenuItem
                    icon={<Trash2 />}
                    className="!text-danger hover:!text-danger hover:bg-danger/10 [&_span]:text-danger"
                    onClick={() => {
                      setDeleteError(null);
                      setConfirmDelete(true);
                      close();
                    }}
                  >
                    Delete chat
                  </MenuItem>
                </div>
              )}
            </Popover>
          </div>
        </div>
        {running && <div className="absolute inset-x-0 bottom-0 h-px cm-working-strip" />}
      </div>

      {/* live task list (agent TodoWrite/TaskCreate/TaskUpdate) */}
      <TodosStrip key={chat.id} messages={messages} />

      {/* transcript */}
      <div className="relative min-h-0 flex-1">
        <ScrollArea ref={scrollRef} onScroll={onScroll} data-transcript className="h-full">
          <div className="mx-auto max-w-[860px] py-2">
            {isEmpty ? (
              <EmptyTranscript />
            ) : (
              <MessageList
                chatId={chat.id}
                messages={messages}
                streamRows={streamRows}
                working={running}
                workingLabel={workingLabel}
              />
            )}
          </div>
        </ScrollArea>

        {!atBottom && (
          <button
            onClick={() => scrollToBottom("smooth")}
            className={cn(
              "absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5",
              "rounded-full border border-line-strong bg-overlay px-2.5 py-1 text-[11px] font-medium text-secondary",
              "shadow-[var(--shadow-pop)] transition-colors hover:text-primary cm-anim-rise [&_svg]:size-3.5",
            )}
          >
            <ChevronDown />
            Jump to latest
          </button>
        )}
      </div>

      {/* composer */}
      <div className="mx-auto w-full max-w-[860px]">
        <Composer chat={chat} agents={agents} modes={modes} />
      </div>

      <Modal
        open={confirmDelete}
        onClose={() => {
          if (deleting) return;
          setConfirmDelete(false);
          setDeleteError(null);
        }}
        width={420}
        icon={<Trash2 />}
        title="Delete chat"
        description={chat.title}
        footer={
          <>
            {deleteError && (
              <div className="mr-auto min-w-0 flex-1">
                <InlineError message={deleteError} />
              </div>
            )}
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmDelete(false);
                setDeleteError(null);
              }}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={runDelete} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete chat"}
            </Button>
          </>
        }
      >
        <p className="text-[12.5px] leading-relaxed text-secondary">
          This permanently removes the transcript and stops any running turn.
          This can&rsquo;t be undone.
        </p>
      </Modal>
    </div>
  );
}
