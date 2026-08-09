import { useState } from "react";
import { ClipboardList, ClipboardCheck, Check, X, ChevronDown, Terminal } from "lucide-react";
import type { PermissionRow } from "@dispatch/shared";
import { RowShell } from "./RowShell.js";
import { Markdown } from "../Markdown.js";
import { Button } from "../../ui/Button.js";
import { Chip } from "../../ui/Chip.js";
import { cn } from "../../../lib/cn.js";
import { safeJson } from "../../../lib/format.js";
import { actions } from "../../../lib/actions.js";
import { attentionCardId } from "../../attention/focus.js";

/** One pre-approval the plan asks for up front (`{ tool, prompt }`). */
export interface AllowedPrompt {
  tool?: string;
  prompt: string;
}

export interface ParsedPlan {
  /** The plan body, as markdown. */
  plan: string;
  allowedPrompts: AllowedPrompt[];
}

/**
 * ExitPlanMode's input is `{ plan: string, allowedPrompts?: [{tool, prompt}] }`,
 * but it rides an untyped channel — parse defensively and let callers fall back
 * to a raw JSON dump when there's no plan text to render.
 */
export function parsePlan(input: Record<string, unknown>): ParsedPlan | null {
  const plan = typeof input.plan === "string" ? input.plan : undefined;
  if (!plan?.trim()) return null;
  const raw = Array.isArray(input.allowedPrompts) ? input.allowedPrompts : [];
  const allowedPrompts: AllowedPrompt[] = raw.flatMap((p) => {
    if (typeof p === "string") return [{ prompt: p }];
    const o = (p ?? {}) as Record<string, unknown>;
    return typeof o.prompt === "string" ? [{ tool: typeof o.tool === "string" ? o.tool : undefined, prompt: o.prompt }] : [];
  });
  return { plan, allowedPrompts };
}

/** A plan is "long" when dumping it whole would swallow the viewport. */
function isLong(plan: string): boolean {
  return plan.length > 900 || plan.split("\n").length > 16;
}

/**
 * The plan body: markdown, clamped to a readable height with a fade + toggle so
 * a 200-line plan can't take over the transcript. Shared by the approval card
 * and the settled ToolCallCard.
 */
export function PlanBody({
  plan,
  allowedPrompts = [],
  className,
}: {
  plan: string;
  allowedPrompts?: AllowedPrompt[];
  className?: string;
}) {
  const long = isLong(plan);
  const [expanded, setExpanded] = useState(!long);

  return (
    <div className={className}>
      <div className="relative rounded-[5px] border border-line-soft bg-inset px-3 py-1.5">
        <div
          className={cn(
            "relative",
            expanded ? "cm-scroll max-h-[60vh] overflow-y-auto" : "max-h-64 overflow-hidden",
          )}
        >
          <Markdown className="!text-base">{plan}</Markdown>
          {!expanded && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-inset to-transparent" />
          )}
        </div>
        {long && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="mt-0.5 mb-1 inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-primary"
          >
            <ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} />
            {expanded ? "Collapse plan" : "Show full plan"}
          </button>
        )}
      </div>

      {allowedPrompts.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.08em] text-faint">
            Pre-approved for this run · {allowedPrompts.length}
          </div>
          <div className="flex flex-col gap-1">
            {allowedPrompts.map((p, i) => (
              <div
                key={i}
                className="flex items-start gap-1.5 rounded-[5px] border border-line-soft bg-panel-2/60 px-2 py-1"
              >
                <Terminal className="mt-px size-3 shrink-0 text-faint" />
                {p.tool && (
                  <span className="shrink-0 cm-mono !text-2xs text-accent-hi">{p.tool}</span>
                )}
                <span className="min-w-0 break-words text-xs text-secondary">{p.prompt}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export interface PlanCardProps {
  row: PermissionRow;
}

/**
 * The ExitPlanMode approval card. The generic PermissionCard would dump the
 * whole `{plan, allowedPrompts}` blob as escaped JSON — unreadable, and tall
 * enough to bury the buttons. Here the plan renders as markdown with the two
 * decisions that actually matter: start building, or keep planning (with
 * optional feedback, which the agent receives as the denial message).
 */
export function PlanCard({ row }: PlanCardProps) {
  const parsed = parsePlan(row.input);
  const pending = row.decision === "pending";
  const [answered, setAnswered] = useState(false);
  const [feedback, setFeedback] = useState("");
  const busy = pending && answered;

  const decide = (decision: "allow" | "deny", remember = false) => {
    if (!pending || answered) return;
    setAnswered(true);
    if (decision === "allow") {
      actions.answerPermission(row.chatId, row.requestId, "allow", { remember });
    } else {
      actions.answerPermission(row.chatId, row.requestId, "deny", {
        message: feedback.trim() || undefined,
      });
    }
  };

  return (
    <RowShell
      gutter={
        <span
          className={cn(
            "flex size-6 items-center justify-center rounded-md ring-1 [&_svg]:size-3.5",
            pending
              ? "bg-accent-ghost text-accent-hi ring-accent-line"
              : "bg-panel-2 text-muted ring-line",
          )}
        >
          {pending ? <ClipboardList /> : <ClipboardCheck />}
        </span>
      }
    >
      <div
        id={attentionCardId(row.requestId)}
        className={cn(
          "overflow-hidden rounded-md border",
          pending ? "border-accent-line bg-accent-ghost/15 cm-raise" : "border-line bg-panel-2/50",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="text-base text-primary">
            Claude finished <span className="font-semibold text-accent-hi">planning</span>
          </span>
          {pending ? (
            <Chip tone={busy ? "muted" : "accent"} className="ml-auto">
              {busy ? "sending…" : "review the plan"}
            </Chip>
          ) : (
            <Chip tone={row.decision === "allow" ? "success" : "muted"} className="ml-auto">
              {row.decision === "allow" ? "approved" : "kept planning"}
            </Chip>
          )}
        </div>

        <div className="border-t border-line-soft px-3 py-2.5">
          {parsed ? (
            <PlanBody plan={parsed.plan} allowedPrompts={parsed.allowedPrompts} />
          ) : (
            <pre className="cm-scroll max-h-64 overflow-auto whitespace-pre-wrap break-words cm-mono text-secondary">
              {safeJson(row.input)}
            </pre>
          )}
        </div>

        {pending && (
          <div className="flex flex-col gap-2 border-t border-line-soft bg-inset/60 px-3 py-2.5">
            <input
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              disabled={busy}
              placeholder="What to change (optional) — sent to Claude if you keep planning"
              className="h-7 w-full rounded-md border border-line bg-panel-2 px-2 text-sm text-primary placeholder:text-faint focus:border-line-strong focus:outline-none"
            />
            <div className="flex items-center gap-1.5">
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Check />}
                disabled={busy}
                onClick={() => decide("allow")}
              >
                Approve &amp; build
              </Button>
              <Button variant="default" size="sm" disabled={busy} onClick={() => decide("allow", true)}>
                Always approve
              </Button>
              <Button
                variant="danger"
                size="sm"
                leftIcon={<X />}
                className="ml-auto"
                disabled={busy}
                onClick={() => decide("deny")}
              >
                Keep planning
              </Button>
            </div>
          </div>
        )}

        {!pending && row.message && (
          <div className="border-t border-line-soft px-3 py-2">
            <p className="text-xs text-muted">{row.message}</p>
          </div>
        )}
      </div>
    </RowShell>
  );
}
