/**
 * ProjectPRsView — the GLOBAL, project-wide open-PR roster. Unlike the per-chat
 * PRsPanel (which scopes to a single chat's PR), this overlay lists EVERY open PR
 * for the active project via `GET /api/github/project-prs` so you can see + act on
 * the whole board from one place. Mounted once in App; opens on the
 * `cm:open-project-prs` window event (command palette / top-bar affordance).
 *
 * Each PR renders its number, title, branch→base, draft state, a folded check
 * rollup, review decision, comment count, labels, updated time, an external link,
 * and quick actions (Merge / Hold·Unhold) that reuse the exact `gh-action`
 * dispatcher (`actions.ghAction`, projectId-scoped — no chat needed). Fetch is
 * local to the overlay; a Refresh button + a short post-action reload keep it
 * current. Design tokens are the shared Linear/Zed set (Chip/Button/Modal).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  GitPullRequest,
  GitMerge,
  Check,
  X,
  Clock,
  AlertTriangle,
  RefreshCw,
  Pause,
  Play,
  MessageSquare,
  ExternalLink,
  Tag,
  type LucideIcon,
} from "lucide-react";
import type { PRInfo, CheckRun, ReviewDecision } from "@cm/shared";
import { Modal, InlineError } from "../sidebar/Modal.js";
import { Button } from "../ui/Button.js";
import { Chip, type Tone } from "../ui/Chip.js";
import { Spinner } from "../ui/Spinner.js";
import { api } from "../../lib/api.js";
import { actions } from "../../lib/actions.js";
import { useProjects } from "../../stores/projects.js";
import { relTime } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";
import { OPEN_PROJECT_PRS_EVENT } from "./projectPrsBus.js";

/** Labels that hold a PR from the auto-merge job (house convention). */
const HOLD_LABELS = new Set(["hold", "no-automerge", "do-not-merge", "wip"]);

/** After a click, wait this long for the async gh-action to land, then reload. */
const RELOAD_AFTER_ACTION_MS = 1300;

/* ------------------------------------------------------------- check rollup */

interface Rollup {
  pass: number;
  fail: number;
  run: number;
  total: number;
}

/** Fold a PR's checks into pass/fail/running counts. */
function foldChecks(checks: CheckRun[]): Rollup {
  let pass = 0;
  let fail = 0;
  let run = 0;
  for (const c of checks) {
    if (c.status !== "completed") {
      run++;
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
        // success / neutral / skipped / stale / null-complete → treat as passing.
        pass++;
    }
  }
  return { pass, fail, run, total: checks.length };
}

function ChecksChip({ checks }: { checks: CheckRun[] }) {
  const { pass, fail, run, total } = foldChecks(checks);
  if (total === 0) return <Chip tone="muted">no checks</Chip>;
  if (fail > 0)
    return (
      <Chip tone="danger" icon={<X />}>
        {fail} failed
      </Chip>
    );
  if (run > 0)
    return (
      <Chip tone="accent" icon={<Clock />}>
        {run} running
      </Chip>
    );
  return (
    <Chip tone="success" icon={<Check />}>
      {pass}/{total} passed
    </Chip>
  );
}

/* ---------------------------------------------------------- review decision */

const REVIEW_META: Record<
  ReviewDecision,
  { tone: Tone; label: string; Icon: LucideIcon | null }
> = {
  approved: { tone: "success", label: "approved", Icon: Check },
  changes_requested: { tone: "danger", label: "changes requested", Icon: AlertTriangle },
  review_required: { tone: "warn", label: "review required", Icon: null },
};

function ReviewChip({ decision }: { decision: ReviewDecision | null | undefined }) {
  if (!decision) return <Chip tone="muted">review pending</Chip>;
  const m = REVIEW_META[decision];
  return (
    <Chip tone={m.tone} icon={m.Icon ? <m.Icon /> : undefined}>
      {m.label}
    </Chip>
  );
}

/* ----------------------------------------------------------------- PR row */

