import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  GitBranch,
  GitPullRequest,
  GitMerge,
  Square,
  MoreHorizontal,
  Hash,
  ChevronDown,
  MessagesSquare,
  RefreshCw,
  Pencil,
  Trash2,
  Eye,
  EyeOff,
} from "lucide-react";
import { stripTitleMarks } from "@dispatch/shared";
import type { AgentActivity, Chat, WorktreeInfo } from "@dispatch/shared";
import { ScrollArea } from "../ui/ScrollArea.js";
import { IconButton } from "../ui/IconButton.js";
import { Popover, MenuItem } from "../ui/Popover.js";
import { Chip } from "../ui/Chip.js";
import { StatusDot, statusMeta } from "../ui/StatusDot.js";
import { TitleText } from "../ui/TitleText.js";
import { Button } from "../ui/Button.js";
import { Spinner } from "../ui/Spinner.js";
import { Modal, InlineError } from "../sidebar/Modal.js";
import { MessageList } from "./MessageList.js";
import { StreamingTail } from "./StreamingTail.js";
import { TodosStrip } from "./TodosStrip.js";
import { Composer } from "./Composer.js";
import { useChatMessages, useChatPage, useMessages } from "../../stores/messages.js";
import { loadOlderMessages } from "../../stores/index.js";
import { useChats } from "../../stores/chats.js";
import { useAttention } from "../../stores/attention.js";
import { useProjects } from "../../stores/projects.js";
import { usePanels } from "../../stores/panels.js";
import { worktreeMatchesChat, samePath } from "../panels/panelBus.js";
import { actions, deleteChat } from "../../lib/actions.js";
import { api } from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import {
  useInjectedContext,
  injectedContextSourceLabel,
} from "../../lib/injectedContext.js";

function branchName(path: string | undefined): string | null {
  if (!path) return null;
  const leaf = path.split(/[\\/]/).pop() ?? path;
  return leaf.replace(/^[a-z]+-/, (m) => `${m.slice(0, -1)}/`);
}

/**
 * The "primary" worktree for the header: the first whose branch isn't merged, so
 * a merged primary auto-promotes the next live worktree to the front. Falls back
 * to the first when every worktree is merged (nothing live left to show).
 */
