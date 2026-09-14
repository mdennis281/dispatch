/**
 * PR tool calls, as cards rather than terminal exchanges.
 *
 * These used to render inside the shell frame behind a `pr >` prompt, which
 * described them wrongly in every respect: nothing here is a command, the
 * interesting content is a pull request's STATE rather than an output stream,
 * and the frame's two-line receipt had nowhere to put a title, a diff size or a
 * list of jobs. So they get their own run.
 *
 * What each card shows follows from what its tool is FOR:
 *
 *   - `watch_pr` is about the present, so its strip prefers the live registry
 *     row and says `live`.
 *   - every other tool is a record of a moment — a PR opened, a thread
 *     resolved, a merge refused — so its strip renders the snapshot frozen into
 *     the result and never re-reads. Scrolling back to last Tuesday's
 *     `create_pr` must not quietly restate it as today's CI.
 *
 * The drilldown is the SAME panel for all of them. "Where is this PR at" is one
 * question with one answer, and giving each tool its own dialect of it was the
 * thing worth avoiding.
 */
import { memo, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronRight, Circle, Eye, GitPullRequest, X } from "lucide-react";
import {
  decodePrToolPayload,
  prRecordKey,
  WATCH_PR_DEFAULT_TIMEOUT_SECONDS,
  WATCH_PR_POLL_INTERVAL_MS,
  WATCH_PR_TIMEOUT_CAP_SECONDS,
  type PrRecord,
  type PrSnapshot,
  type PrToolPayload,
  type TaskStatusRow,
  type ToolResultRow,
  type ToolUseRow,
} from "@dispatch/shared";
import { RowShell } from "./RowShell.js";
import { ResultMediaStrip } from "./ResultMediaStrip.js";
import { PrStatePanel, PrStateStrip } from "./PrStateView.js";
import { Modal } from "../../sidebar/Modal.js";
import { CodeBlock } from "../CodeBlock.js";
import { Button } from "../../ui/Button.js";
import { Chip } from "../../ui/Chip.js";
import { OverflowTooltip } from "../../ui/OverflowTooltip.js";
import { Spinner } from "../../ui/Spinner.js";
import { cn } from "../../../lib/cn.js";
import { dur, parseMcpName, relTime, safeJson, untilShort } from "../../../lib/format.js";
import { hydrateFullRows } from "../../../stores/index.js";
import { useNowTick } from "../../../stores/agentRun.js";
import { usePrs } from "../../../stores/prs.js";
import { useChats } from "../../../stores/chats.js";
import { displayResultText } from "../../../lib/toolPresentations.js";
import { toolCallState } from "../../../lib/toolState.js";
import type { ToolDetailState } from "../ToolDetailModal.js";

export interface PrRunEntry {
  use: ToolUseRow;
  result?: ToolResultRow;
  task?: TaskStatusRow;
}

/** What each tool calls itself in the card's prompt column. */
const VERB: Record<string, string> = {
  create_pr: "open",
  watch_pr: "watch",
  resolve_thread: "resolve",
  request_review: "request review",
  post_review: "review",
  approve_pr: "merge",
};

function StateMark({ state }: { state: ToolDetailState }) {
  if (state === "running") return <Spinner size={10} />;
  if (state === "failed") return <X className="text-danger" />;
  if (state === "stopped") return <Circle className="text-muted" />;
  return <Check className="text-success" />;
}

/** The PR a `watch_pr` call names in its input — all a still-running watch has. */
function watchTarget(input: Record<string, unknown>): { number: number; repo?: string } | null {
  const number = typeof input.number === "number" ? input.number : Number.NaN;
  if (!Number.isInteger(number) || number <= 0) return null;
  const repo = typeof input.repo === "string" && input.repo.trim() ? input.repo.trim() : undefined;
  return { number, repo };
}

/**
 * Find the registry row for a PR named by number and maybe repo.
 *
 * `watch_pr` usually omits `repo` (it defaults to the chat's checkout), and the
 * store is keyed `owner/repo#number` because numbers restart per repository. So
 * a bare number resolves to the row THIS chat opened first, then to the one row
 * with that number in the watching chat's PROJECT — the server resolves it
 * against that project's checkout. Never across the whole catalog: low numbers
 * collide between projects, and a card confidently drawing another repo's #12
 * as `live` is worse than drawing nothing. `PrRecord.chatId` is the chat that
 * OPENED the PR, so a parent watching its child's PR only matches by project.
 * Returns the stored object, so it is safe to select directly.
 */
