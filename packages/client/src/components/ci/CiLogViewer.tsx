/**
 * One job's log, inline under the job in the run detail.
 *
 * Fetched only when opened (a log can be megabytes), keyed on the job's status
 * so a job that finishes while you're looking gets its log without a manual
 * reload. Groups (`##[group]`) collapse like they do on GitHub; a group holding
 * an error opens by itself, because that is the one you came for.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight, ExternalLink, Search, X } from "lucide-react";
import type { CiJob } from "@dispatch/shared";
import { api } from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { IconButton } from "../ui/IconButton.js";
import { Spinner } from "../ui/Spinner.js";
import { RowButton } from "../ui/RowButton.js";
import { CiSectionError } from "./CiBits.js";
import { firstLineAt, flattenLog, parseLog, type LogBlock, type LogLine } from "./ciModel.js";
import { useResource } from "./useResource.js";

/**
 * Lines rendered before "show earlier". A 2MB test log is ~30k lines; laying
 * all of them out on open costs seconds on a phone, and the failure is at the
 * bottom anyway.
 */
const TAIL_LINES = 3000;
const MAX_MATCHES = 2000;

/** Number of the first line inside the default tail window. */
function tailStart(lines: LogLine[]): number {
  return lines[lines.length - TAIL_LINES]?.n ?? 0;
}

const KIND_CLS: Record<LogLine["kind"], string> = {
  plain: "",
  error: "bg-danger-ghost text-danger",
  warning: "bg-warn-ghost text-warn",
  notice: "text-info-hi",
  command: "text-accent-2-hi",
  debug: "text-faint",
};

function Line({ line, jobId, mark }: { line: LogLine; jobId: number; mark?: boolean }) {
  return (
    <div
      id={`ci-log-${jobId}-L${line.n}`}
      className={cn(
        "flex min-w-0 scroll-mt-10 hover:bg-hover/60",
        KIND_CLS[line.kind],
        mark && "outline outline-1 -outline-offset-1 outline-accent-line",
      )}
    >
      <span className="w-12 shrink-0 select-none pr-3 text-right text-faint/70">{line.n}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{line.text || " "}</span>
    </div>
  );
}

