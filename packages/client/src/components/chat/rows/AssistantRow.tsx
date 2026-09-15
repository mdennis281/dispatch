import { memo, useMemo } from "react";
import { Sparkles } from "lucide-react";
import type { AssistantMessageRow } from "@dispatch/shared";
import { RowShell } from "./RowShell.js";
import { Markdown } from "../Markdown.js";
import { makeCodeRefResolver } from "../codeRefs.js";
import { Chip } from "../../ui/Chip.js";
import { actions } from "../../../lib/actions.js";
import { useHasCheckpoint } from "../../../stores/checkpoints.js";
import { useChats } from "../../../stores/chats.js";
import { usePanels } from "../../../stores/panels.js";
import { useProjects } from "../../../stores/projects.js";
import { rowHarnessLabel } from "../../../lib/harness.js";

/**
 * An assistant turn: the rendered markdown body. Its reasoning, if any, is not
 * rendered here — `groupTranscriptRows` lifts `thinking` into a ThinkingGroup
 * above this row so it stacks with the thoughts that preceded it.
 *
 * Memoized because this is the expensive row — every render re-parses markdown
 * (react-markdown + remark-gfm) and re-runs Prism over each code fence. A long
 * transcript holds hundreds of these, so they must re-render only when their own
 * row changes, never because something elsewhere in the chat moved.
 */
export const AssistantRow = memo(function AssistantRow({
  chatId,
  row,
  continued = false,
}: {
  chatId: string;
  row: AssistantMessageRow;
  /** The row directly above is the same speaker — render as one block, no header. */
  continued?: boolean;
}) {
  const canRollback = useHasCheckpoint(chatId, row.id);

  // Resolver for clickable code pointers (path:line) in the message body — maps
  // a referenced file to the chat's worktree (or the project's repo root).
  const chat = useChats((s) => s.byId[chatId]);
  const worktrees = usePanels((s) => s.worktrees);
  const projects = useProjects((s) => s.projects);
  // Keyed on the FIELDS the resolver reads, not the chat object: `setStatus`
  // rebuilds that object on every status change, which would otherwise
  // invalidate this memo and re-render the markdown for no reason.
  const resolveRef = useMemo(
    () => makeCodeRefResolver(chat, worktrees, projects),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see note above
    [chat?.id, chat?.projectId, chat?.worktrees, worktrees, projects],
  );
  return (
    <RowShell
      tint="assistant"
      continued={continued}
      who={rowHarnessLabel(row.harness, chat?.harness)}
      ts={row.ts}
      rollback={canRollback}
      onRollback={() => actions.rollback(chatId, row.id)}
      meta={
        <>
          {row.model && <Chip tone="muted" mono>{row.model}</Chip>}
          {row.subagentType && <Chip tone="agent">{row.subagentType}</Chip>}
        </>
      }
      gutter={
        <span className="flex size-6 items-center justify-center rounded-md bg-accent-ghost text-accent-hi ring-1 ring-accent-line [&_svg]:size-3.5">
          <Sparkles />
        </span>
      }
    >
      <Markdown resolve={resolveRef} chatId={chatId}>{row.text}</Markdown>
    </RowShell>
  );
});