function findRecord(
  byKey: Record<string, PrRecord>,
  target: { number: number; repo?: string },
  chatId: string,
  projectId: string | undefined,
): PrRecord | undefined {
  if (target.repo) return byKey[prRecordKey(target.repo, target.number)];
  const rows = Object.values(byKey).filter((r) => r.number === target.number);
  const owned = rows.find((r) => r.chatId === chatId);
  if (owned || !projectId) return owned;
  const inProject = rows.filter((r) => r.projectId === projectId);
  return inProject.length === 1 ? inProject[0] : undefined;
}

/**
 * The PR a card should draw, and whether it is live.
 *
 * `watch_pr` prefers the registry row — that tool exists to tell you where the
 * PR is NOW, and a watch card showing a two-minute-old snapshot while the
 * roster three feet away shows the merge is the kind of disagreement that makes
 * people stop trusting both. Everything else takes the frozen copy.
 *
 * A watch still in flight has no result, hence no frozen snapshot, and used to
 * draw "No pull-request state was recorded" for the whole half hour it blocked —
 * exactly when someone opens it to ask what it is waiting on. So the row is
 * resolved from the call's INPUT when there is no result to read it from.
 */
function useCardPr(
  entry: PrRunEntry,
  tool: string,
  payload: PrToolPayload | null,
): { pr: PrSnapshot | null; record?: PrRecord; live: boolean } {
  const frozen = payload?.pr ?? null;
  const target =
    tool !== "watch_pr"
      ? null
      : frozen
        ? { number: frozen.number, repo: frozen.repo }
        : watchTarget(entry.use.input);
  const projectId = useChats((s) => s.byId[entry.use.chatId]?.projectId);
  const record = usePrs((s) =>
    target ? findRecord(s.byKey, target, entry.use.chatId, projectId) : undefined,
  );
  if (record) return { pr: record, record, live: true };
  return { pr: frozen, live: false };
}

function PrToolCard({ entry }: { entry: PrRunEntry }) {
  const [open, setOpen] = useState(false);
  const tool = parseMcpName(entry.use.name)?.tool ?? "pull request";
  const state = toolCallState(entry.result, entry.task);
  const raw = entry.result ? displayResultText(entry.result.content) : "";
  const { payload, text } = useMemo(() => decodePrToolPayload(raw), [raw]);
  const { pr, record, live } = useCardPr(entry, tool, payload);

  const summary =
    payload?.outcome.summary ??
    (state === "running"
      ? `${VERB[tool] ?? tool}${pr ? ` #${pr.number}` : ""}…`
      : text.split("\n").find((line) => line.trim()) ?? "No response");
  const failed = state === "failed" || payload?.outcome.ok === false;
  const elapsed = entry.task?.durationMs ?? entry.result?.durationMs;
  const clipped = Boolean(entry.use.inputOmitted) || Boolean(entry.result?.contentOmitted);

  const inspect = () => {
    if (clipped) {
      const ids: string[] = [];
      if (entry.use.inputOmitted) ids.push(entry.use.id);
      if (entry.result?.contentOmitted) ids.push(entry.result.id);
      void hydrateFullRows(entry.use.chatId, ids);
    }
    setOpen(true);
  };

  return (
    <>
      <div
        data-row-id={entry.use.id}
        className="group/pr border-b border-line-soft last:border-b-0"
      >
        <Button
          type="button"
          variant="ghost"
          onClick={inspect}
          className="!flex !h-auto min-h-0 w-full min-w-0 flex-col items-stretch gap-1 !whitespace-normal !rounded-none !border-0 px-2.5 py-1.5 text-left !font-normal hover:!bg-hover/20 active:translate-y-0"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 cm-mono !text-xs font-semibold text-info-hi">
              {VERB[tool] ?? tool} &gt;
            </span>
            <OverflowTooltip
              text={summary}
              className={cn(
                "min-w-0 flex-1 truncate text-xs text-secondary",
                failed && "text-danger",
              )}
            />
            <span className="flex shrink-0 items-center gap-1.5 cm-mono !text-2xs text-faint [&_svg]:size-3">
              {elapsed !== undefined && <span>{dur(elapsed)}</span>}
              <StateMark state={failed ? "failed" : state} />
            </span>
          </span>
          {/* The dense state line. Absent only when the tool could not read the
              PR at all, where inventing one would be worse than saying less. */}
          {pr && <PrStateStrip pr={pr} live={live} />}
        </Button>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        width={640}
        icon={tool === "watch_pr" ? <Eye /> : <GitPullRequest />}
        title={modalTitle(tool, state, payload, pr, entry.use.input)}
        description={
          pr ? `${pr.repo}#${pr.number}${live ? " · live" : " · as of this call"}` : tool
        }
      >
        <div className="flex flex-col gap-4">
          {tool === "watch_pr" ? (
            <WatchStatus
              entry={entry}
              state={failed ? "failed" : state}
              payload={payload}
              record={record}
            />
          ) : (
            payload && <OutcomeCard payload={payload} elapsed={elapsed} />
          )}
          {pr ? (
            <PrStatePanel pr={pr} reviewAgent={record?.reviewAgent} live={live} />
          ) : (
            <p className="text-xs text-muted">
              {state === "running"
                ? "Dispatch's PR catalog has no row for this PR in this project, so its state appears when the watch returns."
                : "The tool could not read this pull request, so there is no state to show."}
            </p>
          )}
          <RawExchange input={entry.use.input} response={text} running={state === "running"} />
        </div>
      </Modal>
    </>
  );
}

