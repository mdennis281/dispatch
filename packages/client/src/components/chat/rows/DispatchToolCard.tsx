import { memo, useEffect, useState, type ReactNode } from "react";
import {
  Brain,
  CircleDot,
  BookOpen,
  Check,
  Circle,
  Clock3,
  GitPullRequest,
  MessageSquare,
  MessagesSquare,
  MonitorPlay,
  PlugZap,
  SquareTerminal,
  X,
} from "lucide-react";
import type { TaskStatusRow, ToolResultRow, ToolUseRow } from "@dispatch/shared";
import { RowShell } from "./RowShell.js";
import { PeerChatPanel, PeerChatRef, plainTitle, usePeerChat } from "./PeerChatRef.js";
import { ToolDetailModal, type ToolDetailState } from "../ToolDetailModal.js";
import { Markdown } from "../Markdown.js";
import { Button } from "../../ui/Button.js";
import { Chip } from "../../ui/Chip.js";
import { OverflowTooltip } from "../../ui/OverflowTooltip.js";
import { Spinner } from "../../ui/Spinner.js";
import { cn } from "../../../lib/cn.js";
import { dur, safeJson } from "../../../lib/format.js";
import { ackTaskId } from "../../../lib/subagentRuns.js";
import { hydrateFullRows } from "../../../stores/index.js";
import {
  displayResultText,
  peerChatIdFromResult,
  peerResultProse,
  toolPresentation,
  type DispatchToolCategory,
} from "../../../lib/toolPresentations.js";

function toolState(result?: ToolResultRow, task?: TaskStatusRow): ToolDetailState {
  const backgrounded = !!result && (!!task || !!ackTaskId(result));
  if (!result || (backgrounded && !task)) return "running";
  if (task?.status === "failed" || (!backgrounded && (result.isError || result.ok === false))) {
    return "failed";
  }
  if (task?.status === "stopped") return "stopped";
  return "ok";
}

function categoryIcon(category: DispatchToolCategory): ReactNode {
  if (category === "wait") return <Clock3 />;
  if (category === "pr") return <GitPullRequest />;
  if (category === "issue") return <CircleDot />;
  if (category === "terminal") return <SquareTerminal />;
  if (category === "preview") return <MonitorPlay />;
  if (category === "memory") return <Brain />;
  if (category === "config") return <BookOpen />;
  if (category === "chat") return <MessageSquare />;
  if (category === "peer") return <MessagesSquare />;
  return <PlugZap />;
}

function useCountdown(startedAt: number, seconds: number | undefined, running: boolean): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (!running || seconds === undefined) {
      setRemaining(null);
      return;
    }
    const deadline = startedAt + seconds * 1_000;
    const update = () => setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1_000)));
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [running, seconds, startedAt]);
  return remaining;
}

function StateMark({ state }: { state: ToolDetailState }) {
  if (state === "running") return <Spinner size={10} />;
  if (state === "failed") return <X className="text-danger" />;
  if (state === "stopped") return <Circle className="text-muted" />;
  return <Check className="text-success" />;
}

function promptFor(tool: string, category: DispatchToolCategory): string {
  if (tool === "ask_user") return "ask";
  if (tool === "request_human_review") return "review";
  if (tool.startsWith("secret_")) return "secret";
  if (tool.startsWith("issue_")) return "issue";
  if (tool === "wait") return "sleep";
  if (tool === "recall") return "recall";
  if (tool === "remember") return "remember";
  if (tool === "forget") return "forget";
  if (category === "memory") return "memory";
  // The prompt names the SUBJECT, not the tool: every one of these edits the
  // guidance a session runs on, and "skill >" is what the reader is looking for.
  if (category === "config") return "skill";
  if (category === "pr") return "pr";
  if (category === "preview") return "app";
  if (category === "terminal") return "terminal";
  if (category === "chat") return "context";
  if (category === "peer") return "chat";
  return "mcp";
}

