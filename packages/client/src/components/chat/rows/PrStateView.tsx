/**
 * The shared way a pull request is DRAWN — one strip, one full panel, used by
 * every PR surface so they cannot drift into several dialects of the same facts.
 *
 * The split matters. The strip is what a transcript row can afford: a line of
 * chips answering "where is this PR" at a glance while a watch loop fires five
 * times. The panel is what the drilldown shows — the same facts plus the
 * per-JOB CI breakdown, every reviewer, and every unresolved thread, which are
 * the things you open a card to find out.
 */
import {
  AlertTriangle,
  Check,
  Circle,
  Clock,
  ExternalLink,
  GitPullRequest,
  Loader2,
  MessageSquare,
  X,
} from "lucide-react";
import {
  prReviewAgentView,
  type CheckRun,
  type PrReviewAgentState,
  type PrReviewer,
  type PrSnapshot,
  type ReviewThread,
} from "@dispatch/shared";
import { Chip, type Tone } from "../../ui/Chip.js";
import { ReviewAgentChip } from "../../pr/ReviewAgentChip.js";
import { cn } from "../../../lib/cn.js";
import { dur } from "../../../lib/format.js";
import { useNowTick } from "../../../stores/agentRun.js";

/* ------------------------------------------------------------------ pieces */

/** `+128 −40` — the size of the change, which is most of "should I look?". */
export function DiffSize({ pr, className }: { pr: PrSnapshot; className?: string }) {
  if (pr.additions === undefined && pr.deletions === undefined) return null;
  return (
    <span className={cn("cm-mono !text-2xs tabular-nums", className)}>
      <span className="text-success">+{pr.additions ?? 0}</span>{" "}
      <span className="text-danger">−{pr.deletions ?? 0}</span>
      {pr.changedFiles !== undefined && (
        <span className="text-faint">
          {" "}
          · {pr.changedFiles} file{pr.changedFiles === 1 ? "" : "s"}
        </span>
      )}
    </span>
  );
}

interface Rollup {
  pass: number;
  fail: number;
  running: number;
  total: number;
}

/** Fold jobs into pass/fail/running. A job still queued is NOT a pass. */
export function foldChecks(checks: CheckRun[]): Rollup {
  let pass = 0;
  let fail = 0;
  let running = 0;
  for (const c of checks) {
    if (c.status !== "completed") {
      running++;
      continue;
    }
    switch (c.conclusion) {
      case "failure":
      case "timed_out":
      case "cancelled":
      case "action_required":
        fail++;
        break;
      default:
        pass++;
    }
  }
  return { pass, fail, running, total: checks.length };
}

export function ChecksChip({ checks }: { checks: CheckRun[] }) {
  const { pass, fail, running, total } = foldChecks(checks);
  if (total === 0) return <Chip tone="neutral">no checks</Chip>;
  // Failure outranks in-flight: a red job is actionable now, and burying it
  // behind "2 running" is how a broken build goes unnoticed for a round.
  if (fail > 0) {
    return (
      <Chip tone="danger" icon={<X />}>
        {fail} failed
      </Chip>
    );
  }
  if (running > 0) {
    return (
      <Chip tone="accent" icon={<Clock />}>
        {running} running
      </Chip>
    );
  }
  return (
    <Chip tone="success" icon={<Check />}>
      {pass}/{total} passed
    </Chip>
  );
}

/** How a reviewer's state reads and colours — one mapping, used everywhere. */
export const REVIEWER_META: Record<PrReviewer["state"], { label: string; tone: Tone }> = {
  requested: { label: "requested", tone: "warn" },
  // The state the registry exists to surface: GitHub's spinner, made legible.
  // "Waiting on Copilot" and "Copilot is writing it now" are different
  // situations, and only one of them means the wait is nearly over.
  in_progress: { label: "reviewing…", tone: "accent" },
  approved: { label: "approved", tone: "success" },
  changes_requested: { label: "changes requested", tone: "danger" },
  commented: { label: "commented", tone: "neutral" },
  dismissed: { label: "dismissed", tone: "neutral" },
};