/** "Watching PR #367" while it blocks; the outcome headline once it answers. */
function modalTitle(
  tool: string,
  state: ToolDetailState,
  payload: PrToolPayload | null,
  pr: PrSnapshot | null,
  input: Record<string, unknown>,
): string {
  if (payload) return payload.outcome.summary;
  const number = pr?.number ?? watchTarget(input)?.number;
  if (tool === "watch_pr" && state === "running") {
    return number ? `Watching PR #${number}` : "Watching a pull request";
  }
  const verb = VERB[tool] ?? tool;
  return number ? `${verb} PR #${number}` : verb;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-2xs uppercase tracking-wide text-faint">{label}</dt>
      <dd className="min-w-0 truncate cm-mono !text-xs text-secondary">{children}</dd>
    </div>
  );
}

function DetailLines({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 border-t border-line-soft pt-2">
      {lines.map((line, i) => (
        <li key={i} className="text-xs leading-snug text-secondary">
          {line}
        </li>
      ))}
    </ul>
  );
}

/** What a one-shot PR tool did — the headline, whether it worked, and why. */
function OutcomeCard({ payload, elapsed }: { payload: PrToolPayload; elapsed?: number }) {
  const ok = payload.outcome.ok;
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border bg-inset px-3 py-2.5",
        ok ? "border-line" : "border-danger/40",
      )}
    >
      <div className="flex items-center gap-2 [&_svg]:size-3.5">
        {ok ? <Check className="text-success" /> : <X className="text-danger" />}
        <span className={cn("min-w-0 flex-1 text-sm", ok ? "text-primary" : "text-danger")}>
          {payload.outcome.summary}
        </span>
        {elapsed !== undefined && (
          <span className="shrink-0 cm-mono !text-2xs text-faint">{dur(elapsed)}</span>
        )}
      </div>
      <DetailLines lines={payload.outcome.details} />
    </div>
  );
}

/**
 * The watch itself: how long it has blocked, when it gives up, and whether the
 * polls behind it are landing.
 *
 * The deadline is re-derived from the call's input with the server's own
 * default and cap (shared constants), because a running call has nothing else
 * to read.
 *
 * It shows the row's last CHANGE, not its last poll, on purpose: a quiet poll is
 * persisted but never published (announcing one would wake every client every
 * 30s), so a client-side `lastPolledAt` freezes at the last change and a healthy
 * quiet watch would read "last poll 15m ago" as if it had stalled. Poll failures
 * ARE published, so `pollError` is trustworthy.
 */
