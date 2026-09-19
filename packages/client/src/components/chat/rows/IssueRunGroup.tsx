/**
 * Issue tool calls, as cards rather than terminal exchanges — the issue twin
 * of `PrRunGroup`, built the same way for the same reason.
 *
 * These used to render as a generic dispatch card whose two-line receipt was
 * the tool's prose: a provenance line and the opening of a fence, written for
 * the model. Nothing there told a person which issue was read, who opened it,
 * or what was said back. So each call draws the issue's STATE on its row, and
 * the drilldown shows the body, the thread and what the tool did.
 *
 * Every card here is a record of a moment: the snapshot frozen into the result
 * is what is drawn, never a re-read. Scrolling back to an `issue_read` from
 * last week must not quietly restate it as today's labels.
 */
import { memo, useMemo, useState } from "react";
import { CircleDot } from "lucide-react";
import {
  decodeIssueToolPayload,
  type IssueToolPayload,
  type TaskStatusRow,
  type ToolResultRow,
  type ToolUseRow,
} from "@dispatch/shared";
import { RowShell } from "./RowShell.js";
import { ResultMediaStrip } from "./ResultMediaStrip.js";
import { IssueListPanel, IssueStatePanel, IssueStateStrip } from "./IssueStateView.js";
import { OutcomeCard, RawExchange, StateMark } from "./ToolCardBits.js";
import { Modal } from "../../sidebar/Modal.js";
import { Button } from "../../ui/Button.js";
import { Chip } from "../../ui/Chip.js";
import { OverflowTooltip } from "../../ui/OverflowTooltip.js";
import { cn } from "../../../lib/cn.js";
import { dur, parseMcpName } from "../../../lib/format.js";
import { hydrateFullRows } from "../../../stores/index.js";
import { displayResultText } from "../../../lib/toolPresentations.js";
import { toolCallState } from "../../../lib/toolState.js";

export interface IssueRunEntry {
  use: ToolUseRow;
  result?: ToolResultRow;
  task?: TaskStatusRow;
}

/** What each tool calls itself in the card's prompt column. */
const VERB: Record<string, string> = {
  issue_list: "list",
  issue_read: "read",
  issue_comment: "comment",
  issue_update: "update",
};

/** The prompt for `issue_update` says what KIND of update: close, reopen, or label. */
function verbFor(tool: string, input: Record<string, unknown>): string {
  if (tool === "issue_update") {
    if (input.state === "closed") return "close";
    if (input.state === "open") return "reopen";
  }
  return VERB[tool] ?? tool;
}

function issueNumber(input: Record<string, unknown>): number | null {
  const n = input.number;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

function IssueToolCard({ entry }: { entry: IssueRunEntry }) {
  const [open, setOpen] = useState(false);
  const tool = parseMcpName(entry.use.name)?.tool ?? "issue";
  const state = toolCallState(entry.result, entry.task);
  const raw = entry.result ? displayResultText(entry.result.content) : "";
  const { payload, text } = useMemo(() => decodeIssueToolPayload(raw), [raw]);
  const issue = payload?.issue ?? null;
  const number = issue?.number ?? issueNumber(entry.use.input);
  const verb = verbFor(tool, entry.use.input);

  const summary =
    payload?.outcome.summary ??
    (state === "running"
      ? `${verb}${number ? ` #${number}` : ""}…`
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
      <div data-row-id={entry.use.id} className="group/issue border-b border-line-soft last:border-b-0">
        <Button
          type="button"
          variant="ghost"
          onClick={inspect}
          className="!flex !h-auto min-h-0 w-full min-w-0 flex-col items-stretch gap-1 !whitespace-normal !rounded-none !border-0 px-2.5 py-1.5 text-left !font-normal hover:!bg-hover/20 active:translate-y-0"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 cm-mono !text-xs font-semibold text-info-hi">{verb} &gt;</span>
            <OverflowTooltip
              text={summary}
              className={cn("min-w-0 flex-1 truncate text-xs text-secondary", failed && "text-danger")}
            />
            <span className="flex shrink-0 items-center gap-1.5 cm-mono !text-2xs text-faint [&_svg]:size-3">
              {elapsed !== undefined && <span>{dur(elapsed)}</span>}
              <StateMark state={failed ? "failed" : state} />
            </span>
          </span>
          {/* The dense state line — the issue's, or for a list, how many came
              back. Absent when the tool could not read one at all. */}
          {issue ? (
            <IssueStateStrip issue={issue} />
          ) : (
            payload?.issues && <ListStrip payload={payload} />
          )}
        </Button>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        width={640}
        icon={<CircleDot />}
        title={payload?.outcome.summary ?? (number ? `${verb} issue #${number}` : verb)}
        description={issue ? `#${issue.number} · as of this call` : tool}
      >
        <div className="flex flex-col gap-4">
          {payload && tool !== "issue_read" && (
            <OutcomeCard outcome={payload.outcome} elapsed={elapsed} />
          )}
          {issue ? (
            <IssueStatePanel
              issue={issue}
              comments={payload?.comments}
              commentCount={payload?.commentCount}
              posted={tool === "issue_comment" ? new Set(payload?.comments?.map((c) => c.id)) : undefined}
            />
          ) : payload?.issues ? (
            <IssueListPanel issues={payload.issues} />
          ) : (
            <p className="text-xs text-muted">
              {state === "running"
                ? "Still reading the tracker."
                : "The tool could not read this issue, so there is no state to show."}
            </p>
          )}
          <RawExchange input={entry.use.input} response={text} running={state === "running"} />
        </div>
      </Modal>
    </>
  );
}

/** The strip for a list: a count, and the first few labels it was filtered on. */
function ListStrip({ payload }: { payload: IssueToolPayload }) {
  const issues = payload.issues ?? [];
  const open = issues.filter((i) => i.state === "open").length;
  const closed = issues.length - open;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Chip tone="neutral">{issues.length} issue{issues.length === 1 ? "" : "s"}</Chip>
      {open > 0 && closed > 0 && (
        <span className="cm-mono !text-2xs text-faint">
          {open} open · {closed} closed
        </span>
      )}
    </div>
  );
}

/** A run of adjacent issue calls, framed as one issue card. */
export const IssueRunGroup = memo(function IssueRunGroup({ entries }: { entries: IssueRunEntry[] }) {
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
          <CircleDot />
        </span>
      }
    >
      <div className="overflow-hidden rounded-md border border-line bg-panel-2/60">
        <div className="flex h-8 items-center gap-2 border-b border-line-soft px-2.5">
          <span className="text-sm font-semibold text-primary">Issue</span>
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
            <IssueToolCard key={entry.use.id} entry={entry} />
          ))}
        </div>
        <ResultMediaStrip chatId={entries[0]?.use.chatId ?? ""} results={entries.map((e) => e.result)} />
      </div>
    </RowShell>
  );
});
