/**
 * Every worktree that exists right now, across every project.
 *
 * WHY THIS IS ON THE HOMEPAGE. A worktree is where an agent is standing. On an
 * install running several chats at once they are the physical footprint of all
 * that work — and until now the only way to see them was to open the Workspace
 * modal for one project at a time, which answers "what is in THIS repo" and
 * never "what is checked out anywhere". The second question is the one you ask
 * from the overview, usually because something has been left behind.
 *
 * WHY IT COSTS NOTHING. No `git worktree list` and no endpoint: the rows are a
 * fold over `Chat.worktrees` (the live set, which the detector reconciles) and
 * `Chat.worktreeHistory` (where the branch name lives) — both already in the
 * chat store, both already following `chat-update`. See `derive.ts` for the join
 * and why the history's reaped records are deliberately left out.
 *
 * Clicking a row opens the chat that owns the tree, which is the only thing you
 * can usefully do with one from here. Removing it is the Workspace modal's job
 * and stays there: it is a destructive action on a directory that may have
 * uncommitted work in it, and this page has no room to say so.
 */
import { useMemo, useState } from "react";
import { FolderTree } from "lucide-react";
import { useChats, useProjectChats } from "../../stores/chats.js";
import { useProjects } from "../../stores/projects.js";
import { selectChat } from "../../stores/navigation.js";
import { Card } from "../metrics/chrome.js";
import { TitleLine } from "../ui/TitleText.js";
import { RowButton } from "../ui/RowButton.js";
import { relTimeShort, midTruncate } from "../../lib/format.js";
import { worktreeRows } from "./derive.js";

/** Rows before the fold. Long enough for a busy install, short enough to scan. */
const SHOWN = 8;

export function HomeWorktrees() {
  const chats = useProjectChats(null);
  const rows = useMemo(() => worktreeRows(chats), [chats]);
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, SHOWN);

  return (
    <Card
      title="Worktrees"
      icon={<FolderTree />}
      note={rows.length > 0 ? `${rows.length} live` : undefined}
    >
      {rows.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-faint">
          No worktrees checked out.
        </p>
      ) : (
        <>
          {shown.map((w) => (
            <WorktreeRow key={w.key} row={w} />
          ))}
          {!all && rows.length > SHOWN && (
            <RowButton
              onClick={() => setAll(true)}
              className="w-full px-3 py-1.5 text-2xs text-muted hover:bg-hover hover:text-primary"
            >
              Show {rows.length - SHOWN} more
            </RowButton>
          )}
        </>
      )}
    </Card>
  );
}

function WorktreeRow({ row }: { row: ReturnType<typeof worktreeRows>[number] }) {
  const project = useProjects((s) => s.projects.find((p) => p.id === row.projectId));
  const title = useChats((s) => s.byId[row.chatId]?.title ?? row.chatTitle);

  return (
    <RowButton
      data-testid="home-worktree-row"
      onClick={() => selectChat(row.chatId)}
      title={row.path}
      className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-hover"
    >
      {/* The BRANCH leads, not the path. A worktree is identified by what is
          checked out in it — the directory is a flattened spelling of the same
          name and is the thing you'd paste into a terminal, not the thing you
          recognise it by. A record that predates `worktreeHistory` has no branch
          to show, which is why this falls back to the leaf rather than printing
          an empty column. */}
      <span className="cm-mono min-w-0 shrink-0 max-w-[40%] truncate !text-2xs text-accent">
        {row.branch || leaf(row.path)}
      </span>
      <TitleLine title={title} className="min-w-0 flex-1 truncate text-2xs text-secondary" />
      <span className="hidden shrink-0 cm-mono !text-2xs text-faint lg:block">
        {midTruncate(row.path, 36)}
      </span>
      <span className="max-w-[4.5rem] shrink-0 truncate text-2xs text-faint sm:max-w-[9rem]">
        {project?.name ?? row.projectId}
      </span>
      <span className="w-7 shrink-0 cm-mono text-right !text-2xs text-faint">
        {relTimeShort(row.createdAt)}
      </span>
    </RowButton>
  );
}

/** Last path segment, for the pre-history rows that carry no branch name. */
function leaf(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