function WatchStatus({
  entry,
  state,
  payload,
  record,
}: {
  entry: PrRunEntry;
  state: ToolDetailState;
  payload: PrToolPayload | null;
  record?: PrRecord;
}) {
  const running = state === "running";
  const now = useNowTick(running);
  const requested = entry.use.input.timeoutSeconds;
  const timeoutMs =
    Math.min(
      Math.max(
        typeof requested === "number" && Number.isFinite(requested)
          ? requested
          : WATCH_PR_DEFAULT_TIMEOUT_SECONDS,
        0,
      ),
      WATCH_PR_TIMEOUT_CAP_SECONDS,
    ) * 1000;
  const elapsed = running
    ? now - entry.use.ts
    : (entry.task?.durationMs ?? entry.result?.durationMs);
  const ok = state !== "failed" && payload?.outcome.ok !== false;
  const headline = running
    ? "Waiting for something actionable"
    : (payload?.outcome.summary ?? (state === "stopped" ? "Watch stopped" : "Watch returned"));

  return (
    <div
      className={cn(
        "flex flex-col gap-2.5 rounded-md border bg-inset px-3 py-2.5",
        running ? "border-accent/40" : ok ? "border-line" : "border-danger/40",
      )}
    >
      <div className="flex items-center gap-2 [&_svg]:size-3.5">
        <StateMark state={state} />
        <span className={cn("min-w-0 flex-1 text-sm", ok ? "text-primary" : "text-danger")}>
          {headline}
        </span>
      </div>

      <dl className="grid grid-cols-4 gap-x-4 gap-y-2">
        <Fact label={running ? "Watching for" : "Watched for"}>{dur(elapsed) ?? "—"}</Fact>
        <Fact label={running ? "Gives up in" : "Quiet window"}>
          {running ? untilShort(entry.use.ts + timeoutMs, now) : dur(timeoutMs)}
        </Fact>
        <Fact label="Polls every">{dur(WATCH_PR_POLL_INTERVAL_MS)}</Fact>
        <Fact label="Last change">
          {record?.lastChangedAt ? relTime(record.lastChangedAt, now) : "—"}
        </Fact>
      </dl>

      {running && record?.pollError && (
        <p className="text-xs text-danger">Last poll failed: {record.pollError}</p>
      )}

      {running ? (
        <p className="border-t border-line-soft pt-2 text-xs leading-snug text-muted">
          Returns the moment a check fails, every check passes, a new review comment lands, no
          reviewer is left queued, or the PR merges or closes. If nothing happens for{" "}
          {dur(timeoutMs)} it returns anyway and the agent calls it again.
        </p>
      ) : (
        payload && <DetailLines lines={payload.outcome.details} />
      )}
    </div>
  );
}

/**
 * The call as the model saw it, collapsed. Labelled Request/Response because the
 * prose answer is not code — the block's default language used to call it
 * "TypeScript".
 */
function RawExchange({
  input,
  response,
  running,
}: {
  input: Record<string, unknown>;
  response: string;
  running: boolean;
}) {
  return (
    <details className="group rounded-md border border-line-soft">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2.5 py-1.5 text-2xs uppercase tracking-wide text-faint outline-none hover:text-secondary focus-visible:ring-1 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
        Raw exchange
      </summary>
      <div className="flex flex-col px-2.5 pb-1">
        <CodeBlock code={safeJson(input)} language="json" filename="Request" />
        <CodeBlock
          code={response || (running ? "No response yet — the watch is still running." : "No response")}
          language="text"
          filename="Response"
        />
      </div>
    </details>
  );
}

/** A run of adjacent PR calls, framed as one pull-request card. */
export const PrRunGroup = memo(function PrRunGroup({ entries }: { entries: PrRunEntry[] }) {
  const states = entries.map((e) => toolCallState(e.result, e.task));
  const tone = states.includes("running")
    ? ("accent" as const)
    : states.includes("failed")
      ? ("danger" as const)
      : ("success" as const);
  return (
    <RowShell
      gutter={
        <span className="flex size-6 items-center justify-center rounded-md bg-info-ghost text-info-hi ring-1 ring-info-line [&_svg]:size-3.5">
          <GitPullRequest />
        </span>
      }
    >
      <div className="overflow-hidden rounded-md border border-line bg-panel-2/60">
        <div className="flex h-8 items-center gap-2 border-b border-line-soft px-2.5">
          <span className="text-sm font-semibold text-primary">Pull request</span>
          <span className="cm-mono !text-2xs text-faint">
            {entries.length} step{entries.length === 1 ? "" : "s"}
          </span>
          <span className="ml-auto">
            <Chip tone={tone}>
              {states.includes("running") ? "working" : states.includes("failed") ? "failed" : "ok"}
            </Chip>
          </span>
        </div>
        <div>
          {entries.map((entry) => (
            <PrToolCard key={entry.use.id} entry={entry} />
          ))}
        </div>
        <ResultMediaStrip
          chatId={entries[0]?.use.chatId ?? ""}
          results={entries.map((e) => e.result)}
        />
      </div>
    </RowShell>
  );
});
