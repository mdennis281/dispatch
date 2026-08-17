import { GitBranch, GitMerge, GitPullRequest, ShieldOff } from "lucide-react";
import type { PRRef, WorkflowExemption } from "@dispatch/shared";
import { describeExemptionScope } from "@dispatch/shared";
import { Chip } from "../ui/Chip.js";
import { Popover, MenuItem } from "../ui/Popover.js";
import { Button } from "../ui/Button.js";
import { openOverlay } from "../../stores/view.js";
import { cn } from "../../lib/cn.js";

/** Names only what the cluster actually shows — a chat can have either alone. */
function triggerLabel(branchCount: number, hasPr: boolean): string {
  const branchPart = branchCount > 1 ? "Worktrees" : branchCount === 1 ? "Worktree" : null;
  if (branchPart && hasPr) return `${branchPart} and pull request`;
  return branchPart ?? "Pull request";
}

/** Short enough for a header chip; the full sentence lives in the popover. */
function shortScope(exemption: WorkflowExemption): string {
  return exemption.scope === "all" ? "all guards" : exemption.scope;
}

/**
 * The "this chat is running with a guard lifted" badge.
 *
 * Deliberately its OWN chip rather than a line inside the worktree/PR popover,
 * and deliberately `danger` rather than `warn`: everything else in this header
 * describes where the work is, while this one says a rule that normally holds
 * has stopped holding. The 2026-08-17 incident that produced exemptions was
 * survivable because the guard was loud; an exemption that was quiet would just
 * move the same failure one level up. Clicking it reads what was granted and why
 * — and revokes, because a lift you can see but not undo is only half a control.
 */
function ExemptionBadge({
  exemptions,
  onRevoke,
}: {
  exemptions: WorkflowExemption[];
  onRevoke: (id: string) => void;
}) {
  const [first] = exemptions;
  if (!first) return null;
  return (
    <Popover
      align="end"
      width={300}
      className="p-2"
      trigger={({ open, toggle }) => (
        // `Button variant="danger"` rather than a Chip wrapped in a bare
        // element: this one is meant to be pressed (it's how you revoke), and
        // the primitive kit's danger tone is the same ink a Chip would use.
        <Button
          size="sm"
          variant="danger"
          onClick={toggle}
          aria-expanded={open}
          aria-label={`Guard lifted: ${describeExemptionScope(first.scope)}`}
          leftIcon={<ShieldOff className="size-3" />}
          className={cn("cm-mono !text-2xs", open && "bg-danger/20")}
        >
          {exemptions.length > 1 ? `${exemptions.length} guards off` : shortScope(first)}
        </Button>
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-2">
          <p className="text-2xs font-medium uppercase tracking-wide text-faint">
            Guard lifted for this chat
          </p>
          {exemptions.map((e) => (
            <div key={e.id} className="flex flex-col gap-1">
              <p className="text-xs text-primary">{describeExemptionScope(e.scope)}</p>
              <p className="text-2xs leading-4 text-muted">
                {e.lifetime === "once"
                  ? "Next matching command only"
                  : "Until this session ends"}
                {e.uses > 0 && ` · used ${e.uses}×`}
              </p>
              {e.command && (
                <p className="cm-mono break-all text-2xs leading-4 text-secondary">{e.command}</p>
              )}
              <p className="text-2xs leading-4 text-muted">{e.reason}</p>
              <MenuItem
                dense={false}
                icon={<ShieldOff className="text-danger" />}
                onClick={() => {
                  onRevoke(e.id);
                  close();
                }}
              >
                Revoke
              </MenuItem>
            </div>
          ))}
        </div>
      )}
    </Popover>
  );
}

export interface ChatHeaderBadgesProps {
  /** Phone width: collapse to icons, put the words behind a tap. */
  compact: boolean;
  primaryBranch: string | null;
  primaryMerged: boolean;
  extraBranches: string[];
  pr: PRRef | undefined;
  /** Human-approved guard lifts live on this chat (usually none). */
  exemptions: WorkflowExemption[];
  onRevokeExemption: (id: string) => void;
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
  exemptions,
  onRevokeExemption,
}: ChatHeaderBadgesProps) {
  // The exemption badge survives the early return the others share: a chat can
  // be running with a guard lifted and no worktree or PR yet — which is exactly
  // the state a `commit-on-trunk` or `pr-create-by-hand` lift leaves it in.
  const exempt = <ExemptionBadge exemptions={exemptions} onRevoke={onRevokeExemption} />;
  if (!primaryBranch && !pr) return exempt;

  if (!compact) {
    return (
      <>
        {exempt}
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

  // On a phone the branch/PR facts collapse behind one tap, but the exemption
  // stays its own chip: folding "a guard is off" in with "here's the branch"
  // would make the loudest fact the one you have to go looking for.
  return (
    <>
    {exempt}
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
          aria-label={triggerLabel(branches.length, pr !== undefined)}
          aria-expanded={open}
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
                  // Index-keyed: two worktrees can sit on the same branch, so
                  // the name alone isn't unique. The list is render-only and
                  // never reorders in place, so position is a fine identity.
                  key={`${i}-${branch}`}
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
    </>
  );
}