function pickPrimary(
  wts: WorktreeInfo[],
  isMerged: (branch: string) => boolean,
): WorktreeInfo | undefined {
  return wts.find((w) => !isMerged(w.branch)) ?? wts[0];
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

/**
 * How close to the top of the transcript the reader must get before the next
 * older page is fetched. Generous enough that the page usually lands before
 * they actually arrive at the top.
 */
const OLDER_PAGE_TRIGGER_PX = 400;

/**
 * Cap on pages fetched back-to-back while the reader sits at the top without
 * moving. Chaining is needed (a page can land without freeing any scroll room),
 * but it must not be able to walk the whole history on its own. Resets as soon
 * as they scroll clear of the top.
 */
const MAX_CHAINED_PAGES = 8;

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
  const { hasMore, loadingOlder } = useChatPage(chat.id);
  const activity = useChats((s) => s.activity[chat.id]);
  const prSettled = useChats((s) => s.prSettled[chat.id] ?? false);
  const agents = useProjects((s) => s.agents);
  const modes = useProjects((s) => s.modes);
  const worktrees = usePanels((s) => s.worktrees);
  const prs = usePanels((s) => s.prs);

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  // Whether this chat's transcript admits the context Dispatch attached for you
  // (chat → project → app → off). Toggling pins an explicit answer on the chat.
  const injected = useInjectedContext(chat.id);
  const toggleInjected = useCallback(() => {
    const next = !injected.show;
    // Optimistic, then persisted: this is a view preference, so a failed write
    // shouldn't block the click — the chat-update reconciles either way.
    useChats.getState().upsertChat({ ...chat, showInjectedContext: next });
    void api.chats.update(chat.id, { showInjectedContext: next }).catch(() => {});
  }, [chat, injected.show]);

  // Inline title rename (header) + delete confirmation dialog.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const startRename = () => {
    // Edited as plain text: `**` in an input box reads as a typo, not as the
    // accent it renders to (see ui/TitleText). Typing them back still works.
    setTitleDraft(stripTitleMarks(chat.title));
    setEditingTitle(true);
  };
  const commitRename = () => {
    const next = titleDraft.trim();
    setEditingTitle(false);
    // No-op on empty / unchanged — don't churn the title or emit a needless turn.
    if (!next || next === chat.title || next === stripTitleMarks(chat.title)) return;
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

  const meta = statusMeta(chat.status, prSettled);
  const running = chat.status === "running";
  const pr = chat.prs[0];

  // Header worktree chip: primary branch + a "+N" for the rest, promoting the next
  // live worktree when the current primary's PR merges.
  const mineWts = worktrees.filter((w) => worktreeMatchesChat(w, chat));
  const isMerged = (b: string) => prs.some((p) => p.branch === b && p.state === "merged");
  const primaryWt = pickPrimary(mineWts, isMerged);
  const pendingWtPaths = chat.worktrees.filter((p) => !mineWts.some((w) => samePath(w.path, p)));
  const primaryBranch = primaryWt?.branch ?? branchName(chat.worktrees[0]);
  const primaryMerged = primaryWt ? isMerged(primaryWt.branch) : false;
  const extraBranches = [
    ...mineWts.filter((w) => w.path !== primaryWt?.path).map((w) => w.branch),
    ...pendingWtPaths.map((p) => branchName(p) ?? p),
  ];

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
    // Clear of the top again → the reader is driving, so allow a fresh chain.
    if (el.scrollTop > OLDER_PAGE_TRIGGER_PX * 2) autoChainRef.current = 0;
    maybeLoadOlder(el);
  };

  // Follow the live stream — stable identity so StreamingTail's effect doesn't
  // re-fire on unrelated parent renders.
  const followBottom = useCallback(() => {
    if (!atBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

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
    followBottom();
  }, [messages.length, running, followBottom]);

  /**
   * Keep the LIVE window bounded.
   *
   * Opening a chat pulls a bounded page, but rows streamed in afterwards just
   * append — so a chat left open while an agent works grows all session until
   * the "windowed" transcript holds the entire history again. Trimming the head
   * hands those rows back to the pager.
   *
   * Gated on the reader being pinned to the bottom (the ref, not the state — a
   * burst of appends can land before React re-renders): dropping rows off the
   * top shifts everything below them, which is invisible when the newest rows
   * are what's on screen and a yank backwards when it isn't. Someone scrolled up
   * reading history — or paging older rows IN — is left alone entirely.
   */
  useEffect(() => {
    if (!atBottomRef.current) return;
    useMessages.getState().trimWindow(chat.id);
  }, [chat.id, messages]);

  /* ------------------------------------------------ backward paging (older rows) */

  // The transcript is a WINDOW (newest N rows). Scrolling to the top pages the
  // previous chunk in — so an old chat opens at a bounded size and grows only as
  // far back as the reader actually goes.
  // Scroll metrics captured the instant we ASK for an older page, so the restore
  // below can pin the viewport to the row the reader was looking at.
  const anchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const firstRowIdRef = useRef<string | undefined>(messages[0]?.id);
  /** Pages auto-loaded without the reader moving clear of the top (runaway guard). */
  const autoChainRef = useRef(0);

  /**
   * Page older rows in when the reader gets near the top.
   *
   * Driven by the SCROLL POSITION, deliberately not by an IntersectionObserver.
   * An observer only fires on an intersection CHANGE, and paging can leave the
   * sentinel continuously in view — most sharply when a page makes the
   * transcript SHORTER (an incoming `Task` row folds its already-loaded child
   * rows into one subagent card), which pins the reader at scrollTop 0 with the
   * sentinel permanently visible. No change means no callback, so paging wedged
   * with no way to recover. A threshold check re-evaluates on every scroll
   * event, so the next flick of the wheel always makes progress.
   *
   * State is read from the store rather than from render-time props: several
   * scroll events can fire before React re-renders, and the live `loadingOlder`
   * flag is what keeps those from stacking duplicate requests.
   */
  const maybeLoadOlder = (el: HTMLDivElement) => {
    if (el.scrollTop > OLDER_PAGE_TRIGGER_PX) return;
    if (autoChainRef.current >= MAX_CHAINED_PAGES) return;
    const page = useMessages.getState().pages[chat.id];
    if (!page?.hasMore || page.loadingOlder) return;
    autoChainRef.current += 1;
    // Captured only when a load will really happen, so the restore below can't
    // act on metrics from a scroll that fetched nothing.
    anchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    void loadOlderMessages(chat.id);
  };

  /** Explicit "load earlier" — a user action, so it ignores (and clears) the cap. */
  const loadOlderNow = () => {
    const el = scrollRef.current;
    if (!el) return;
    autoChainRef.current = 0;
    const page = useMessages.getState().pages[chat.id];
    if (!page?.hasMore || page.loadingOlder) return;
    anchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    void loadOlderMessages(chat.id);
  };

  /**
   * Re-check after every window change — a scroll event alone is not enough to
   * keep paging.
   *
   * Landing a page can leave the reader pinned at scrollTop 0: either the
   * transcript ends up SHORTER than before (an incoming `Task` row folds its
   * already-loaded child rows into one subagent card) or it still doesn't fill
   * the viewport. At scrollTop 0 the browser emits no scroll event no matter how
   * hard you scroll up, so without this the reader is stranded at the top with
   * history remaining and no way to ask for it. Chaining is capped, and the cap
   * resets once they've moved clear of the top (see onScroll).
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !hasMore || loadingOlder) return;
    maybeLoadOlder(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-check per loaded window
  }, [chat.id, hasMore, loadingOlder, messages]);

  // Prepending rows above the viewport shifts everything down by the new
  // content's height; without this the reader gets yanked back to the top on
  // every page. The delta can be NEGATIVE — a page carrying a `Task` row folds
  // its already-loaded child rows into a single subagent card, so the transcript
  // can end up shorter than before — hence the clamp: keep the reader off the
  // very top so the next scroll still has somewhere to go.
  useLayoutEffect(() => {
    const firstId = messages[0]?.id;
    const prevFirstId = firstRowIdRef.current;
    firstRowIdRef.current = firstId;
    if (!prevFirstId || firstId === prevFirstId) return;
    const el = scrollRef.current;
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (!el || !anchor) return;
    const target = el.scrollHeight - anchor.scrollHeight + anchor.scrollTop;
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = Math.min(Math.max(target, 0), maxTop);
  }, [messages]);

  // A chat switch re-anchors: the new transcript's first row isn't a "prepend".
  useEffect(() => {
    firstRowIdRef.current = undefined;
    anchorRef.current = null;
    autoChainRef.current = 0;
  }, [chat.id]);

  const isEmpty = messages.length === 0 && !running;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-app">
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
                  <TitleText title={chat.title} />
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
            {primaryBranch && (
              <Chip
                tone={primaryMerged ? "accent" : "neutral"}
                icon={primaryMerged ? <GitMerge /> : <GitBranch />}
                mono
              >
                {primaryBranch}
              </Chip>
            )}
            {extraBranches.length > 0 && (
              <span title={extraBranches.join(", ")}>
                <Chip tone="muted" mono>
                  +{extraBranches.length}
                </Chip>
              </span>
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
                  {/* Show what Dispatch attached to a turn on your behalf —
                      surfaced memories, repo snapshots. Rendering only: the
                      model got the same context either way. Toggling here
                      overrides the project/app default for THIS chat. */}
                  <MenuItem
                    icon={injected.show ? <Eye className="text-accent" /> : <EyeOff />}
                    hint={injected.source === "chat" ? "this chat" : injectedContextSourceLabel(injected.source)}
                    onClick={() => {
                      toggleInjected();
                      close();
                    }}
                  >
                    {injected.show ? "Hide sent context" : "Show sent context"}
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
              <>
                {/* Older-rows sentinel: pages the previous chunk in on approach. */}
                {/* Paging is automatic, but this stays clickable on purpose: at
                    scrollTop 0 the browser emits no scroll event however hard you
                    scroll up, so an explicit control is the one affordance that
                    can never leave the reader stranded at the top. */}
                {hasMore && (
                  <div className="flex justify-center py-3">
                    <button
                      onClick={loadOlderNow}
                      disabled={loadingOlder}
                      className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] text-faint transition-colors hover:border-line-strong hover:text-secondary disabled:cursor-default disabled:hover:border-line disabled:hover:text-faint"
                    >
                      {loadingOlder ? (
                        <>
                          <Spinner size={10} />
                          Loading earlier messages…
                        </>
                      ) : (
                        "Load earlier messages"
                      )}
                    </button>
                  </div>
                )}
                <div className="flex flex-col divide-y divide-line-soft/70">
                  <MessageList chatId={chat.id} messages={messages} />
                  <StreamingTail
                    chatId={chat.id}
                    running={running}
                    workingLabel={workingLabel}
                    onGrow={followBottom}
                  />
                </div>
              </>
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
      <Composer chat={chat} agents={agents} modes={modes} />

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
