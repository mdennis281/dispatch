import { useState } from "react";
import { Check, Plug, ShieldAlert, ShieldCheck, X } from "lucide-react";
import {
  readPluginApprovalOutcome,
  type PermissionRow,
  type PluginApprovalCard as PluginApprovalPayload,
  type PluginApprovalDecision,
} from "@dispatch/shared";
import { RowShell } from "./RowShell.js";
import { Button } from "../../ui/Button.js";
import { Chip, type Tone } from "../../ui/Chip.js";
import { cn } from "../../../lib/cn.js";
import { actions } from "../../../lib/actions.js";
import { attentionCardId } from "../../attention/focus.js";
import { useNowTick } from "../../../stores/agentRun.js";

const OUTCOME_CHIP: Record<PluginApprovalDecision, { tone: Tone; label: string }> = {
  approved: { tone: "success", label: "approved" },
  denied: { tone: "danger", label: "denied" },
  timeout: { tone: "muted", label: "timed out" },
  cancelled: { tone: "muted", label: "withdrawn" },
};

function remaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * A PLUGIN asking the human to approve one action (`ctx.approvals.request`) —
 * the permission card's frame and colours, so it reads as the same kind of
 * gate, but with none of a tool card's escape hatches:
 *
 * - No Edit. The command is shown exactly as it will run; approving an edited
 *   version would approve something the plugin never asked for (the server
 *   ignores an edited input on these regardless).
 * - No "Always allow". Every one of these is a fresh decision — it guards root
 *   on someone's machine — and the server refuses `remember` for it anyway.
 *
 * The requester is the PLUGIN, named from its manifest by the server, not the
 * chat's agent: the agent is blocked in a tool call while this is up.
 */
export function PluginApprovalCard({ row, card }: { row: PermissionRow; card: PluginApprovalPayload }) {
  const [answered, setAnswered] = useState(false);
  const pending = row.decision === "pending";
  const now = useNowTick(pending);
  const left = card.expiresAt - now;
  const expired = pending && left <= 0;
  const busy = pending && (answered || expired);
  const outcome = pending ? undefined : (readPluginApprovalOutcome(row.input) ?? (row.decision === "allow" ? "approved" : "denied"));

  const answer = (decision: "allow" | "deny") => {
    if (!pending || busy) return;
    setAnswered(true);
    actions.answerPermission(row.chatId, row.requestId, decision);
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
          {pending ? <ShieldAlert /> : <ShieldCheck />}
        </span>
      }
    >
      <div
        id={attentionCardId(row.requestId)}
        data-testid="plugin-approval-card"
        className={cn(
          "overflow-hidden rounded-md border",
          pending ? "border-warn/20 bg-warn-ghost/20 cm-raise" : "border-line bg-panel-2/50",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2">
          <Plug className="size-3.5 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 text-base text-primary">
            <span className="font-semibold">{card.pluginName}</span> asks you to approve:{" "}
            <span className="font-semibold text-warn">{card.title}</span>
          </span>
          {pending ? (
            <Chip tone={busy ? "muted" : "warn"} className="ml-auto shrink-0">
              {answered ? "sending…" : expired ? "expired" : "needs approval"}
            </Chip>
          ) : (
            <Chip tone={OUTCOME_CHIP[outcome!].tone} className="ml-auto shrink-0">
              {OUTCOME_CHIP[outcome!].label}
            </Chip>
          )}
        </div>

        {card.command && (
          <div className="cm-scroll overscroll-y-auto max-h-48 overflow-auto border-t border-line-soft px-3 py-2">
            <pre className="whitespace-pre-wrap break-all cm-mono text-secondary">{card.command}</pre>
          </div>
        )}

        {(card.machine || card.cwd || card.detail) && (
          <div className="flex flex-col gap-1 border-t border-line-soft px-3 py-2 text-xs">
            {(card.machine || card.cwd) && (
              <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-muted">
                {card.machine && (
                  <div className="flex gap-1.5">
                    <dt className="text-faint">on</dt>
                    <dd className="text-secondary">{card.machine}</dd>
                  </div>
                )}
                {card.cwd && (
                  <div className="flex min-w-0 gap-1.5">
                    <dt className="text-faint">in</dt>
                    <dd className="cm-mono truncate text-secondary">{card.cwd}</dd>
                  </div>
                )}
              </dl>
            )}
            {card.detail && <p className="whitespace-pre-wrap text-secondary">{card.detail}</p>}
          </div>
        )}

        {pending && (
          <div className="flex items-center gap-1.5 border-t border-line-soft bg-inset/60 px-3 py-2">
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Check />}
              disabled={busy}
              onClick={() => answer("allow")}
              title="Approve this one request. The next one asks again."
            >
              Approve once
            </Button>
            <span className="text-2xs text-faint" aria-live="off">
              {expired ? "no longer answerable" : `expires in ${remaining(left)}`}
            </span>
            <Button
              variant="danger"
              size="sm"
              leftIcon={<X />}
              className="ml-auto"
              disabled={busy}
              onClick={() => answer("deny")}
            >
              Deny
            </Button>
          </div>
        )}

        {/* No footer once settled: the decision's notice ("Approved by …") is
            the very next transcript row, and repeating it here read twice. */}
      </div>
    </RowShell>
  );
}
