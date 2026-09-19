/**
 * The pieces a "record of a moment" tool card is built from — shared by the
 * PR and issue cards so their drilldowns read as one dialect: the same outcome
 * box, the same collapsed raw exchange, the same tick/cross.
 */
import { Check, ChevronRight, Circle, X } from "lucide-react";
import { CodeBlock } from "../CodeBlock.js";
import { Spinner } from "../../ui/Spinner.js";
import { cn } from "../../../lib/cn.js";
import { dur, safeJson } from "../../../lib/format.js";
import type { ToolDetailState } from "../ToolDetailModal.js";

export function StateMark({ state }: { state: ToolDetailState }) {
  if (state === "running") return <Spinner size={10} />;
  if (state === "failed") return <X className="text-danger" />;
  if (state === "stopped") return <Circle className="text-muted" />;
  return <Check className="text-success" />;
}

export function DetailLines({ lines }: { lines: string[] }) {
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

/** What a one-shot tool did — the headline, whether it worked, and why. */
export function OutcomeCard({
  outcome,
  elapsed,
}: {
  outcome: { summary: string; ok: boolean; details: string[] };
  elapsed?: number;
}) {
  const ok = outcome.ok;
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
          {outcome.summary}
        </span>
        {elapsed !== undefined && (
          <span className="shrink-0 cm-mono !text-2xs text-faint">{dur(elapsed)}</span>
        )}
      </div>
      <DetailLines lines={outcome.details} />
    </div>
  );
}

/**
 * The call as the model saw it, collapsed. Labelled Request/Response because the
 * prose answer is not code — the block's default language used to call it
 * "TypeScript".
 */
export function RawExchange({
  input,
  response,
  running,
  runningNote = "No response yet — the call is still running.",
}: {
  input: Record<string, unknown>;
  response: string;
  running: boolean;
  runningNote?: string;
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
          code={response || (running ? runningNote : "No response")}
          language="text"
          filename="Response"
        />
      </div>
    </details>
  );
}
