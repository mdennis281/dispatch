/**
 * The CI/CD page's pure logic — status visuals, durations, list merging and
 * the job-log parser — kept out of the components so the client's node-env
 * vitest can cover it without a DOM.
 */
import {
  AlertTriangle,
  Ban,
  Check,
  CircleDashed,
  CircleDot,
  Clock,
  Minus,
  X,
  type LucideIcon,
} from "lucide-react";
import type { CiConclusion, CiRun, CiStatus } from "@dispatch/shared";

/* ---------------------------------------------------------------- visuals */

export type CiTone = "success" | "danger" | "warn" | "muted" | "accent";

export interface CiVisual {
  Icon: LucideIcon;
  /** Still going — render a spinner instead of the icon. */
  spin: boolean;
  tone: CiTone;
  /** Tailwind text colour for the tone. */
  color: string;
  label: string;
}

const COLOR: Record<CiTone, string> = {
  success: "text-success",
  danger: "text-danger",
  warn: "text-warn",
  muted: "text-muted",
  accent: "text-accent-hi",
};

function v(Icon: LucideIcon, tone: CiTone, label: string, spin = false): CiVisual {
  return { Icon, spin, tone, color: COLOR[tone], label };
}

/** Icon, colour and words for anything with a status + conclusion: run, job or step. */
export function ciVisual(x: { status: CiStatus; conclusion: CiConclusion | null }): CiVisual {
  switch (x.status) {
    case "in_progress":
      return v(Clock, "accent", "In progress", true);
    case "queued":
    case "requested":
    case "pending":
      return v(CircleDashed, "accent", "Queued");
    case "waiting":
      // Parked on an environment approval — the one non-terminal state that
      // needs a human, so it reads warn rather than "busy".
      return v(Clock, "warn", "Waiting");
    case "completed":
      break;
  }
  switch (x.conclusion) {
    case "success":
      return v(Check, "success", "Success");
    case "failure":
      return v(X, "danger", "Failed");
    case "timed_out":
      return v(X, "danger", "Timed out");
    case "action_required":
      return v(AlertTriangle, "warn", "Action required");
    case "cancelled":
      return v(Ban, "muted", "Cancelled");
    case "skipped":
      return v(Minus, "muted", "Skipped");
    case "stale":
      return v(Minus, "muted", "Stale");
    default:
      return v(CircleDot, "muted", "Completed");
  }
}

/* -------------------------------------------------------------- durations */

/**
 * Elapsed ms between two ISO stamps, or up to `now` when `end` is missing and
 * the thing is still going. `undefined` when there is nothing honest to show.
 */
export function ciElapsed(
  start: string | null | undefined,
  end: string | null | undefined,
  active: boolean,
  now = Date.now(),
): number | undefined {
  if (!start) return undefined;
  const s = Date.parse(start);
  if (Number.isNaN(s)) return undefined;
  const e = end ? Date.parse(end) : active ? now : NaN;
  if (Number.isNaN(e) || e < s) return undefined;
  return e - s;
}

/**
 * A run's duration. A run has no `completedAt`; the API's `updated_at` is the
 * last state change, which for a finished run IS when it finished.
 */
export function runElapsed(run: CiRun, now = Date.now()): number | undefined {
  const active = run.status !== "completed";
  return ciElapsed(run.startedAt ?? run.createdAt, active ? null : run.updatedAt, active, now);
}

/* ---------------------------------------------------------------- filters */

export type RunStatusFilter = "all" | "active" | "failure" | "success";

/**
 * The status filter as the API takes it. "active" is `in_progress` alone: the
 * API filters on one value, and a queued run becomes in-progress within seconds
 * — the alternative was firing four requests per refresh to cover a state
 * nobody sits in.
 */
export function statusParam(f: RunStatusFilter): string | undefined {
  switch (f) {
    case "all":
      return undefined;
    case "active":
      return "in_progress";
    default:
      return f;
  }
}

/* ---------------------------------------------------------- list merging */

/**
 * Fold a refreshed first page into a list that may already hold several pages.
 *
 * A poll refetches page 1 only; replacing the list with it would throw away
 * everything "Load more" fetched and yank the scroll position. So: fresh rows
 * win by id, new ones go on top, and the older tail stays where it was.
 */
export function mergeRuns(current: CiRun[], fresh: CiRun[]): CiRun[] {
  const freshIds = new Set(fresh.map((r) => r.id));
  const tail = current.filter((r) => !freshIds.has(r.id));
  return [...fresh, ...tail].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id,
  );
}

/** Append a further page, dropping rows already shown (runs shift between pages). */
export function appendRuns(current: CiRun[], next: CiRun[]): CiRun[] {
  const seen = new Set(current.map((r) => r.id));
  return [...current, ...next.filter((r) => !seen.has(r.id))];
}

