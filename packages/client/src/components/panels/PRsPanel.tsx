import { useCallback, useEffect, useRef, useState } from "react";
import {
  GitPullRequest,
  GitMerge,
  Check,
  X,
  CircleDot,
  Clock,
  AlertTriangle,
  RotateCw,
  RefreshCw,
  Pause,
  Play,
  MessageSquare,
  Bot,
  Send,
  Tag,
  Plus,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import type {
  Chat,
  PRInfo,
  CheckRun,
  ReviewThread,
  ReviewDecision,
} from "@dispatch/shared";
import { usePanels } from "../../stores/panels.js";
import { actions } from "../../lib/actions.js";
import { api } from "../../lib/api.js";
import { worktreeMatchesChat } from "./panelBus.js";
import { GithubActionsSection } from "./GithubActionsPanel.js";
import { Chip, type Tone } from "../ui/Chip.js";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { Spinner } from "../ui/Spinner.js";
import { Popover } from "../ui/Popover.js";
import { SectionLabel } from "../ui/Panel.js";
import { cn } from "../../lib/cn.js";
import { relTime } from "../../lib/format.js";

/** Labels that hold a PR from the auto-merge job (house convention). */
const HOLD_LABELS = new Set(["hold", "no-automerge", "do-not-merge", "wip"]);

/** Track which gh op is in-flight so a click gives immediate feedback. */
function useBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const run = (op: string, fn: () => void) => {
    fn();
    setBusy(op);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setBusy(null), 1500);
  };
  return { busy, run };
}

/** How often the primary card re-pulls live PR detail while the PR is open. */
const PR_POLL_MS = 8000;

/**
 * Keep the chat's primary PR fresh from the rich `prDetail` endpoint (check
 * rollup + review decision + threads + comment count) — the list hydrate only
 * carries the lightweight fields. Fetches immediately, then polls while the PR is
 * open (a merged/closed PR is terminal, so no polling). Returns a live `refresh`
 * for the manual button. Each result is folded into the shared panel store, so
 * the card re-renders off one source of truth.
 */
function usePrDetailSync(projectId: string, primary: PRInfo | undefined) {
  const [refreshing, setRefreshing] = useState(false);
  const prNumber = primary?.number;
  const isOpen = primary?.state === "open";

  const refresh = useCallback(async () => {
    if (prNumber == null) return;
    setRefreshing(true);
    try {
      const detail = await api.github.prDetail(projectId, prNumber);
      if (detail) usePanels.getState().upsertPr(detail);
    } catch {
      /* best-effort — a failed gh read just keeps the last-known status */
    } finally {
      setRefreshing(false);
    }
  }, [projectId, prNumber]);

  useEffect(() => {
    if (prNumber == null) return;
    void refresh();
    if (!isOpen) return; // terminal PR — its status won't change
    const id = setInterval(() => void refresh(), PR_POLL_MS);
    return () => clearInterval(id);
  }, [refresh, isOpen, prNumber]);

  return { refreshing, refresh };
}

/* -------------------------------------------------------- check aggregation */

interface CheckSummary {
  passed: number;
  failed: number;
  pending: number;
  neutral: number;
  total: number;
}

/** A completed check that needs attention (failed / cancelled / action-required). */
function checkIsFailing(c: CheckRun): boolean {
  return (
    c.status === "completed" &&
    (c.conclusion === "failure" ||
      c.conclusion === "timed_out" ||
      c.conclusion === "cancelled" ||
      c.conclusion === "action_required")
  );
}

/** Fold a check list into pass/fail/pending/neutral counts for the rollup line. */
function summarizeChecks(checks: CheckRun[]): CheckSummary {
  const s: CheckSummary = { passed: 0, failed: 0, pending: 0, neutral: 0, total: checks.length };
  for (const c of checks) {
    if (c.status !== "completed") s.pending++;
    else if (c.conclusion === "success") s.passed++;
    else if (checkIsFailing(c)) s.failed++;
    else s.neutral++; // skipped / neutral / stale / null
  }
  return s;
}

/** The one-word rollup verdict + tone for a check summary. */
function checksVerdict(s: CheckSummary): { tone: Tone; label: string } {
  if (s.total === 0) return { tone: "muted", label: "no checks" };
  if (s.failed > 0) return { tone: "danger", label: "failing" };
  if (s.pending > 0) return { tone: "warn", label: "running" };
  return { tone: "success", label: "passing" };
}