function PrRow({
  pr,
  busy,
  onAction,
}: {
  pr: PRInfo;
  busy: (op: string) => boolean;
  onAction: (op: "merge" | "hold" | "unhold", prNumber: number) => void;
}) {
  const labels = pr.labels ?? [];
  const held = labels.some((l) => HOLD_LABELS.has(l));
  const link = pr.url && pr.url !== "#" ? pr.url : undefined;

  return (
    <div className="rounded-md border border-line bg-panel-2/40 px-3 py-2.5 transition-colors hover:border-line-strong">
      {/* title row */}
      <div className="flex items-start gap-2">
        <GitPullRequest className="mt-0.5 size-4 shrink-0 text-success" />
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-snug text-primary hover:text-accent-hi"
        >
          {pr.title}
        </a>
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            title="Open on GitHub"
            className="shrink-0 text-faint transition-colors hover:text-secondary [&_svg]:size-3.5"
          >
            <ExternalLink />
          </a>
        )}
      </div>

      {/* meta row */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-6">
        <Chip tone="muted" mono>
          #{pr.number}
        </Chip>
        {pr.isDraft && <Chip tone="muted">draft</Chip>}
        <span className="cm-mono !text-[10px] text-faint">
          {pr.branch} → {pr.baseBranch}
        </span>
        {pr.author && <span className="text-[10.5px] text-faint">by {pr.author}</span>}
        <span className="ml-auto text-[10.5px] text-faint">
          {pr.updatedAt ? relTime(Date.parse(pr.updatedAt)) : ""}
        </span>
      </div>

      {/* status row */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-6">
        <ChecksChip checks={pr.checks} />
        <ReviewChip decision={pr.reviewDecision} />
        {(pr.commentCount ?? 0) > 0 && (
          <span className="inline-flex items-center gap-1 text-[10.5px] text-muted [&_svg]:size-3">
            <MessageSquare />
            {pr.commentCount}
          </span>
        )}
        {labels.length > 0 && (
          <span className="inline-flex flex-wrap items-center gap-1">
            <Tag className="size-3 text-faint" />
            {labels.map((l) => (
              <Chip key={l} tone={HOLD_LABELS.has(l) ? "warn" : "neutral"}>
                {l}
              </Chip>
            ))}
          </span>
        )}
      </div>

      {/* actions row */}
      <div className="mt-2.5 flex items-center gap-1.5 border-t border-line-soft pt-2 pl-6">
        <Button
          size="xs"
          variant="primary"
          leftIcon={busy("merge") ? <Spinner size={12} /> : <GitMerge />}
          disabled={pr.isDraft || held}
          title={pr.isDraft ? "Draft — mark ready first" : held ? "Held — unhold to merge" : undefined}
          onClick={() => onAction("merge", pr.number)}
        >
          Merge
        </Button>
        {held ? (
          <Button
            size="xs"
            variant="default"
            leftIcon={busy("unhold") ? <Spinner size={12} /> : <Play />}
            onClick={() => onAction("unhold", pr.number)}
          >
            Unhold
          </Button>
        ) : (
          <Button
            size="xs"
            variant="default"
            leftIcon={busy("hold") ? <Spinner size={12} /> : <Pause />}
            onClick={() => onAction("hold", pr.number)}
          >
            Hold
          </Button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ overlay */

export function ProjectPRsView() {
  const [open, setOpen] = useState(false);
  const project = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null);
  const projectId = project?.id;

  const [prs, setPrs] = useState<PRInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  // Open on the app-wide event (command palette / top-bar affordance).
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_PROJECT_PRS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_PROJECT_PRS_EVENT, onOpen);
  }, []);

  const load = useCallback(async () => {
    if (!projectId) {
      setPrs([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await api.github.projectPrs(projectId);
      setPrs(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // (Re)fetch whenever the overlay opens or the active project changes while open.
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // NOTE: no live pr-update reconciliation here. `usePanels.prs` is a GLOBAL,
  // cross-project store keyed by PR number ALONE — and PR numbers restart at #1 per
  // repo — so folding it in by number let a background action in another project's
  // PR #N overwrite or drop this project's PR #N. The overlay already refetches on
  // open, on Refresh, and shortly after every action, so a scoped refetch is the
  // only safe source of truth.
  const runAction = useCallback(
    (op: "merge" | "hold" | "unhold", prNumber: number) => {
      if (!projectId) return;
      const key = `${prNumber}:${op}`;
      setBusy((b) => ({ ...b, [key]: true }));
      actions.ghAction({ op, projectId, prNumber });
      window.setTimeout(() => {
        void load();
        setBusy((b) => {
          const next = { ...b };
          delete next[key];
          return next;
        });
      }, RELOAD_AFTER_ACTION_MS);
    },
    [projectId, load],
  );

  const sorted = useMemo(
    () =>
      [...prs].sort((a, b) => {
        const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
        const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
        return tb - ta;
      }),
    [prs],
  );

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      width={620}
      icon={<GitPullRequest />}
      title="Open pull requests"
      description={project ? `All open PRs in ${project.name}` : "No project selected"}
      footer={
        <>
          {error ? (
            <div className="mr-auto min-w-0 flex-1">
              <InlineError message={error} />
            </div>
          ) : (
            <span className="mr-auto text-[11px] text-muted tabular-nums">
              {loading ? "Loading…" : `${sorted.length} open`}
            </span>
          )}
          <Button
            variant="default"
            leftIcon={loading ? <Spinner size={12} /> : <RefreshCw />}
            disabled={loading || !projectId}
            onClick={() => void load()}
          >
            Refresh
          </Button>
        </>
      }
    >
      {!projectId ? (
        <div className="rounded-md border border-dashed border-line px-3 py-10 text-center">
          <GitPullRequest className="mx-auto mb-1.5 size-5 text-faint" />
          <p className="text-[12px] text-muted">No active project.</p>
          <p className="mt-0.5 text-[11px] text-faint">Pick a project to see its open PRs.</p>
        </div>
      ) : loading && sorted.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-12 text-[12px] text-muted">
          <Spinner size={14} /> Loading pull requests…
        </div>
      ) : sorted.length === 0 ? (
        <div className="rounded-md border border-dashed border-line px-3 py-10 text-center">
          <GitPullRequest className="mx-auto mb-1.5 size-5 text-faint" />
          <p className="text-[12px] text-muted">No open pull requests.</p>
          <p className="mt-0.5 text-[11px] text-faint">Ship a worktree to open one.</p>
        </div>
      ) : (
        <div className={cn("space-y-2", loading && "opacity-70")}>
          {sorted.map((pr) => (
            <PrRow
              key={pr.number}
              pr={pr}
              busy={(op) => !!busy[`${pr.number}:${op}`]}
              onAction={runAction}
            />
          ))}
        </div>
      )}
    </Modal>
  );
}