/* -------------------------------------------------------------------- logs */

export type LogKind = "plain" | "error" | "warning" | "notice" | "command" | "debug";

export interface LogLine {
  /** 1-based, as the provider numbers them — stable across collapses. */
  n: number;
  /** Epoch ms from the line's timestamp prefix; null on a continuation line. */
  ts: number | null;
  text: string;
  kind: LogKind;
  /** Opens a `##[group]` — how the runner announces each `run:` step. */
  groupTitle?: true;
}

export type LogBlock =
  | { type: "line"; line: LogLine }
  | { type: "group"; title: LogLine; lines: LogLine[] };

// An Actions log line is `<ISO-8601 with 7 fractional digits>Z <text>`.
const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) ?/;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// `##[...]` is a workflow command; a bare `[command]` is the runner echoing a
// process it spawned (git, node), which never carries the `##`.
const MARKER_RE = /^(?:##\[(group|endgroup|error|warning|notice|command|debug|section)\]|\[(command)\])/;

/**
 * Parse a raw job log into lines and collapsible groups.
 *
 * Timestamps come off (they are the same to the second on every line of a
 * step and double the width of a phone screen) but are KEPT as numbers, which
 * is what lets a step in the job tree jump to its first line. ANSI colour
 * codes are stripped rather than rendered: test runners emit them liberally
 * and a raw `[32m` is worse than no colour.
 */
export function parseLog(raw: string): LogBlock[] {
  const blocks: LogBlock[] = [];
  let group: { title: LogLine; lines: LogLine[] } | null = null;
  const rows = raw.replace(/\r\n?/g, "\n").split("\n");
  if (rows.length && rows[rows.length - 1] === "") rows.pop();

  rows.forEach((row, i) => {
    // ANSI first: a colour reset left over from the previous line can sit
    // in front of the timestamp and hide it.
    let text = row.replace(ANSI_RE, "");
    let ts: number | null = null;
    const m = TS_RE.exec(text);
    if (m) {
      ts = Date.parse(m[1] ?? "");
      text = text.slice(m[0].length);
    }
    const marker = MARKER_RE.exec(text);
    const tag = marker?.[1] ?? marker?.[2];
    if (marker) text = text.slice(marker[0].length);

    if (tag === "endgroup") {
      if (group) blocks.push({ type: "group", ...group });
      group = null;
      return;
    }
    const line: LogLine = {
      n: i + 1,
      ts,
      text,
      kind:
        tag === "error" || tag === "warning" || tag === "notice" || tag === "command" || tag === "debug"
          ? tag
          : "plain",
    };
    if (tag === "group") {
      line.groupTitle = true;
      // A group opened inside an open one: GitHub doesn't nest them either —
      // close the outer one where the inner begins.
      if (group) blocks.push({ type: "group", ...group });
      group = { title: line, lines: [] };
      return;
    }
    if (group) group.lines.push(line);
    else blocks.push({ type: "line", line });
  });
  if (group) blocks.push({ type: "group", ...(group as { title: LogLine; lines: LogLine[] }) });
  return blocks;
}

/** Every line in render order, groups flattened — for counts and searching. */
export function flattenLog(blocks: LogBlock[]): LogLine[] {
  const out: LogLine[] = [];
  for (const b of blocks) {
    if (b.type === "line") out.push(b.line);
    else out.push(b.title, ...b.lines);
  }
  return out;
}

/**
 * The first log line belonging to a step.
 *
 * Step times come from the API at whole-second precision while lines carry
 * fractions, so the start is floored to its second — otherwise a step's
 * opening line, stamped .3s into that second, would sort before it. But the
 * floor also takes in the previous step's last lines from that same second,
 * and "first line at or after" then lands in the wrong step's output (seen on
 * a real run: the jump to a failed `Test (client)` opened on the tail of the
 * server tests before it). So when a group opens within that second — which
 * is how the runner announces a `run:` step — that header wins.
 */
export function firstLineAt(lines: LogLine[], startedAt: string | null): number | null {
  if (!startedAt) return null;
  const t = Date.parse(startedAt);
  if (Number.isNaN(t)) return null;
  const floor = Math.floor(t / 1000) * 1000;
  let first: number | null = null;
  for (const l of lines) {
    if (l.ts === null || l.ts < floor) continue;
    if (l.ts >= floor + 1000) break;
    first ??= l.n;
    if (l.groupTitle) return l.n;
  }
  if (first !== null) return first;
  for (const l of lines) if (l.ts !== null && l.ts >= floor) return l.n;
  return null;
}