function promptColor(category: DispatchToolCategory): string {
  if (category === "wait") return "text-warn";
  if (category === "pr") return "text-info-hi";
  if (category === "issue") return "text-info-hi";
  if (category === "memory") return "text-accent-2-hi";
  if (category === "config") return "text-accent-2-hi";
  if (category === "preview") return "text-success";
  if (category === "chat") return "text-accent-hi";
  // Violet, the "machine on your behalf" tone (see Chip): a peer call is one
  // agent talking to another, which is exactly what that colour already means.
  if (category === "peer") return "text-accent-2-hi";
  return "text-secondary";
}

function progressColor(category: DispatchToolCategory): string {
  if (category === "wait") return "bg-warn";
  if (category === "pr") return "bg-info";
  if (category === "issue") return "bg-info";
  if (category === "memory") return "bg-accent-2";
  if (category === "config") return "bg-accent-2";
  if (category === "preview") return "bg-success";
  if (category === "chat") return "bg-accent";
  if (category === "peer") return "bg-accent-2";
  return "bg-line-strong";
}

function textInput(use: ToolUseRow, key: string): string | undefined {
  const value = use.input[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberInput(use: ToolUseRow, key: string): number | undefined {
  const value = use.input[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function firstLine(text: string | undefined): string | undefined {
  const line = text?.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return line && line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/**
 * The prose argument a peer call is really made of, and what to call it. The
 * inspector shows this as text under its own heading instead of burying it in
 * a JSON dump beside the id and the timeout.
 */
const PEER_PROSE: Record<string, { key: string; label: string }> = {
  chat_send: { key: "message", label: "Message" },
  chat_ask: { key: "question", label: "Question" },
  chat_reply: { key: "answer", label: "Answer" },
  spawn_chat: { key: "prompt", label: "Brief" },
};

function commandPreview(
  use: ToolUseRow,
  tool: string,
  subject: string | undefined,
  activity: string,
  peer?: { chatId?: string; title?: string },
): string {
  // Peer calls name the OTHER chat by title: the id is what the tool needed,
  // the title is what the reader recognises from the sidebar.
  const who = peer?.title ? plainTitle(peer.title) : peer?.chatId;
  if (tool === "wait_for_chat") return `wait for ${who ?? "chat"}`;
  if (tool === "chat_send") return `send ${who ?? "chat"} · ${firstLine(textInput(use, "message")) ?? ""}`;
  if (tool === "chat_ask") return `ask ${who ?? "chat"} · ${firstLine(textInput(use, "question")) ?? ""}`;
  if (tool === "chat_reply") return `reply${who ? ` ${who}` : ""} · ${firstLine(textInput(use, "answer")) ?? ""}`;
  if (tool === "chat_state") return `state ${who ?? "chat"}`;
  if (tool === "chat_read") {
    const query = textInput(use, "query");
    return `read ${who ?? "chat"}${query ? ` · ${query}` : ""}`;
  }
  if (tool === "chat_find") return `find ${textInput(use, "query") ?? textInput(use, "project") ?? "chats"}`;
  if (tool === "spawn_chat") {
    return `spawn ${who ?? textInput(use, "title") ?? firstLine(textInput(use, "prompt")) ?? "chat"}`;
  }
  if (tool === "recall" || tool === "memory_search") {
    return textInput(use, "query") ?? subject ?? "search";
  }
  if (tool === "remember") return textInput(use, "name") ?? subject ?? "save memory";
  if (tool === "forget") return textInput(use, "name") ?? subject ?? "remove memory";
  if (tool === "memory_list") return "list";
  if (tool === "create_pr") return `open ${textInput(use, "title") ?? subject ?? "pull request"}`;
  if (tool === "watch_pr") return `watch ${subject ?? "pull request"}`;
  if (tool === "approve_pr") return `merge ${subject ?? "pull request"}`;
  if (tool === "resolve_thread") return `resolve ${subject ?? "review thread"}`;
  if (tool === "request_review") return `request review${subject ? ` for ${subject}` : ""}`;
  if (tool === "post_review") return `review ${subject ?? "pull request"}`;
  if (tool === "request_human_review") return textInput(use, "title") ?? activity;
  if (tool === "run_subapp") return `${use.input.stop === true ? "stop" : "start"} ${subject ?? "app"}`;
  if (tool === "terminal_output") return `read ${subject ?? "terminal"}`;
  if (tool === "issue_list") return `list ${textInput(use, "state") ?? "open"}`;
  if (tool === "issue_read") return `read ${subject ?? "issue"}`;
  if (tool === "issue_comment") return `comment ${subject ?? "issue"}`;
  if (tool === "issue_update") {
    const state = textInput(use, "state");
    return `${state === "closed" ? "close" : state === "open" ? "reopen" : "update"} ${subject ?? "issue"}`;
  }
  return subject ?? activity;
}

function sleepDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  if (minutes > 0) return remainder > 0 ? `${minutes} min ${remainder} sec` : `${minutes} min`;
  return `${remainder} sec`;
}

/**
 * A peer result as a sentence about a chat you can name: the JSON trailer gone,
 * and the id the tool spoke in swapped for the title the reader knows. Only
 * done when the title is actually known — an id we cannot resolve is left as
 * the tool wrote it rather than replaced with a guess.
 */
function humanizePeerResult(content: unknown, chatId: string | undefined, title: string | undefined): string {
  const prose = peerResultProse(content);
  if (!chatId || !title) return prose;
  const plain = plainTitle(title);
  return (
    prose
      .split(`"${chatId}"`)
      .join(`“${plain}”`)
      .split(chatId)
      .join(`“${plain}”`)
      // `spawn_chat` quotes the new title verbatim, `**bold**` marks and all.
      .split(title)
      .join(plain)
  );
}

/**
 * The inspector's request pane for a peer call: the message itself as text
 * when the call is made of one, the remaining knobs as chips, and the wire
 * JSON one disclosure away for whoever needs the exact bytes. The chat id is
 * left out — the identity row above already says which chat, with a status
 * and a link.
 */
function PeerArguments({ use, proseKey, text }: { use: ToolUseRow; proseKey?: string; text?: string }) {
  const knobs = Object.entries(use.input).filter(
    ([key, value]) => key !== proseKey && key !== "chatId" && value !== undefined && value !== null,
  );
  return (
    <div className="space-y-2.5">
      {text ? (
        <Markdown className="!text-sm !text-secondary">{text}</Markdown>
      ) : knobs.length === 0 ? (
        <span className="text-xs text-faint">Nothing beyond the chat.</span>
      ) : null}
      {knobs.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {knobs.map(([key, value]) => (
            <Chip key={key} tone="muted" mono>
              {key}: {typeof value === "string" ? value : safeJson(value, 0)}
            </Chip>
          ))}
        </div>
      )}
      <details>
        <summary className="cursor-pointer select-none text-2xs text-faint hover:text-muted">Raw arguments</summary>
        <pre className="mt-1.5 whitespace-pre-wrap break-words cm-mono !text-xs text-muted">{safeJson(use.input)}</pre>
      </details>
    </div>
  );
}

export const DispatchToolCard = memo(function DispatchToolCard({
  use,
  result,
  task,
  embedded = false,
}: {
  use: ToolUseRow;
  result?: ToolResultRow;
  task?: TaskStatusRow;
  embedded?: boolean;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const presentation = toolPresentation(use);
  if (!presentation || presentation.kind !== "dispatch") return null;

  const state = toolState(result, task);
  const backgrounded = !!result && (!!task || !!ackTaskId(result));
  const elapsed = task?.durationMs ?? (backgrounded ? undefined : result?.durationMs);
  const countdown = useCountdown(use.ts, presentation.countdownSeconds, state === "running");
  const sleep = presentation.tool === "wait" && presentation.countdownSeconds !== undefined;
  const isPeer = presentation.category === "peer";
  // `spawn_chat` and `chat_reply` only learn which chat once the result is in.
  const peerChatId =
    presentation.peerChatId ?? (isPeer ? peerChatIdFromResult(result?.content) : undefined);
  const peerChat = usePeerChat(peerChatId);
  const peerName = peerChat ? plainTitle(peerChat.title) : undefined;
  // The blocking calls say how long they are prepared to block, so a card
  // that has sat there for ten minutes reads as patient rather than stuck.
  const timeout = numberInput(use, "timeoutSeconds");
  const patience =
    timeout && (presentation.tool === "wait_for_chat" || presentation.tool === "chat_ask")
      ? ` · up to ${sleepDuration(timeout)}`
      : "";
  const response = sleep && result
    ? `waited for ${sleepDuration(presentation.countdownSeconds!)}`
    : result
      ? (isPeer
          ? humanizePeerResult(result.content, peerChatId, peerChat?.title)
          : displayResultText(result.content)) || "No response body"
      : peerName
        ? `${presentation.activity} · ${peerName}${patience}`
        : presentation.subject
          ? `${presentation.activity} · ${presentation.subject}`
          : `${presentation.activity}${patience}`;
  const prose = PEER_PROSE[presentation.tool];
  const proseText = prose ? textInput(use, prose.key) : undefined;
  const request = proseText ?? safeJson(use.input);
  const requestPreview = commandPreview(use, presentation.tool, presentation.subject, presentation.activity, {
    chatId: peerChatId,
    title: peerChat?.title,
  });
  const clipped = Boolean(use.inputOmitted) || Boolean(result?.contentOmitted);
  const progress = presentation.countdownSeconds && countdown !== null
    ? Math.max(
        0,
        Math.min(
          100,
          ((presentation.countdownSeconds - countdown) / presentation.countdownSeconds) * 100,
        ),
      )
    : null;

  const inspect = () => {
    if (clipped) {
      const ids: string[] = [];
      if (use.inputOmitted) ids.push(use.id);
      if (result?.contentOmitted) ids.push(result.id);
      void hydrateFullRows(use.chatId, ids);
    }
    setDetailOpen(true);
  };

  const tone = state === "running"
    ? "accent"
    : state === "failed"
      ? "danger"
      : state === "ok"
        ? "success"
        : "muted";
  const statusLabel = sleep && countdown !== null
    ? "sleeping"
    : countdown !== null
      ? `${countdown}s`
      : state === "running"
        ? "working"
        : state;
  const prompt = promptFor(presentation.tool, presentation.category);
  const promptClass = promptColor(presentation.category);
  const sleepText = countdown !== null
    ? `${countdown}s`
    : sleep
      ? `waited for ${sleepDuration(presentation.countdownSeconds!)}`
      : null;
  const cardTitle = sleep ? "Sleep" : presentation.title;

  return (
    <RowShell
      className={cn(embedded && "!gap-0 !p-0 [&>div:first-child]:hidden")}
      gutter={
        <span className="flex size-6 items-center justify-center rounded-md bg-accent-ghost text-accent-hi ring-1 ring-accent-line [&_svg]:size-3.5">
          {categoryIcon(presentation.category)}
        </span>
      }
    >
      <div
        className={cn(
          "overflow-hidden rounded-md border border-line bg-panel-2/60",
          embedded && "!rounded-none !border-0 !bg-transparent",
        )}
      >
        {!embedded && <div className="flex h-8 items-center gap-2 px-2.5">
          <span className="text-sm font-semibold text-primary">{cardTitle}</span>
          {peerChatId ? (
            <PeerChatRef chatId={peerChatId} className="min-w-0" />
          ) : (
            presentation.subject && <Chip tone="info" mono>{presentation.subject}</Chip>
          )}
          <span className="ml-auto">
            <Chip tone={tone} icon={<StateMark state={state} />}>{statusLabel}</Chip>
          </span>
        </div>}
        {progress !== null && (
          <div className="h-0.5 bg-line-soft">
            <div
              className={cn(
                "h-full transition-[width] duration-300 ease-linear",
                progressColor(presentation.category),
              )}
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
        <div
          className={cn(
            "group/exchange transition-colors hover:bg-hover/20",
            !embedded && "border-t border-line-soft",
          )}
        >
          {sleep ? (
            <Button
              type="button"
              variant="ghost"
              onClick={inspect}
              className="group/sleep !flex !h-6 w-full min-w-0 justify-start !rounded-none !border-0 px-2.5 text-left !font-normal hover:!bg-transparent active:translate-y-0"
            >
              <span className={cn("mr-2 shrink-0 cm-mono !text-xs font-semibold", promptClass)}>
                {prompt} &gt;
              </span>
              <span className="cm-mono !text-xs text-secondary opacity-80 transition-[filter,opacity] group-hover/sleep:brightness-125 group-hover/sleep:opacity-100">
                {sleepText}
              </span>
              <span className="ml-auto"><StateMark state={state} /></span>
            </Button>
          ) : (
            <>
              {/* The peer ref sits BESIDE the row button, not inside it: a
                  button in a button is invalid markup and a click would fire
                  both. Inside a terminal frame the header (and its
                  title-bearing ref) is hidden, so this is the row's only way
                  to the chat. */}
              <div className="flex items-center">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={inspect}
                  className="group/send !flex !h-6 w-full min-w-0 flex-1 justify-start !rounded-none !border-0 px-2.5 text-left !font-normal hover:!bg-transparent active:translate-y-0"
                >
                  <span className={cn("mr-2 shrink-0 cm-mono !text-xs font-semibold", promptClass)}>
                    {prompt} &gt;
                  </span>
                  <OverflowTooltip
                    text={requestPreview}
                    className="min-w-0 flex-1 truncate cm-mono !text-xs text-secondary opacity-80 transition-[filter,opacity] group-hover/send:brightness-125 group-hover/send:opacity-100"
                  />
                  {state === "running" && <Spinner size={9} className="ml-2 shrink-0" />}
                </Button>
                {embedded && peerChatId && (
                  <PeerChatRef chatId={peerChatId} compact className="mr-1.5 shrink-0" />
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                onClick={inspect}
                className="group/receipt !grid !h-auto min-h-0 w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-3 !whitespace-normal !rounded-none !border-0 px-2.5 py-0.5 text-left !font-normal hover:!bg-transparent active:translate-y-0"
              >
                <OverflowTooltip
                  text={response}
                  lines={2}
                  className={cn(
                    "whitespace-pre-wrap text-xs leading-[1.35] text-muted opacity-75 transition-[color,filter,opacity] group-hover/receipt:brightness-125 group-hover/receipt:text-primary group-hover/receipt:opacity-100",
                    state === "running" && "italic text-faint",
                    state === "failed" && "text-danger",
                  )}
                />
                <span className="flex min-w-12 items-center justify-end gap-1.5 pt-px cm-mono !text-2xs text-faint [&_svg]:size-3">
                  {elapsed !== undefined && <span>{dur(elapsed)}</span>}
                  <StateMark state={state} />
                </span>
              </Button>
            </>
          )}
        </div>
      </div>

      <ToolDetailModal
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        title={cardTitle}
        description={peerName ?? peerChatId ?? presentation.subject ?? "MCP exchange"}
        icon={categoryIcon(presentation.category)}
        state={state}
        duration={dur(elapsed)}
        lead={peerChatId ? <PeerChatPanel chatId={peerChatId} /> : undefined}
        request={request}
        requestLabel={proseText ? prose!.label : "Arguments"}
        requestBody={isPeer ? <PeerArguments use={use} proseKey={prose?.key} text={proseText} /> : undefined}
        response={sleepText ?? response}
        responseLabel="Response"
        responseBody={
          <Markdown className="!text-sm !text-secondary">{sleepText ?? response}</Markdown>
        }
      />
    </RowShell>
  );
});
