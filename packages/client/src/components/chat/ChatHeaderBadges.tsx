import { GitBranch, GitMerge, GitPullRequest } from "lucide-react";
import type { PRRef } from "@dispatch/shared";
import { Chip } from "../ui/Chip.js";
import { Popover, MenuItem } from "../ui/Popover.js";
import { Button } from "../ui/Button.js";
import { openOverlay } from "../../stores/view.js";
import { cn } from "../../lib/cn.js";

export interface ChatHeaderBadgesProps {
  /** Phone width: collapse to icons, put the words behind a tap. */
  compact: boolean;
  primaryBranch: string | null;
  primaryMerged: boolean;
  extraBranches: string[];
  pr: PRRef | undefined;
}

/**
 * The chat header's branch + PR badges.
 *
 * On a desktop-width header these are read-at-a-glance labels — a full branch
 * name in mono and a `#78`. On a phone that row is competing with the title for
 * ~390px and it wins, because it is `ml-auto` and never truncates: a
 * `worktree/terminals-collapse` chip alone was pushing the chat title down to
 * three legible characters.
 *
 * So below `md` the same facts collapse to their icons and the strings move
 * behind a tap. Icons keep the two things that matter at a glance — that there
 * IS a worktree, and whether its PR is merged (the tone) — and the popover is
 * where you go when you actually need to read the branch or reach the PR.
 */
export function ChatHeaderBadges({
  compact,
  primaryBranch,
  primaryMerged,
  extraBranches,
  pr,
}: ChatHeaderBadgesProps) {
  if (!primaryBranch && !pr) return null;

  if (!compact) {
    return (
      <>
        {primaryBranch && (
          <Chip
            tone={primaryMerged ? "success" : "info"}
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
          <Chip tone="info" icon={<GitPullRequest />}>
            #{pr.number}
          </Chip>
        )}
      </>
    );
  }

  const branches = [...(primaryBranch ? [primaryBranch] : []), ...extraBranches];

  return (
    <Popover
      align="end"
      width={260}
      className="p-2"
      trigger={({ open, toggle }) => (
        // One target, not two. At this width a pair of 24px chips side by side
        // is two things to miss with a thumb; the cluster is a single ≥44px hit
        // that answers both questions in one panel.
        <Button
          size="md"
          onClick={toggle}
          aria-label="Worktree and pull request"
          className={cn("gap-1.5 px-2", open && "bg-elevated border-line-strong")}
        >
          {primaryBranch &&
            (primaryMerged ? (
              <GitMerge className="size-3.5 text-success" />
            ) : (
              <GitBranch className="size-3.5 text-info-hi" />
            ))}
          {extraBranches.length > 0 && (
            <span className="text-2xs font-medium text-muted">+{extraBranches.length}</span>
          )}
          {pr && <GitPullRequest className="size-3.5 text-info-hi" />}
        </Button>
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-2">
          {branches.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-2xs font-medium uppercase tracking-wide text-faint">
                {branches.length > 1 ? "Worktrees" : "Worktree"}
              </p>
              {branches.map((branch, i) => (
                <p
                  key={branch}
                  className={cn(
                    "cm-mono break-all text-2xs leading-4",
                    i === 0 && primaryMerged ? "text-success" : i === 0 ? "text-info-hi" : "text-muted",
                  )}
                >
                  {branch}
                  {i === 0 && primaryMerged && " · merged"}
                </p>
              ))}
            </div>
          )}
          {pr && (
            <div className="flex flex-col gap-1">
              <p className="text-2xs font-medium uppercase tracking-wide text-faint">
                Pull request
              </p>
              <MenuItem
                dense={false}
                icon={<GitPullRequest className="text-info-hi" />}
                hint={pr.state}
                onClick={() => {
                  openOverlay("prs");
                  close();
                }}
              >
                #{pr.number}
              </MenuItem>
            </div>
          )}
        </div>
      )}
    </Popover>
  );
}
