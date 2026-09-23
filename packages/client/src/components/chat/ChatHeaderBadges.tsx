import type { ReactNode } from "react";
import { GitBranch, GitMerge, GitPullRequest, ShieldOff } from "lucide-react";
import type { PRRef, WorkflowExemption } from "@dispatch/shared";
import { describeExemptionScope } from "@dispatch/shared";
import { Badge, Chip, type Tone } from "../ui/Chip.js";
import { Popover, MenuItem } from "../ui/Popover.js";
import { Button } from "../ui/Button.js";
import { openWorkspace } from "../../stores/workspace.js";
import { cn } from "../../lib/cn.js";

/** One worktree this chat has ever owned — including ones since cleaned up. */
export interface ChatWorktreeRef {
  branch: string;
  /** Identity: two worktrees can sit on the same branch, so the name isn't it. */
  path: string;
  /** Still in the live worktree catalog. False once it has been removed. */
  live: boolean;
  merged: boolean;
}

/** Names only what the cluster actually shows — a chat can have either alone. */
function triggerLabel(wtCount: number, prCount: number): string {
  const parts: string[] = [];
  if (wtCount > 0) parts.push(`${wtCount} worktree${wtCount > 1 ? "s" : ""}`);
  if (prCount > 0) parts.push(`${prCount} pull request${prCount > 1 ? "s" : ""}`);
  return parts.join(", ");
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

/**
 * The header's colour language for a PR, which is the one its worktrees already
 * speak: blue = live, green = landed, red = gone. Deliberately NOT the
 * workspace catalog's mapping (open = green, merged = amber) — in a header
 * where the branch beside it turns green the moment its PR merges, a green
 * `#266` meaning "still open" says the opposite of its own neighbour.
 */
const PR_TONE: Record<NonNullable<PRRef["state"]>, Tone> = {
  open: "info",
  merged: "success",
  closed: "danger",
};

const PR_INK: Record<NonNullable<PRRef["state"]>, string> = {
  open: "text-info-hi",
  merged: "text-success",
  closed: "text-danger",
};

/**
 * An icon wearing its count.
 *
 * The count is the whole point of the compact cluster: at phone width the two
 * glyphs say THAT there is a worktree and THAT there is a PR, and without a
 * number they say it identically whether the chat cut one or nine. A
 * `Badge size="sm"` is 13px against a 14px glyph, so it annotates the corner
 * instead of covering it, and it only appears past one — a "1" on every chat is
 * decoration, and decoration is what this header has no room for.
 */
function CountedIcon({ icon, count, tone }: { icon: ReactNode; count: number; tone: Tone }) {
  return (
    <span className="relative flex items-center [&_svg]:size-3.5">
      {icon}
      {count > 1 && (
        <span className="pointer-events-none absolute -right-2 -top-1.5">
          <Badge count={count} size="sm" tone={tone} />
        </span>
      )}
    </span>
  );
}

/** A section title carrying its own count — the popover's "how many". */
function SectionHead({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5 px-1 pb-0.5 pt-1">
      <p className="text-2xs font-medium uppercase tracking-wide text-faint">{label}</p>
      {/* A rule, not a spacer: it ties the count to its label across the gap,
          and `-soft` is invisible on the dark themes at 1px. */}
      <span className="h-px flex-1 bg-line" />
      <span className="cm-mono !text-2xs tabular-nums text-muted">{count}</span>
    </div>
  );
}

/** What the right-hand hint says about a worktree that isn't simply live. */
function worktreeHint(w: ChatWorktreeRef): string | undefined {
  if (w.merged) return w.live ? "merged" : "merged · removed";
  return w.live ? undefined : "removed";
}

/**
 * The full roster: every worktree this chat has cut and every PR it has opened.
 *
 * Every one, not the first. The header used to show `chat.prs[0]` and the LIVE
 * worktrees only, so a long chat that shipped four PRs and had its worktrees
 * cleaned up behind it looked exactly like one that had done nothing at all.
 * What a chat actually produced is the most interesting thing this header
 * knows; it simply wasn't being asked for. Both are already persisted on the
 * chat (`Chat.worktrees`, `Chat.prs`), so none of this costs a fetch.
 */
function Roster({
  worktrees,
  prs,
  close,
}: {
  worktrees: ChatWorktreeRef[];
  prs: PRRef[];
  close: () => void;
}) {
  return (
    <div className="flex flex-col">
      {worktrees.length > 0 && (
        <>
          <SectionHead
            label={worktrees.length > 1 ? "Worktrees" : "Worktree"}
            count={worktrees.length}
          />
          {worktrees.map((w) => (
            <MenuItem
              key={w.path}
              dense={false}
              title={w.path}
              hint={worktreeHint(w)}
              icon={
                w.merged ? (
                  <GitMerge className="text-success" />
                ) : (
                  <GitBranch className={w.live ? "text-info-hi" : "text-faint"} />
                )
              }
              className={cn("cm-mono !text-xs", !w.live && "text-muted")}
              onClick={() => {
                openWorkspace("worktrees");
                close();
              }}
            >
              {w.branch}
            </MenuItem>
          ))}
        </>
      )}
      {prs.length > 0 && (
        <>
          <SectionHead
            label={prs.length > 1 ? "Pull requests" : "Pull request"}
            count={prs.length}
          />
          {prs.map((pr) => {
            const state = pr.state ?? "open";
            return (
              <MenuItem
                // Keyed by repo too: PR numbers restart at 1 per repository, so
                // the bare number is not unique on a chat that has shipped to
                // more than one of them.
                key={`${pr.repo ?? ""}#${pr.number}`}
                dense={false}
                title={pr.title}
                hint={state}
                icon={
                  state === "merged" ? (
                    <GitMerge className={PR_INK.merged} />
                  ) : (
                    <GitPullRequest className={PR_INK[state]} />
                  )
                }
                onClick={() => {
                  openWorkspace("prs");
                  close();
                }}
              >
                <span className="cm-mono !text-xs">#{pr.number}</span>
                {pr.title && <span className="ml-2 text-xs text-muted">{pr.title}</span>}
              </MenuItem>
            );
          })}
        </>
      )}
    </div>
  );
}

export interface ChatHeaderBadgesProps {
  /** Phone width: collapse to icons, put the words behind a tap. */
  compact: boolean;
  /** Every worktree this chat has owned, primary (live and unmerged) first. */
  worktrees: ChatWorktreeRef[];
  /** Every PR this chat has opened, most recently touched first. */
  prs: PRRef[];
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
 * behind a tap. The icons keep the three things worth a glance — that there IS
 * a worktree, how many, and whether the work landed (the tone) — and the
 * popover holds the whole roster.
 *
 * Both widths open the SAME roster, because "which PRs has this chat opened" is
 * not a phone question. The desktop chips stay the summary they always were;
 * they are now also the handle for the rest of it.
 */
export function ChatHeaderBadges({
  compact,
  worktrees,
  prs,
  exemptions,
  onRevokeExemption,
}: ChatHeaderBadgesProps) {
  // The exemption badge survives the early return the others share: a chat can
  // be running with a guard lifted and no worktree or PR yet — which is exactly
  // the state a `commit-on-trunk` or `pr-create-by-hand` lift leaves it in.
  const exempt = <ExemptionBadge exemptions={exemptions} onRevoke={onRevokeExemption} />;
  if (worktrees.length === 0 && prs.length === 0) return exempt;

  const primary = worktrees[0];
  const latestPr = prs[0];
  const prState = latestPr?.state ?? "open";

  return (
    <>
      {exempt}
      <Popover
        align="end"
        width={compact ? 290 : 340}
        className="p-1.5"
        trigger={({ open, toggle }) =>
          compact ? (
            // One target, not two. At this width a pair of 24px chips side by
            // side is two things to miss with a thumb; the cluster is a single
            // ≥44px hit that answers both questions in one panel.
            <Button
              size="md"
              onClick={toggle}
              aria-label={triggerLabel(worktrees.length, prs.length)}
              aria-expanded={open}
              className={cn("gap-3 px-2.5", open && "bg-elevated border-line-strong")}
            >
              {primary && (
                <CountedIcon
                  count={worktrees.length}
                  tone={primary.merged ? "success" : "info"}
                  icon={
                    primary.merged ? (
                      <GitMerge className="text-success" />
                    ) : (
                      <GitBranch className={primary.live ? "text-info-hi" : "text-faint"} />
                    )
                  }
                />
              )}
              {latestPr && (
                <CountedIcon
                  count={prs.length}
                  tone={PR_TONE[prState]}
                  icon={
                    prState === "merged" ? (
                      <GitMerge className={PR_INK.merged} />
                    ) : (
                      <GitPullRequest className={PR_INK[prState]} />
                    )
                  }
                />
              )}
            </Button>
          ) : (
            // `ghost`, because the chips already carry the whole look and the
            // kit's bordered box would draw a second frame around four things
            // that are each their own frame.
            //
            // The gaps are load-bearing. Each "+N" is tight against the chip
            // it counts (`gap-1`) and the two pairs are held apart (`gap-2.5`),
            // because evenly spaced there is nothing in `branch +2 #71 +2` to
            // say which +2 belongs to which — and two identical numbers is the
            // likeliest case, not the rarest.
            <Button
              variant="ghost"
              onClick={toggle}
              aria-label={triggerLabel(worktrees.length, prs.length)}
              aria-expanded={open}
              className={cn("gap-2.5 px-1", open && "bg-active")}
            >
              {primary && (
                <span className="flex items-center gap-1">
                  <Chip
                    // `muted` for the removed-and-unlanded case, which is
                    // reachable (a chat whose only worktree was cleaned up
                    // before its branch landed) and which a solid blue chip
                    // would report as live work you could go and open. The
                    // compact glyph and the roster's hint both already fade it.
                    tone={primary.merged ? "success" : primary.live ? "info" : "muted"}
                    icon={primary.merged ? <GitMerge /> : <GitBranch />}
                    mono
                  >
                    {primary.branch}
                  </Chip>
                  {worktrees.length > 1 && (
                    <Chip tone="muted" mono>
                      +{worktrees.length - 1}
                    </Chip>
                  )}
                </span>
              )}
              {latestPr && (
                <span className="flex items-center gap-1">
                  <Chip tone={PR_TONE[prState]} icon={<GitPullRequest />}>
                    #{latestPr.number}
                  </Chip>
                  {prs.length > 1 && (
                    <Chip tone="muted" mono>
                      +{prs.length - 1}
                    </Chip>
                  )}
                </span>
              )}
            </Button>
          )
        }
      >
        {(close) => <Roster worktrees={worktrees} prs={prs} close={close} />}
      </Popover>
    </>
  );
}
