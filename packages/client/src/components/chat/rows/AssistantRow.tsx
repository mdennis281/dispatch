import { useMemo, useState } from "react";
import { Brain, ChevronRight, Sparkles } from "lucide-react";
import type { AssistantMessageRow } from "@cm/shared";
import { RowShell } from "./RowShell.js";
import { Markdown } from "../Markdown.js";
import { makeCodeRefResolver } from "../codeRefs.js";
import { Chip } from "../../ui/Chip.js";
import { cn } from "../../../lib/cn.js";
import { actions } from "../../../lib/actions.js";
import { useHasCheckpoint } from "../../../stores/checkpoints.js";
import { useChats } from "../../../stores/chats.js";
import { usePanels } from "../../../stores/panels.js";
import { useProjects } from "../../../stores/projects.js";

/** An assistant turn: optional collapsed reasoning + rendered markdown body. */
export function AssistantRow({ chatId, row }: { chatId: string; row: AssistantMessageRow }) {
  const [showThinking, setShowThinking] = useState(false);
  const canRollback = useHasCheckpoint(chatId, row.id);

  // Resolver for clickable code pointers (path:line) in the message body — maps
  // a referenced file to the chat's worktree (or the project's repo root).
  const chat = useChats((s) => s.byId[chatId]);
  const worktrees = usePanels((s) => s.worktrees);
  const projects = useProjects((s) => s.projects);
  const resolveRef = useMemo(
    () => makeCodeRefResolver(chat, worktrees, projects),
    [chat, worktrees, projects],
  );
  return (
    <RowShell
      tint="assistant"
      who="Claude"
      ts={row.ts}
      rollback={canRollback}
      onRollback={() => actions.rollback(chatId, row.id)}
      meta={
        <>
          {row.model && <Chip tone="muted" mono>{row.model}</Chip>}
          {row.subagentType && <Chip tone="accent">{row.subagentType}</Chip>}
        </>
      }
      gutter={
        <span className="flex size-6 items-center justify-center rounded-md bg-accent-ghost text-accent-hi ring-1 ring-accent-line [&_svg]:size-3.5">
          <Sparkles />
        </span>
      }
    >
      {row.thinking && (
        <div className="mb-2">
          <button
            onClick={() => setShowThinking((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-[5px] px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-white/[0.05] hover:text-secondary [&_svg]:size-3"
          >
            <Brain />
            <span>Thought for a moment</span>
            <ChevronRight className={cn("transition-transform", showThinking && "rotate-90")} />
          </button>
          {showThinking && (
            <div className="mt-1 border-l-2 border-line pl-3 text-[12px] italic leading-[1.55] text-muted cm-anim-rise">
              {row.thinking}
            </div>
          )}
        </div>
      )}
      <Markdown resolve={resolveRef}>{row.text}</Markdown>
    </RowShell>
  );
}