/** A login without the `[bot]` suffix, which is noise in a chip. */
export function reviewerName(login: string): string {
  return login.replace(/\[bot\]$/, "");
}

export function ReviewerChip({ reviewer }: { reviewer: PrReviewer }) {
  const meta = REVIEWER_META[reviewer.state];
  return (
    <Chip
      tone={meta.tone}
      icon={reviewer.state === "in_progress" ? <Loader2 className="animate-spin" /> : undefined}
      title={
        reviewer.stale
          ? `${reviewer.login} ${meta.label} — but on an older commit than the current head`
          : `${reviewer.login} ${meta.label}`
      }
    >
      {reviewerName(reviewer.login)} {meta.label}
      {reviewer.stale ? " (stale)" : ""}
    </Chip>
  );
}

/** Unresolved = open AND not outdated. An outdated thread is about gone code. */
export function unresolvedThreads(threads: ReviewThread[]): ReviewThread[] {
  return threads.filter((t) => !t.isResolved && !t.isOutdated);
}

/* ------------------------------------------------------------------- strip */

/**
 * The dense one-line state of a PR. Everything here fits on a transcript row;
 * anything that would not is in {@link PrStatePanel}.
 */
export function PrStateStrip({ pr, live }: { pr: PrSnapshot; live?: boolean }) {
  const open = pr.state === "open";
  const unresolved = unresolvedThreads(pr.threads).length;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="cm-mono !text-2xs text-muted">#{pr.number}</span>
      <DiffSize pr={pr} />
      {pr.state === "merged" && <Chip tone="accent">merged</Chip>}
      {pr.state === "closed" && <Chip tone="neutral">closed</Chip>}
      {pr.isDraft && <Chip tone="neutral">draft</Chip>}
      {pr.hold && <Chip tone="warn">hold</Chip>}
      {/* null means GitHub has not computed it yet, not "fine" — only an
          explicit false is a conflict. */}
      {open && pr.mergeable === false && (
        <Chip tone="danger" icon={<AlertTriangle />}>
          conflicts
        </Chip>
      )}
      {open && <ChecksChip checks={pr.checks} />}
      {pr.reviewDecision === "approved" && (
        <Chip tone="success" icon={<Check />}>
          approved
        </Chip>
      )}
      {pr.reviewDecision === "changes_requested" && <Chip tone="danger">changes requested</Chip>}
      {unresolved > 0 && (
        <Chip tone="warn" icon={<MessageSquare />}>
          {unresolved} unresolved
        </Chip>
      )}
      {open && pr.reviewers.map((r) => <ReviewerChip key={r.login} reviewer={r} />)}
      {/* Says which clock this is on. A watch card tracks the PR as it stands;
          every other card is a record of a moment, and conflating the two is
          how a transcript starts lying about the past. */}
      {live && (
        <span className="ml-auto flex items-center gap-1 cm-mono !text-2xs text-faint">
          <Circle className="size-1.5 fill-success text-success" /> live
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- panel */

/**
 * When a job started and stopped, in epoch ms.
 *
 * A job still in flight ends at `now` only when the panel is LIVE. A frozen
 * snapshot's running job stopped being observed when the tool returned, so
 * ticking it forward would invent a runtime nobody measured. It gets no end,
 * and draws no duration.
 */
function jobSpan(check: CheckRun, now: number | null): { start: number; end?: number } | null {
  // GitHub stamps `startedAt` on a job the moment it is QUEUED (seen on this
  // repo's own PRs), so a queued job's "runtime" would be time spent waiting
  // for a runner. It has not run; it gets no span.
  if (check.status === "queued") return null;
  const start = check.startedAt ? Date.parse(check.startedAt) : Number.NaN;
  if (Number.isNaN(start)) return null;
  const done = check.completedAt ? Date.parse(check.completedAt) : Number.NaN;
  if (!Number.isNaN(done)) return { start, end: done };
  return { start, end: check.status !== "completed" && now !== null ? now : undefined };
}

/**
 * Wall-clock runtime of a set of jobs: first start to last finish.
 *
 * Not the sum. Jobs in a workflow run in parallel, and four parallel jobs
 * summed into "CI took 11m" is a wait nobody sat through. Undefined when a job
 * has no end yet on a frozen snapshot, rather than a total that quietly leaves
 * the slowest job out.
 */
function wallClock(checks: CheckRun[], now: number | null): number | undefined {
  let first = Infinity;
  let last = -Infinity;
  for (const check of checks) {
    const span = jobSpan(check, now);
    if (!span) continue;
    if (span.end === undefined) return undefined;
    first = Math.min(first, span.start);
    last = Math.max(last, span.end);
  }
  return last >= first ? last - first : undefined;
}

function JobRow({ check, now }: { check: CheckRun; now: number | null }) {
  const done = check.status === "completed";
  const failed =
    done &&
    (check.conclusion === "failure" ||
      check.conclusion === "timed_out" ||
      check.conclusion === "cancelled" ||
      check.conclusion === "action_required");
  const icon = !done ? (
    <Loader2 className="size-3 shrink-0 animate-spin text-accent-hi" />
  ) : failed ? (
    <X className="size-3 shrink-0 text-danger" />
  ) : (
    <Check className="size-3 shrink-0 text-success" />
  );
  const span = jobSpan(check, now);
  const runtime = span?.end !== undefined ? dur(Math.max(0, span.end - span.start)) : null;
  const body = (
    <>
      {icon}
      <span className={cn("min-w-0 flex-1 truncate", failed && "text-danger")}>{check.name}</span>
      <span className="shrink-0 cm-mono !text-2xs text-faint">
        {done ? (check.conclusion ?? "done") : check.status.replace("_", " ")}
      </span>
      {/* Fixed width so durations line up into a column down the list:
          comparing job times is the reason to show them at all. */}
      <span
        className={cn(
          "w-14 shrink-0 text-right cm-mono !text-2xs tabular-nums",
          done ? "text-muted" : "text-accent-hi",
        )}
        title={check.startedAt ? `Started ${new Date(check.startedAt).toLocaleString()}` : undefined}
      >
        {runtime ?? "—"}
      </span>
    </>
  );
  const className =
    "flex items-center gap-2 rounded px-1.5 py-1 text-xs text-secondary transition-colors hover:bg-hover/30";
  return check.url ? (
    <a href={check.url} target="_blank" rel="noopener noreferrer" className={className}>
      {body}
      <ExternalLink className="size-3 shrink-0 text-faint" />
    </a>
  ) : (
    <div className={className}>
      {body}
      <span className="size-3 shrink-0" />
    </div>
  );
}

/** Jobs grouped under their workflow, the way the Actions tab groups them. */
function ChecksSection({ checks, now }: { checks: CheckRun[]; now: number | null }) {
  if (checks.length === 0) {
    return <p className="text-xs text-muted">No checks are reporting on this PR.</p>;
  }
  const groups = new Map<string, CheckRun[]>();
  for (const check of checks) {
    const key = check.workflowName ?? "";
    const list = groups.get(key);
    if (list) list.push(check);
    else groups.set(key, [check]);
  }
  return (
    <div className="flex flex-col gap-2">
      {[...groups.entries()].map(([workflow, jobs]) => {
        const total = wallClock(jobs, now);
        return (
          <div key={workflow || "ungrouped"}>
            {workflow && (
              <p className="mb-0.5 flex items-center gap-2 px-1.5 cm-mono !text-2xs uppercase tracking-wide text-faint">
                <span className="min-w-0 flex-1 truncate">{workflow}</span>
                {total !== undefined && (
                  <span className="shrink-0 normal-case tabular-nums">{dur(total)}</span>
                )}
                <span className="size-3 shrink-0" />
              </p>
            )}
            <div className="flex flex-col">
              {jobs.map((job) => (
                <JobRow key={`${workflow}:${job.name}`} check={job} now={now} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-center gap-2 text-2xs font-medium uppercase tracking-wide text-faint">
        <span className="min-w-0 flex-1">{title}</span>
        {aside}
      </p>
      {children}
    </div>
  );
}

/**
 * The full picture: everything the strip shows, plus the detail it cannot.
 *
 * `reviewAgent` is passed separately because it lives on the registry ROW, not
 * the snapshot — a frozen tool result never carries it, so only a live card can
 * say what Dispatch's own reviewer is doing.
 */
export function PrStatePanel({
  pr,
  reviewAgent,
  live = false,
}: {
  pr: PrSnapshot;
  reviewAgent?: PrReviewAgentState;
  /** Whether `pr` is the registry's current row, which lets running jobs tick. */
  live?: boolean;
}) {
  const unresolved = unresolvedThreads(pr.threads);
  const link = pr.url && pr.url !== "#" ? pr.url : undefined;
  const { fail: failing, running } = foldChecks(pr.checks);
  // Ticks only while something is running on a live row, so a settled panel
  // does not re-render every second for a number that can no longer change.
  const tick = useNowTick(live && running > 0);
  const now = live ? tick : null;
  const ciTotal = wallClock(pr.checks, now);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start gap-2">
          <GitPullRequest className="mt-0.5 size-4 shrink-0 text-success" />
          {link ? (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1 text-sm font-medium leading-snug text-primary hover:text-accent-hi"
            >
              {pr.title || pr.branch}
            </a>
          ) : (
            <span className="min-w-0 flex-1 text-sm font-medium leading-snug text-primary">
              {pr.title || pr.branch}
            </span>
          )}
        </div>
        <p className="cm-mono !text-2xs text-faint">
          {pr.branch} → {pr.baseBranch || "?"}
          {pr.author ? ` · by ${pr.author}` : ""}
          {pr.headRefOid ? ` · ${pr.headRefOid.slice(0, 7)}` : ""}
        </p>
        <PrStateStrip pr={pr} />
        {pr.labels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {pr.labels.map((l) => (
              <Chip key={l} tone="muted">
                {l}
              </Chip>
            ))}
          </div>
        )}
      </div>

      <Section
        title={`Checks${pr.checks.length ? ` (${pr.checks.length}${failing ? `, ${failing} failing` : ""})` : ""}`}
        aside={
          ciTotal !== undefined && (
            <span
              className="shrink-0 pr-[1.625rem] cm-mono !text-2xs normal-case tracking-normal tabular-nums text-muted"
              title="Wall clock from the first job starting to the last one finishing"
            >
              {dur(ciTotal)}
            </span>
          )
        }
      >
        <ChecksSection checks={pr.checks} now={now} />
      </Section>

      <Section title="Reviewers">
        {pr.reviewers.length === 0 && !prReviewAgentView(reviewAgent) ? (
          <p className="text-xs text-muted">Nobody is queued to review this PR.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {pr.reviewers.map((r) => (
              <ReviewerChip key={r.login} reviewer={r} />
            ))}
            <ReviewAgentChip state={reviewAgent} />
          </div>
        )}
      </Section>

      <Section title={`Unresolved threads${unresolved.length ? ` (${unresolved.length})` : ""}`}>
        {unresolved.length === 0 ? (
          <p className="text-xs text-muted">Nothing outstanding.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {unresolved.map((t) => (
              <a
                key={t.id}
                href={t.url}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "rounded border border-line bg-inset px-2 py-1.5 transition-colors",
                  t.url && "hover:border-line-strong",
                )}
              >
                <p className="cm-mono !text-2xs text-faint">
                  {t.author ?? "reviewer"}
                  {t.path ? ` · ${t.path}${t.line ? `:${t.line}` : ""}` : ""}
                </p>
                {t.body && (
                  <p className="mt-0.5 line-clamp-3 text-xs leading-snug text-secondary">{t.body}</p>
                )}
              </a>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
