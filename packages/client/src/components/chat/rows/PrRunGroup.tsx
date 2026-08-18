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
import { memo, useMemo, useState } from "react";
import { Check, Circle, GitPullRequest, X } from "lucide-react";
import {
  decodePrToolPayload,
  prRecordKey,
  type PrSnapshot,
  type PrToolPayload,
  type TaskStatusRow,
  type ToolResultRow,
  type ToolUseRow,
} from "@dispatch/shared";
import { RowShell } from "./RowShell.js";
import { PrStatePanel, PrStateStrip } from "./PrStateView.js";
import { Modal } from "../../sidebar/Modal.js";
import { CodeBlock } from "../CodeBlock.js";
import { Button } from "../../ui/Button.js";
import { Chip } from "../../ui/Chip.js";
import { OverflowTooltip } from "../../ui/OverflowTooltip.js";
import { Spinner } from "../../ui/Spinner.js";
import { cn } from "../../../lib/cn.js";
import { dur, parseMcpName, safeJson } from "../../../lib/format.js";
import { hydrateFullRows } from "../../../stores/index.js";
import { usePrs } from "../../../stores/prs.js";
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
  approve_pr: "merge",
};

function StateMark({ state }: { state: ToolDetailState }) {
  if (state === "running") return <Spinner size={10} />;
  if (state === "failed") return <X className="text-danger" />;
  if (state === "stopped") return <Circle className="text-muted" />;
  return <Check className="text-success" />;
}

/**
 * The PR a card should draw, and whether it is live.
 *
 * `watch_pr` prefers the registry row — that tool exists to tell you where the
 * PR is NOW, and a watch card showing a two-minute-old snapshot while the
 * roster three feet away shows the merge is the kind of disagreement that makes
 * people stop trusting both. Everything else takes the frozen copy.
 */
function useCardPr(payload: PrToolPayload | null): { pr: PrSnapshot | null; live: boolean } {
  const frozen = payload?.pr ?? null;
  const wantsLive = payload?.tool === "watch_pr" && !!frozen;
  const liveRow = usePrs((s) =>
    wantsLive && frozen ? s.byKey[prRecordKey(frozen.repo, frozen.number)] : undefined,
  );
  if (wantsLive && liveRow) return { pr: liveRow, live: true };
  return { pr: frozen, live: false };
}

function PrToolCard({ entry }: { entry: PrRunEntry }) {
  const [open, setOpen] = useState(false);
  const tool = parseMcpName(entry.use.name)?.tool ?? "pull request";
  const state = toolCallState(entry.result, entry.task);
  const raw = entry.result ? displayResultText(entry.result.content) : "";
  const { payload, text } = useMemo(() => decodePrToolPayload(raw), [raw]);
  const { pr, live } = useCardPr(payload);

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
        icon={<GitPullRequest />}
        title={payload?.outcome.summary ?? (VERB[tool] ?? tool)}
        description={pr ? `${pr.repo}#${pr.number}${live ? " · live" : " · as of this call"}` : tool}
      >
        <div className="flex flex-col gap-4">
          {payload && payload.outcome.details.length > 0 && (
            <ul className="flex flex-col gap-1">
              {payload.outcome.details.map((line, i) => (
                <li key={i} className="text-xs leading-snug text-secondary">
                  · {line}
                </li>
              ))}
            </ul>
          )}
          {pr ? (
            <PrStatePanel pr={pr} />
          ) : (
            <p className="text-xs text-muted">
              No pull-request state was recorded for this call.
            </p>
          )}
          <details className="rounded-md border border-line bg-inset">
            <summary className="cursor-pointer px-2.5 py-1.5 text-2xs uppercase tracking-wide text-faint">
              Raw exchange
            </summary>
            <div className="flex flex-col gap-2 p-2.5 pt-0">
              <CodeBlock code={safeJson(entry.use.input)} language="json" />
              <CodeBlock code={text || "No response"} />
            </div>
          </details>
        </div>
      </Modal>
    </>
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
      </div>
    </RowShell>
  );
});
