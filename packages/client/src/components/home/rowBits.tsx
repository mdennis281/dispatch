/**
 * What a chat row CARRIES — its worktree and its pull request — plus the one
 * row for a pull request that belongs to no chat at all.
 *
 * ── WHY THESE ARE ON THE CHAT ROW AND NOT IN LISTS OF THEIR OWN ──────────────
 *
 * They were two more cards. Three stacked lists meant the same work appeared
 * three times — a chat, the branch it cut, the PR it opened, each in a separate
 * block with its own header and its own scroll — and the reader had to join
 * them by eye. A worktree and a pull request BELONG to a chat; they are not
 * peers of it. So they ride on its row, and the page is one list.
 *
 * ── WHY EACH IS ONE COLUMN AND NOT A CHIP CLUSTER ───────────────────────────
 *
 * There is about 200px between a truncating title and the project name. A
 * branch gets a mono run because that is how a branch is read, and a PR gets
 * its number plus a single dot, because `#316` is the identity and everything
 * else about it — open, draft, held, failing, approved — is one fact folded
 * into a colour by {@link prMark}. The words are not dropped: they are the
 * tooltip and the accessible name, where a long phrase costs no layout.
 *
 * ── WHY THE WIDTHS ARE NOT IN HERE ──────────────────────────────────────────
 *
 * These render CONTENT and nothing else — no width, no breakpoint, no
 * alignment. `ChatRow` owns a fixed slot for each, because the point of a dense
 * list is that the branches line up under the branches and the PRs under the
 * PRs. A component that sized itself would be a column whose x moved with its
 * own text, which is exactly what this list looked like before: elegant rows,
 * ragged page.
 */
import { ExternalLink, GitBranch } from "lucide-react";
import type { PrRecord } from "@dispatch/shared";
import { StatusDot, toneText } from "../ui/StatusDot.js";
import { useProjects } from "../../stores/projects.js";
import { relTimeShort } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";
import { prMark, type HomeWorktreeRow } from "./derive.js";

/**
 * The branch a chat is standing on.
 *
 * The first of its live worktrees, which on every chat that has any is the only
 * one — the `+N` is for the rare chat holding several, and says so rather than
 * picking one and hiding the rest.
 *
 * Hidden below `lg`. It is the longest thing that could go on this row and the
 * least urgent: the chat's title already says what the work IS, and the branch
 * is what you need when you are about to go and touch it. On a phone that is
 * one tap away in the chat itself.
 */
export function BranchMark({ worktrees }: { worktrees: readonly HomeWorktreeRow[] }) {
  const first = worktrees[0];
  if (!first) return null;
  const extra = worktrees.length - 1;
  const label = `${first.branch || first.path}${extra > 0 ? ` (+${extra} more worktrees)` : ""}`;
  return (
    <span
      className="flex min-w-0 items-center gap-1"
      title={`Worktree: ${first.path}${extra > 0 ? ` and ${extra} more` : ""}`}
    >
      <GitBranch aria-hidden className="size-3 shrink-0 text-faint" />
      <span className="cm-mono min-w-0 truncate !text-2xs text-accent">
        {first.branch || leaf(first.path)}
      </span>
      {extra > 0 && <span className="shrink-0 text-2xs text-faint">+{extra}</span>}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * The pull request a chat opened: its number, and its whole state as one dot.
 *
 * NOT a link. The row is a button that opens the chat, a link inside a button
 * is invalid and swallows its own clicks, and the chat is where you can
 * actually do something about a PR — `watch_pr`, push a fix, ask the agent. The
 * GitHub link lives on the orphan rows below, which have no chat to offer.
 *
 * `+N` when a chat opened several. The mark shows the most live one (see
 * `prsByChat`), because a row has space for one and the open one is the one
 * still worth a glance.
 */
export function PrMark({ prs }: { prs: readonly PrRecord[] }) {
  const first = prs[0];
  if (!first) return null;
  const mark = prMark(first);
  const extra = prs.length - 1;
  const label = `PR #${first.number} ${mark.label}${extra > 0 ? `, +${extra} more` : ""}`;
  return (
    <span
      className="flex items-center gap-1"
      title={`${first.repo}#${first.number} — ${mark.label}`}
    >
      <StatusDot tone={mark.tone} size={5} />
      <span className={cn("cm-mono !text-2xs", toneText(mark.tone))}>#{first.number}</span>
      {extra > 0 && <span className="text-2xs text-faint">+{extra}</span>}
      {/* The colour IS the state, and a colour reaches nobody using a screen
          reader. Said once, in full, where it costs no width. */}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * A pull request with no chat on this page — dependabot's, a human's, or one
 * whose chat has been deleted.
 *
 * The only row on the list that is not a chat, so it is the only one that opens
 * GitHub instead of a transcript: there is no transcript. Drawn deliberately
 * quieter than a chat row — no status glyph, muted title — because it is
 * something that EXISTS rather than something anybody here is doing.
 */
export function OrphanPrRow({ pr }: { pr: PrRecord }) {
  const mark = prMark(pr);
  const project = useProjects((s) => s.projects.find((p) => p.id === pr.projectId));
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      data-testid="home-orphan-pr-row"
      // The visible text is a bare `#97`, and this list is cross-repository —
      // two rows legitimately read `#97`. `title` is not reliably announced.
      aria-label={`${pr.repo}#${pr.number} — ${mark.label}. Opens GitHub.`}
      title={`${pr.repo}#${pr.number} — ${mark.label}`}
      className="flex w-full items-center gap-2 py-1.5 pl-3 pr-3 transition-colors hover:bg-hover"
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <StatusDot tone={mark.tone} size={5} />
      </span>
      <span className={cn("cm-mono shrink-0 !text-2xs", toneText(mark.tone))}>#{pr.number}</span>
      <span className="min-w-0 flex-1 truncate text-2xs text-secondary">
        {pr.title || `${pr.repo}#${pr.number}`}
      </span>
      <ExternalLink aria-hidden className="size-2.5 shrink-0 text-faint" />
      <span className="max-w-[4.5rem] shrink-0 truncate text-2xs text-faint sm:max-w-[9rem]">
        {project?.name ?? pr.repo}
      </span>
      <span className="w-7 shrink-0 cm-mono text-right !text-2xs text-faint">
        {relTimeShort(pr.lastChangedAt)}
      </span>
    </a>
  );
}

/** Last path segment, for a worktree record that predates the branch history. */
function leaf(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
