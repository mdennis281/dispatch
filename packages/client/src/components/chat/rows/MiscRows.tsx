import type { ReactNode } from "react";
import {
  Sparkles,
  Info,
  AlertTriangle,
  RotateCcw,
  Brain,
  CheckCircle2,
  XCircle,
  Cpu,
} from "lucide-react";
import type { NoticeRow, ResultRow, SystemMessageRow } from "@cm/shared";
import { RowShell } from "./RowShell.js";
import { TypingPulse } from "../../ui/Spinner.js";
import { Chip } from "../../ui/Chip.js";
import { Markdown } from "../Markdown.js";
import { cn } from "../../../lib/cn.js";
import { dur } from "../../../lib/format.js";
import { useTypewriter } from "../../../lib/useTypewriter.js";

/** The live "agent is working" row shown while a turn streams (no text yet). */
export function WorkingRow({ label }: { label?: string }) {
  return (
    <RowShell
      gutter={
        <span className="flex size-6 items-center justify-center rounded-md bg-accent-ghost text-accent-hi ring-1 ring-accent-line [&_svg]:size-3.5">
          <Sparkles />
        </span>
      }
    >
      <div className="inline-flex items-center gap-2.5 rounded-md border border-accent-line/60 bg-accent-ghost/40 px-2.5 py-1.5">
        <TypingPulse />
        <span className="text-[12px] font-medium text-accent-hi">{label ?? "Working…"}</span>
      </div>
    </RowShell>
  );
}

/**
 * A live, in-flight assistant turn assembled from `message-chunk` deltas. Renders
 * streamed markdown with a trailing typing pulse; falls back to a "Thinking…"
 * shimmer while only the thinking channel has arrived.
 */
export function StreamingRow({ text, thinking }: { text: string; thinking?: string }) {
  // Reveal the live buffer letter-by-letter, adaptive to the arrival speed —
  // a subtle trail that never gates the actual stream (see useTypewriter).
  const shown = useTypewriter(text);
  return (
    <RowShell
      tint="assistant"
      who="Claude"
      gutter={
        <span className="flex size-6 items-center justify-center rounded-md bg-accent-ghost text-accent-hi ring-1 ring-accent-line [&_svg]:size-3.5">
          <Sparkles />
        </span>
      }
    >
      {text ? (
        <div className="min-w-0">
          <Markdown>{shown}</Markdown>
          <span className="mt-0.5 inline-flex align-middle">
            <TypingPulse />
          </span>
        </div>
      ) : (
        <div className="min-w-0">
          <div className="inline-flex items-center gap-2 text-[12px] text-muted">
            <Brain className="size-3.5 text-accent-hi" />
            <span>Thinking…</span>
            <TypingPulse />
          </div>
          {thinking && (
            <div className="mt-1 line-clamp-3 border-l-2 border-line pl-3 text-[12px] italic leading-[1.55] text-muted">
              {thinking}
            </div>
          )}
        </div>
      )}
    </RowShell>
  );
}

/** A quiet centered turn-boundary marker (result / system). Reads as a divider. */
function CenterNote({
  icon,
  children,
  tone = "faint",
}: {
  icon?: ReactNode;
  children: ReactNode;
  tone?: "faint" | "muted" | "danger";
}) {
  const toneCls =
    tone === "danger" ? "text-danger" : tone === "muted" ? "text-muted" : "text-faint";
  return (
    <div className="flex items-center gap-2.5 px-4 py-1.5">
      <span className="h-px flex-1 bg-line-soft" />
      <span className={cn("inline-flex items-center gap-1.5 text-[10.5px] [&_svg]:size-3", toneCls)}>
        {icon}
        {children}
      </span>
      <span className="h-px flex-1 bg-line-soft" />
    </div>
  );
}

/** The turn-done result marker — turns / duration / cost, or an error line. */
export function ResultRowView({ row }: { row: ResultRow }) {
  if (row.isError) {
    return (
      <CenterNote tone="danger" icon={<XCircle />}>
        {row.result || "Turn ended with an error"}
      </CenterNote>
    );
  }
  const parts: string[] = [];
  if (row.numTurns) parts.push(`${row.numTurns} turn${row.numTurns === 1 ? "" : "s"}`);
  const d = dur(row.durationMs);
  if (d) parts.push(d);
  if (typeof row.costUsd === "number" && row.costUsd > 0) {
    parts.push(`$${row.costUsd.toFixed(row.costUsd < 1 ? 3 : 2)}`);
  }
  return (
    <CenterNote icon={<CheckCircle2 />}>
      Turn complete
      {parts.length > 0 && <span className="cm-mono !text-[10px] text-faint"> · {parts.join(" · ")}</span>}
    </CenterNote>
  );
}

/** A system/init message — a quiet "session started" marker with a model chip. */
export function SystemRowView({ row }: { row: SystemMessageRow }) {
  if (row.subtype === "init") {
    const data = row.data as { model?: string } | undefined;
    return (
      <CenterNote icon={<Cpu />}>
        Session started
        {data?.model && (
          <Chip tone="muted" mono className="ml-1">
            {data.model}
          </Chip>
        )}
      </CenterNote>
    );
  }
  return (
    <CenterNote>
      {row.subtype}
      {row.text && <span className="text-faint"> · {row.text}</span>}
    </CenterNote>
  );
}

/** A local, non-agent notice (rollback, info, error) woven into the transcript. */
export function NoticeRowView({ row }: { row: NoticeRow }) {
  const Icon = row.level === "error" ? AlertTriangle : row.text.startsWith("Rolled back") ? RotateCcw : Info;
  const tone =
    row.level === "error" ? "text-danger" : row.level === "warn" ? "text-warn" : "text-muted";
  return (
    <div className="flex items-center gap-2 px-4 py-1.5">
      <div className="ml-7 flex items-center gap-2">
        <Icon className={cn("size-3.5", tone)} />
        <span className={cn("text-[11.5px]", tone)}>{row.text}</span>
      </div>
    </div>
  );
}
