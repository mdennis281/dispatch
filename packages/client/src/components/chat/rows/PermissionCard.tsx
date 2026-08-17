import { useState } from "react";
import { ShieldQuestion, Check, X, ShieldCheck, Pencil } from "lucide-react";
import type { PermissionRow } from "@dispatch/shared";
import { RowShell } from "./RowShell.js";
import { QuestionCard } from "./QuestionCard.js";
import { PlanCard } from "./PlanCard.js";
import { Button } from "../../ui/Button.js";
import { Chip } from "../../ui/Chip.js";
import { cn } from "../../../lib/cn.js";
import { safeJson } from "../../../lib/format.js";
import { actions } from "../../../lib/actions.js";
import { attentionCardId } from "../../attention/focus.js";
import { useChats } from "../../../stores/chats.js";
import { rowHarnessLabel } from "../../../lib/harness.js";

export interface PermissionCardProps {
  row: PermissionRow;
  /**
   * Legacy hook from the transcript. The card now self-dispatches via
   * `actions.answerPermission` (so it can carry an edited input / deny reason /
   * "always allow"); this stays optional for backward compatibility.
   */
  onDecide?: (decision: "allow" | "deny", remember?: boolean) => void;
}

function parseDraft(draft: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(draft);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A permission decision card — the key "needs input" surface, inline in chat. */
export function PermissionCard({ row }: PermissionCardProps) {
  const provider = rowHarnessLabel(row.harness, useChats((s) => s.byId[row.chatId]?.harness));
  // Hooks first (unconditionally) — the AskUserQuestion branch below returns early.
  const [refine, setRefine] = useState(false);
  const [draft, setDraft] = useState("");
  const [reason, setReason] = useState("");
  // Optimistic latch: disable the actions the instant one is dispatched so a fast
  // double-click can't fire a second answer (which the server rejects with a red
  // error toast). "Gate by disabling", never allow-then-error.
  const [answered, setAnswered] = useState(false);

  // AskUserQuestion and ExitPlanMode ride the same permission channel, but a raw
  // JSON dump of their payload is unreadable — each gets a purpose-built card.
  if (row.toolName === "AskUserQuestion") return <QuestionCard row={row} />;
  if (row.toolName === "ExitPlanMode") return <PlanCard row={row} />;

  const pending = row.decision === "pending";
  const busy = pending && answered;

  const edited = refine && draft !== safeJson(row.input);
  const parsed = refine ? parseDraft(draft) : row.input;
  const invalid = refine && parsed === null;

  const target =
    row.description ??
    (typeof row.input.file_path === "string" ? row.input.file_path : undefined) ??
    (typeof row.input.command === "string" ? row.input.command : undefined);

  const allow = (remember: boolean) => {
    if (!pending || invalid || answered) return;
    setAnswered(true);
    actions.answerPermission(row.chatId, row.requestId, "allow", {
      remember,
      updatedInput: edited && parsed ? parsed : undefined,
    });
  };
  const deny = () => {
    if (!pending || answered) return;
    setAnswered(true);
    actions.answerPermission(row.chatId, row.requestId, "deny", {
      message: reason.trim() || undefined,
    });
  };
  const openRefine = () => {
    if (!refine) setDraft(safeJson(row.input));
    setRefine((v) => !v);
  };

  return (
    <RowShell
      gutter={
        <span
          className={cn(
            "flex size-6 items-center justify-center rounded-md ring-1 [&_svg]:size-3.5",
            pending ? "bg-warn-ghost text-warn ring-warn/30" : "bg-panel-2 text-muted ring-line",
          )}
        >
          {pending ? <ShieldQuestion /> : <ShieldCheck />}
        </span>
      }
    >
      <div
        id={attentionCardId(row.requestId)}
        className={cn(
          "overflow-hidden rounded-md border",
          pending ? "border-warn/20 bg-warn-ghost/20 cm-raise" : "border-line bg-panel-2/50",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="text-base text-primary">
            {provider} wants to{" "}
            <span className="font-semibold text-warn">{row.displayName ?? row.toolName}</span>
          </span>
          {pending ? (
            <Chip tone={busy ? "muted" : "warn"} className="ml-auto">
              {busy ? "sending…" : "needs approval"}
            </Chip>
          ) : (
            <Chip tone={row.decision === "allow" ? "success" : "danger"} className="ml-auto">
              {row.decision === "allow" ? "allowed" : "denied"}
            </Chip>
          )}
        </div>

        {target && !refine && (
          <div className="cm-scroll max-h-48 overflow-auto border-t border-line-soft px-3 py-2">
            <pre className="whitespace-pre-wrap break-words cm-mono text-secondary">{target}</pre>
            {typeof row.input.content === "string" && (
              <pre className="mt-1.5 line-clamp-3 whitespace-pre-wrap break-words cm-mono !text-2xs text-faint">
                {row.input.content}
              </pre>
            )}
          </div>
        )}
        {!target && !refine && (
          <div className="cm-scroll max-h-48 overflow-auto border-t border-line-soft px-3 py-2">
            <pre className="whitespace-pre-wrap break-words cm-mono text-secondary">
              {safeJson(row.input)}
            </pre>
          </div>
        )}

        {pending && refine && (
          <div className="flex flex-col gap-2 border-t border-line-soft px-3 py-2.5">
            <label className="flex items-center justify-between text-2xs font-medium uppercase tracking-wide text-faint">
              Edit tool input (JSON)
              {invalid && <span className="normal-case tracking-normal text-danger">invalid JSON</span>}
            </label>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              rows={Math.min(12, draft.split("\n").length + 1)}
              className={cn(
                "cm-scroll w-full resize-y rounded-md border bg-inset px-2 py-1.5 cm-mono text-secondary focus:outline-none",
                invalid ? "border-danger/50" : "border-line focus:border-line-strong",
              )}
            />
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Deny reason (optional) — sent to the agent"
              className="h-7 w-full rounded-md border border-line bg-panel-2 px-2 text-sm text-primary placeholder:text-faint focus:border-line-strong focus:outline-none"
            />
          </div>
        )}

        {pending && (
          <div className="flex items-center gap-1.5 border-t border-line-soft bg-inset/60 px-3 py-2">
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Check />}
              disabled={invalid || busy}
              onClick={() => allow(false)}
            >
              Allow
            </Button>
            <Button variant="default" size="sm" disabled={invalid || busy} onClick={() => allow(true)}>
              Always allow
            </Button>
            <Button
              variant={refine ? "subtle" : "ghost"}
              size="sm"
              leftIcon={<Pencil />}
              onClick={openRefine}
              disabled={busy}
              aria-pressed={refine}
              className={cn(refine && "text-primary")}
            >
              {refine ? "Editing" : "Edit"}
            </Button>
            <Button
              variant="danger"
              size="sm"
              leftIcon={<X />}
              className="ml-auto"
              disabled={busy}
              onClick={deny}
            >
              Deny
            </Button>
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