/** Review-decision → chip (null/absent = awaiting, only meaningful while open). */
function reviewDecisionChip(
  d: ReviewDecision | null | undefined,
  open: boolean,
): { tone: Tone; label: string; Icon: LucideIcon } | null {
  switch (d) {
    case "approved":
      return { tone: "success", label: "approved", Icon: Check };
    case "changes_requested":
      return { tone: "danger", label: "changes requested", Icon: X };
    case "review_required":
      return { tone: "warn", label: "review required", Icon: CircleDot };
    default:
      return open ? { tone: "muted", label: "awaiting review", Icon: Clock } : null;
  }
}

/** Mergeable state → chip, folding in GitHub's mergeStateStatus (open PRs only). */
function mergeableChip(pr: PRInfo): { tone: Tone; label: string } | null {
  if (pr.state !== "open") return null;
  if (pr.mergeable === false) return { tone: "danger", label: "conflicts" };
  const st = (pr.mergeStateStatus ?? "").toUpperCase();
  if (st === "DIRTY") return { tone: "danger", label: "conflicts" };
  if (st === "BLOCKED") return { tone: "warn", label: "blocked" };
  if (st === "BEHIND") return { tone: "warn", label: "behind base" };
  if (st === "UNSTABLE") return { tone: "warn", label: "unstable" };
  if (pr.mergeable === true || st === "CLEAN" || st === "HAS_HOOKS") {
    return { tone: "success", label: "mergeable" };
  }
  return { tone: "muted", label: "checking…" };
}

/* -------------------------------------------------------------- check rows */

function checkVisual(check: CheckRun): { Icon: LucideIcon | null; spin: boolean; color: string } {
  if (check.status !== "completed") return { Icon: null, spin: true, color: "text-accent-hi" };
  switch (check.conclusion) {
    case "success":
      return { Icon: Check, spin: false, color: "text-success" };
    case "failure":
    case "timed_out":
      return { Icon: X, spin: false, color: "text-danger" };
    case "action_required":
      return { Icon: AlertTriangle, spin: false, color: "text-warn" };
    default:
      return { Icon: CircleDot, spin: false, color: "text-muted" };
  }
}

function CheckLine({ check }: { check: CheckRun }) {
  const { Icon, spin, color } = checkVisual(check);
  const inner = (
    <div className="flex items-center gap-2 py-1 text-[11.5px]">
      {spin ? <Spinner size={12} /> : Icon && <Icon className={cn("size-3.5", color)} />}
      <span className="min-w-0 flex-1 truncate text-secondary">{check.name}</span>
      <span className={cn("shrink-0 text-[10.5px]", color)}>
        {check.status !== "completed" ? "running" : (check.conclusion ?? "done")}
      </span>
    </div>
  );
  return check.url ? (
    <a href={check.url} target="_blank" rel="noopener noreferrer" className="block hover:bg-white/[0.02]">
      {inner}
    </a>
  ) : (
    inner
  );
}

/** One count in the rollup line — `<Icon> N`, hidden when zero. */
function CountPip({ n, Icon, color }: { n: number; Icon: LucideIcon; color: string }) {
  if (n <= 0) return null;
  return (
    <span className={cn("inline-flex items-center gap-0.5 tabular-nums", color)}>
      <Icon className="size-3.5" />
      {n}
    </span>
  );
}

/**
 * The build/checks block: a scannable rollup line (pass/fail/pending counts + a
 * verdict pill) that toggles the full per-check list. Failing checks stay visible
 * even when collapsed — they're the actionable ones — so a red build is never a
 * click away, while a green one folds to a single line.
 */