export function CiLogViewer({
  projectId,
  job,
  focusStep,
  focusSeq = 0,
}: {
  projectId: string;
  job: CiJob;
  /** Step number to scroll to once the log is in. */
  focusStep: number | null;
  /** Bumped on every step click, so clicking the same step again re-jumps. */
  focusSeq?: number;
}) {
  const log = useResource(`${job.id}:${job.status}`, () => api.ci.jobLog(projectId, job.id));
  const blocks = useMemo(() => (log.data?.available ? parseLog(log.data.text) : []), [log.data]);
  const lines = useMemo(() => flattenLog(blocks), [blocks]);

  const [open, setOpen] = useState<Set<number>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [target, setTarget] = useState<number | null>(null);
  // A line still to be scrolled to. Separate from `target` (which only marks
  // the line) so the scroll happens ONCE per jump: the effect below also has
  // to re-run when a group opens or the tail expands — the line may not be in
  // the DOM until then — and without this it re-scrolled every time the reader
  // toggled any group afterwards.
  const pendingScroll = useRef<number | null>(null);
  const jumpTo = (n: number) => {
    pendingScroll.current = n;
    setTarget(n);
  };
  const scroller = useRef<HTMLDivElement>(null);

  // Open every group with an error in it; reset when a new log arrives.
  useEffect(() => {
    const next = new Set<number>();
    for (const b of blocks) {
      if (b.type === "group" && b.lines.some((l) => l.kind === "error")) next.add(b.title.n);
    }
    setOpen(next);
    setShowAll(false);
  }, [blocks]);

  // Jump to a step: open its group, make sure it's rendered, then scroll.
  //
  // Keyed on the step's start STRING, never on `job.steps`: a live run's jobs
  // are re-fetched every few seconds, each poll is a fresh array, and an effect
  // on it re-ran the jump on every poll — yanking the scroll back to the step
  // and reopening a group the reader had just collapsed.
  const focusStartedAt =
    focusStep === null ? null : (job.steps.find((s) => s.number === focusStep)?.startedAt ?? null);
  useEffect(() => {
    if (focusStep === null || !lines.length) return;
    const n = firstLineAt(lines, focusStartedAt);
    if (n === null) return;
    const group = blocks.find(
      (b) => b.type === "group" && (b.title.n === n || b.lines.some((l) => l.n === n)),
    );
    if (group?.type === "group") setOpen((s) => new Set(s).add(group.title.n));
    if (lines.length > TAIL_LINES && n < tailStart(lines)) setShowAll(true);
    jumpTo(n);
  }, [focusStep, focusSeq, focusStartedAt, lines, blocks]);

  useEffect(() => {
    const n = pendingScroll.current;
    if (n === null) return;
    const el = document.getElementById(`ci-log-${job.id}-L${n}`);
    const box = scroller.current;
    // The scroller is `relative`, so it IS the offsetParent of every line.
    if (el && box) {
      box.scrollTop = el.offsetTop - 8;
      pendingScroll.current = null;
    }
  }, [target, open, showAll, job.id]);

  // Default view: the tail. Blocks are trimmed whole so a group never loses
  // its title.
  const { visible, hidden } = useMemo(() => {
    if (showAll || lines.length <= TAIL_LINES) return { visible: blocks, hidden: 0 };
    const cutoff = tailStart(lines);
    const kept: LogBlock[] = [];
    let hiddenCount = 0;
    for (const b of blocks) {
      const last = b.type === "line" ? b.line.n : (b.lines[b.lines.length - 1]?.n ?? b.title.n);
      if (last < cutoff) hiddenCount += b.type === "line" ? 1 : b.lines.length + 1;
      else kept.push(b);
    }
    return { visible: kept, hidden: hiddenCount };
  }, [blocks, lines, showAll]);

  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () => (q ? lines.filter((l) => l.text.toLowerCase().includes(q)) : []),
    [lines, q],
  );

  const toggle = (n: number) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  let body: ReactNode;
  if (!log.data && log.loading) {
    body = (
      <div className="flex items-center gap-2 px-3 py-3 text-xs text-faint">
        <Spinner size={12} /> Fetching log…
      </div>
    );
  } else if (!log.data && log.error) {
    body = (
      <div className="p-2">
        <CiSectionError message={log.error} onRetry={() => void log.reload()} slim />
      </div>
    );
  } else if (log.data && !log.data.available) {
    body = (
      <p className="px-3 py-3 text-xs text-faint">
        {job.status === "completed"
          ? "No log was kept for this job."
          : "The log becomes available when the job finishes."}
      </p>
    );
  } else if (q) {
    body = matches.length ? (
      matches.slice(0, MAX_MATCHES).map((l) => (
        <RowButton
          key={l.n}
          type="button"
          className="block w-full text-left"
          onClick={() => {
            setQuery("");
            setSearching(false);
            const group = blocks.find((b) => b.type === "group" && b.lines.some((x) => x.n === l.n));
            if (group?.type === "group") setOpen((s) => new Set(s).add(group.title.n));
            if (lines.length > TAIL_LINES && l.n < tailStart(lines)) setShowAll(true);
            jumpTo(l.n);
          }}
        >
          <Line line={l} jobId={-job.id} />
        </RowButton>
      ))
    ) : (
      <p className="px-3 py-3 text-xs text-faint">No lines match “{query.trim()}”.</p>
    );
  } else {
    body = (
      <>
        {hidden > 0 && (
          <RowButton
            type="button"
            onClick={() => setShowAll(true)}
            className="block w-full border-b border-line-soft px-3 py-1.5 text-left text-2xs text-accent-hi hover:bg-hover"
          >
            Show {hidden.toLocaleString()} earlier line{hidden === 1 ? "" : "s"}
          </RowButton>
        )}
        {visible.map((b) =>
          b.type === "line" ? (
            <Line key={b.line.n} line={b.line} jobId={job.id} mark={b.line.n === target} />
          ) : (
            <div key={b.title.n}>
              <RowButton
                type="button"
                onClick={() => toggle(b.title.n)}
                aria-expanded={open.has(b.title.n)}
                className="block w-full text-left"
              >
                <div
                  id={`ci-log-${job.id}-L${b.title.n}`}
                  className={cn(
                    "flex min-w-0 scroll-mt-10 font-medium text-secondary hover:bg-hover/60",
                    b.title.n === target && "outline outline-1 -outline-offset-1 outline-accent-line",
                  )}
                >
                  <span className="flex w-12 shrink-0 select-none items-center justify-end gap-0.5 pr-3 text-faint/70">
                    <ChevronRight
                      className={cn("size-3 transition-transform", open.has(b.title.n) && "rotate-90")}
                    />
                    {b.title.n}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{b.title.text}</span>
                  {b.lines.some((l) => l.kind === "error") && (
                    <span className="mr-2 shrink-0 text-danger">error</span>
                  )}
                </div>
              </RowButton>
              {open.has(b.title.n) &&
                b.lines.map((l) => (
                  <Line key={l.n} line={l} jobId={job.id} mark={l.n === target} />
                ))}
            </div>
          ),
        )}
      </>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-line bg-inset">
      <div className="flex h-8 items-center gap-1.5 border-b border-line-soft px-2">
        {searching ? (
          <>
            <Search className="size-3.5 shrink-0 text-faint" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("");
                  setSearching(false);
                }
              }}
              placeholder="Find in log"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-xs text-primary outline-none placeholder:text-faint"
            />
            {q && (
              <span className="shrink-0 text-2xs text-faint">
                {matches.length > MAX_MATCHES ? `${MAX_MATCHES}+` : matches.length}
              </span>
            )}
            <IconButton
              tip="Close search"
              onClick={() => {
                setQuery("");
                setSearching(false);
              }}
            >
              <X />
            </IconButton>
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-2xs text-faint">
              {log.data?.available
                ? `${lines.length.toLocaleString()} lines${log.data.truncated ? " · showing the end of a long log" : ""}`
                : "Log"}
            </span>
            {log.refreshing && <Spinner size={11} />}
            {log.data?.available && (
              <IconButton tip="Find in log" onClick={() => setSearching(true)}>
                <Search />
              </IconButton>
            )}
            {job.url && (
              <a
                href={job.url}
                target="_blank"
                rel="noopener noreferrer"
                title="Open on GitHub"
                aria-label="Open on GitHub"
                className="inline-flex size-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-primary [&_svg]:size-3.5"
              >
                <ExternalLink />
              </a>
            )}
          </>
        )}
      </div>
      <div
        ref={scroller}
        className="cm-scroll cm-mono relative max-h-[min(60vh,560px)] overflow-auto py-1 text-xs leading-[1.55] text-secondary"
      >
        {body}
      </div>
    </div>
  );
}