function ChecksSection({ checks }: { checks: CheckRun[] }) {
  const [open, setOpen] = useState(false);
  const summary = summarizeChecks(checks);
  const verdict = checksVerdict(summary);

  if (checks.length === 0) {
    return (
      <div className="flex items-center gap-2 border-t border-line-soft px-3 py-2">
        <CircleDot className="size-3.5 shrink-0 text-faint" />
        <SectionLabel className="px-0">Checks</SectionLabel>
        <span className="text-[11px] text-faint">none reported yet</span>
      </div>
    );
  }

  const failing = checks.filter(checkIsFailing);
  const visible = open ? checks : failing;

  return (
    <div className="border-t border-line-soft">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/[0.02]"
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")}
        />
        <SectionLabel className="px-0">Checks</SectionLabel>
        <span className="flex items-center gap-2 text-[11px]">
          <CountPip n={summary.passed} Icon={Check} color="text-success" />
          <CountPip n={summary.pending} Icon={Clock} color="text-warn" />
          <CountPip n={summary.failed} Icon={X} color="text-danger" />
          <CountPip n={summary.neutral} Icon={CircleDot} color="text-muted" />
        </span>
        <Chip tone={verdict.tone} className="ml-auto">
          {verdict.label}
        </Chip>
      </button>
      {visible.length > 0 && (
        <div className="px-3 pb-2">
          {visible.map((c) => (
            <CheckLine key={c.name} check={c} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ review threads */

function ThreadRow({ thread, onResolve, busy }: { thread: ReviewThread; onResolve: () => void; busy: boolean }) {
  return (
    <div className="flex items-start gap-2 py-1.5 text-[11px]">
      <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-warn" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[10px] text-faint">
          {thread.author && <span className="text-secondary">{thread.author}</span>}
          {thread.path && (
            <span className="cm-mono truncate">
              {thread.path}
              {thread.line != null ? `:${thread.line}` : ""}
            </span>
          )}
          {thread.isOutdated && <Chip tone="muted">outdated</Chip>}
        </span>
        {thread.body && <span className="mt-0.5 block leading-snug text-secondary line-clamp-3">{thread.body}</span>}
      </span>
      <Button size="xs" variant="ghost" disabled={busy} onClick={onResolve}>
        {busy ? <Spinner size={11} /> : "Resolve"}
      </Button>
    </div>
  );
}

/* --------------------------------------------------------------- labels */

function LabelsRow({ pr, chatId }: { pr: PRInfo; chatId: string }) {
  const labels = pr.labels ?? [];
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-line-soft px-3 py-2">
      <Tag className="size-3 text-faint" />
      {labels.length === 0 && <span className="text-[10.5px] text-faint">no labels</span>}
      {labels.map((l) => (
        <Chip key={l} tone={HOLD_LABELS.has(l) ? "warn" : "neutral"} className="group/label">
          {l}
          <button
            className="ml-0.5 text-faint hover:text-danger [&_svg]:size-2.5"
            title={`Remove ${l}`}
            onClick={() => actions.ghAction({ op: "unlabel", chatId, prNumber: pr.number, label: l })}
          >
            <X />
          </button>
        </Chip>
      ))}
      <Popover
        align="start"
        width={200}
        className="p-2"
        trigger={({ toggle }) => (
          <button
            onClick={toggle}
            className="inline-flex items-center gap-0.5 rounded-[5px] border border-dashed border-line px-1.5 py-px text-[10.5px] text-faint hover:border-line-strong hover:text-secondary [&_svg]:size-3"
          >
            <Plus />
            label
          </button>
        )}
      >
        {(close) => <AddLabelForm chatId={chatId} prNumber={pr.number} onDone={close} />}
      </Popover>
    </div>
  );
}

function AddLabelForm({ chatId, prNumber, onDone }: { chatId: string; prNumber: number; onDone: () => void }) {
  const [label, setLabel] = useState("");
  const submit = () => {
    const v = label.trim();
    if (!v) return;
    actions.ghAction({ op: "label", chatId, prNumber, label: v });
    onDone();
  };
  return (
    <div className="flex flex-col gap-2">
      <input
        autoFocus
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="hold"
        spellCheck={false}
        className="h-7 w-full rounded-md border border-line bg-inset px-2 text-[11.5px] text-primary outline-none placeholder:text-faint focus:border-line-strong"
      />
      <div className="flex items-center gap-1">
        {[...HOLD_LABELS].slice(0, 3).map((l) => (
          <button
            key={l}
            onClick={() => setLabel(l)}
            className="rounded-[5px] border border-line px-1.5 py-px text-[10px] text-secondary hover:border-line-strong"
          >
            {l}
          </button>
        ))}
        <Button size="xs" variant="primary" className="ml-auto" disabled={!label.trim()} onClick={submit}>
          Add
        </Button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- PR cards */

const STATE_TONE: Record<PRInfo["state"], Tone> = {
  open: "success",
  merged: "accent",
  closed: "danger",
};

function PrCard({
  pr,
  chatId,
  primary,
  refreshing,
  onRefresh,
}: {
  pr: PRInfo;
  chatId: string;
  primary?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const { busy, run } = useBusy();
  const threads = pr.reviewThreads ?? [];
  const unresolved = threads.filter((t) => !t.isResolved);
  const commentCount = pr.commentCount ?? 0;
  const Icon = pr.state === "merged" ? GitMerge : GitPullRequest;

  if (!primary) {
    return (
      <a
        href={pr.url && pr.url !== "#" ? pr.url : undefined}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 rounded-md border border-line bg-panel-2/40 px-2.5 py-2 transition-colors hover:border-line-strong"
      >
        <Icon className={cn("size-3.5 shrink-0", pr.state === "merged" ? "text-accent-hi" : "text-success")} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11.5px] text-secondary">{pr.title}</span>
          <span className="cm-mono !text-[10px] text-faint">
            #{pr.number} · {pr.updatedAt ? relTime(Date.parse(pr.updatedAt)) : ""}
          </span>
        </span>
        <span className="shrink-0 tabular-nums text-[10.5px] text-success">+{pr.additions ?? 0}</span>
        <span className="shrink-0 tabular-nums text-[10.5px] text-danger">−{pr.deletions ?? 0}</span>
      </a>
    );
  }

  const isOpen = pr.state === "open";
  const held = (pr.labels ?? []).some((l) => HOLD_LABELS.has(l));
  const hasFailed = pr.checks.some(checkIsFailing);
  const notMergeable = pr.mergeable === false;
  const review = reviewDecisionChip(pr.reviewDecision, isOpen);
  const merge = mergeableChip(pr);

  const gh = (op: Parameters<typeof actions.ghAction>[0]["op"]) =>
    run(op, () => actions.ghAction({ op, chatId, prNumber: pr.number }));

  return (
    <div className="overflow-hidden rounded-md border border-line bg-panel-2/50 cm-raise">
      <div className="px-3 py-2.5">
        <div className="flex items-start gap-2">
          <Icon className="mt-0.5 size-4 shrink-0 text-success" />
          <a
            href={pr.url && pr.url !== "#" ? pr.url : undefined}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 flex-1 text-[12.5px] font-medium leading-snug text-primary hover:text-accent-hi"
          >
            {pr.title}
          </a>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-6">
          <Chip tone={STATE_TONE[pr.state]}>{pr.isDraft ? "draft" : pr.state}</Chip>
          <Chip tone="muted" mono>
            #{pr.number}
          </Chip>
          <span className="cm-mono min-w-0 truncate !text-[10px] text-faint">
            {pr.branch} → {pr.baseBranch}
          </span>
        </div>
        {/* review verdict + mergeability + diff counts */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-6">
          {review && (
            <Chip tone={review.tone} icon={<review.Icon />}>
              {review.label}
            </Chip>
          )}
          {merge && <Chip tone={merge.tone}>{merge.label}</Chip>}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <span className="tabular-nums text-[10.5px] text-success">+{pr.additions ?? 0}</span>
            <span className="tabular-nums text-[10.5px] text-danger">−{pr.deletions ?? 0}</span>
          </span>
        </div>
      </div>

      <LabelsRow pr={pr} chatId={chatId} />

      {/* build / checks */}
      <ChecksSection checks={pr.checks} />

      {/* discussion: comment count + unresolved review threads */}
      {(commentCount > 0 || threads.length > 0) && (
        <div className="border-t border-line-soft px-3 py-2">
          <div className="flex items-center gap-1.5 text-[11px]">
            <MessageSquare className="size-3.5 shrink-0 text-muted" />
            {commentCount > 0 && (
              <span className="text-secondary">
                {commentCount} comment{commentCount === 1 ? "" : "s"}
              </span>
            )}
            {unresolved.length > 0 ? (
              <>
                {commentCount > 0 && <span className="text-faint">·</span>}
                <span className="text-warn">{unresolved.length} unresolved</span>
              </>
            ) : (
              threads.length > 0 && (
                <Chip tone="success" className="ml-auto">
                  threads resolved
                </Chip>
              )
            )}
          </div>
          {unresolved.length > 0 && (
            <div className="mt-1">
              {unresolved.map((t) => (
                <ThreadRow
                  key={t.id}
                  thread={t}
                  busy={busy === `resolve:${t.id}`}
                  onResolve={() =>
                    run(`resolve:${t.id}`, () =>
                      actions.ghAction({ op: "resolve-thread", chatId, threadId: t.id }),
                    )
                  }
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* actions */}
      <div className="flex items-center gap-1.5 border-t border-line-soft bg-inset/50 px-3 py-2">
        <Button
          size="xs"
          variant="primary"
          leftIcon={busy === "merge" ? <Spinner size={12} /> : <GitMerge />}
          disabled={!isOpen || pr.isDraft || notMergeable}
          title={notMergeable ? "Not mergeable yet" : undefined}
          onClick={() => gh("merge")}
        >
          Merge
        </Button>
        {held ? (
          <Button
            size="xs"
            variant="default"
            leftIcon={busy === "unhold" ? <Spinner size={12} /> : <Play />}
            disabled={!isOpen}
            onClick={() => gh("unhold")}
          >
            Unhold
          </Button>
        ) : (
          <Button
            size="xs"
            variant="default"
            leftIcon={busy === "hold" ? <Spinner size={12} /> : <Pause />}
            disabled={!isOpen}
            onClick={() => gh("hold")}
          >
            Hold
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          leftIcon={busy === "rerun" ? <Spinner size={12} /> : <RotateCw />}
          disabled={!hasFailed}
          title={hasFailed ? undefined : "No failed checks to rerun"}
          onClick={() => gh("rerun")}
        >
          Rerun
        </Button>
        <IconButton
          size="sm"
          tip="Re-request Copilot review"
          className="ml-auto"
          disabled={!isOpen}
          onClick={() => gh("review")}
        >
          {busy === "review" ? <Spinner size={12} /> : <Bot />}
        </IconButton>
        <IconButton
          size="sm"
          tip="Refresh status"
          disabled={refreshing}
          onClick={() => onRefresh?.()}
        >
          {refreshing ? <Spinner size={12} /> : <RefreshCw />}
        </IconButton>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- panel */

export function PRsPanel({ chat }: { chat: Chat }) {
  const prs = usePanels((s) => s.prs);
  const worktrees = usePanels((s) => s.worktrees);

  // Scope the panel to THIS chat's PRs. `prs` is the whole project's roster, so
  // an unscoped fallback would surface — and act on (Merge/Hold/Rerun) — a PR
  // belonging to a different chat. A PR is this chat's when its head branch is one
  // of the chat's OWNED worktree branches (the same branch↔chat correlation the
  // server heals), or when it's already persisted on the chat (covers a merged PR
  // whose worktree is gone). Only fall back to an owned PR of any state.
  const chatBranches = new Set<string>([
    ...worktrees.filter((w) => worktreeMatchesChat(w, chat)).map((w) => w.branch),
    ...chat.prs.map((p) => p.branch),
  ]);
  const chatPrNumbers = new Set(chat.prs.map((p) => p.number));
  const ownsPr = (p: PRInfo) =>
    chatPrNumbers.has(p.number) || chatBranches.has(p.branch);
  const primary =
    prs.find((p) => ownsPr(p) && p.state === "open") ?? prs.find(ownsPr);
  const history = prs.filter(
    (p) => ownsPr(p) && p.number !== primary?.number,
  );

  // Live-refresh the primary card's rich status (checks/decision/threads/counts).
  const { refreshing, refresh } = usePrDetailSync(chat.projectId, primary);

  const hasWorktree = chat.worktrees.length > 0;

  return (
    <div className="space-y-3 p-3">
      {primary ? (
        <PrCard
          pr={primary}
          chatId={chat.id}
          primary
          refreshing={refreshing}
          onRefresh={() => void refresh()}
        />
      ) : (
        <div className="rounded-md border border-dashed border-line px-3 py-6 text-center">
          <GitPullRequest className="mx-auto mb-1.5 size-5 text-faint" />
          <p className="text-[12px] text-muted">No open PR for this chat.</p>
          <p className="mt-0.5 text-[11px] text-faint">
            {hasWorktree ? "Ship the worktree to open one." : "Create a worktree first, then ship it."}
          </p>
          <Button
            size="sm"
            variant="default"
            className="mt-2.5"
            leftIcon={<Send />}
            disabled={!hasWorktree}
            onClick={() => actions.ghAction({ op: "ship", chatId: chat.id })}
          >
            Ship this worktree
          </Button>
        </div>
      )}

      <GithubActionsSection chat={chat} />

      {/* history */}
      {history.length > 0 && (
        <div>
          <SectionLabel className="mb-1 px-0.5">History</SectionLabel>
          <div className="space-y-1.5">
            {history.map((pr) => (
              <PrCard key={pr.number} pr={pr} chatId={chat.id} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
