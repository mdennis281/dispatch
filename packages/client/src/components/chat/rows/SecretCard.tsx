import { useState } from "react";
import { AlertTriangle, Check, KeyRound, X } from "lucide-react";
import {
  SECRET_ANSWERS,
  type PermissionRow,
  type SecretRefreshReport,
  type SecretRequestPayload,
} from "@dispatch/shared";
import { RowShell } from "./RowShell.js";
import { Button } from "../../ui/Button.js";
import { Chip, type Tone } from "../../ui/Chip.js";
import { Spinner } from "../../ui/Spinner.js";
import { cn } from "../../../lib/cn.js";
import { api } from "../../../lib/api.js";
import { actions } from "../../../lib/actions.js";
import { useChats } from "../../../stores/chats.js";
import { attentionCardId } from "../../attention/focus.js";
import { rowHarnessLabel } from "../../../lib/harness.js";

/** What a save refreshed, in one line — the reason the human saved it now rather than later. */
function refreshSummary(r: SecretRefreshReport): string {
  const parts: string[] = [];
  if (r.mcpServers.length) parts.push(`${r.mcpServers.length} MCP server${r.mcpServers.length === 1 ? "" : "s"} reloaded`);
  if (r.subAppsRestarted.length) parts.push(`${r.subAppsRestarted.length} sub-app${r.subAppsRestarted.length === 1 ? "" : "s"} restarted`);
  if (r.chatsOnNextSession.length) parts.push(`${r.chatsOnNextSession.length} chat${r.chatsOnNextSession.length === 1 ? "" : "s"} update next session`);
  return parts.length ? parts.join(" · ") : "Nothing uses it yet";
}

export interface SecretCardProps {
  row: PermissionRow;
  secret: SecretRequestPayload;
}

/**
 * A `secret_request` card: a password field the value goes STRAIGHT from.
 *
 * The order of operations is the whole design. The value is PUT to
 * `/api/secrets` first, and only once that has succeeded is the card answered —
 * with the bare word "Saved", which is all that ever reaches the transcript or
 * the model. There is deliberately no notes box: a free-form field on this card
 * is exactly where someone would paste the key.
 */
export function SecretCard({ row, secret }: SecretCardProps) {
  const live = row.decision === "pending";
  const provider = rowHarnessLabel(row.harness, useChats((s) => s.byId[row.chatId]?.harness));
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<"save" | "skip" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<SecretRefreshReport | null>(null);

  const answered = row.decision === "allow" ? row.message : null;
  const saved = answered?.startsWith(SECRET_ANSWERS.saved) ?? false;

  const save = async () => {
    if (!live || busy || !value) return;
    setBusy("save");
    setError(null);
    try {
      const res = await api.secrets.put({
        name: secret.name,
        scope: secret.scope,
        ...(secret.projectId ? { projectId: secret.projectId } : {}),
        value,
      });
      setValue("");
      setReport(res.refresh);
      actions.answerQuestion(row.chatId, row.requestId, {
        optionId: SECRET_ANSWERS.saved,
        answer: SECRET_ANSWERS.saved,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  const skip = () => {
    if (!live || busy) return;
    setBusy("skip");
    setValue("");
    actions.answerQuestion(row.chatId, row.requestId, {
      optionId: SECRET_ANSWERS.skip,
      answer: SECRET_ANSWERS.skip,
    });
  };

  const chip: { text: string; tone: Tone } = live
    ? { text: busy === "save" ? "saving…" : "needs a secret", tone: busy ? "muted" : "accent" }
    : saved
      ? { text: secret.exists ? "replaced" : "saved", tone: "success" }
      : { text: "not provided", tone: "muted" };

  const where = secret.scope === "global" ? "all projects" : (secret.projectName ?? "this project");

  return (
    <RowShell
      gutter={
        <span
          className={cn(
            "flex size-6 items-center justify-center rounded-md ring-1 [&_svg]:size-3.5",
            live ? "bg-accent-ghost text-accent-hi ring-accent-line" : "bg-panel-2 text-muted ring-line",
          )}
        >
          <KeyRound />
        </span>
      }
    >
      <div
        id={attentionCardId(row.requestId)}
        className={cn(
          "overflow-hidden rounded-md border",
          live ? "border-accent-line bg-accent-ghost/20 cm-raise" : "border-line bg-panel-2/50",
        )}
      >
        <div className="flex items-start gap-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted">
              {provider} {live ? "needs" : "asked for"} a secret for {where}
            </p>
            <p className="cm-mono break-all text-base font-semibold text-primary">{secret.name}</p>
          </div>
          <Chip tone={chip.tone} className="mt-0.5 shrink-0">
            {chip.text}
          </Chip>
        </div>

        <div className="border-t border-line-soft px-3 py-2.5">
          <p className="whitespace-pre-wrap break-words text-base leading-relaxed text-secondary">{secret.why}</p>
        </div>

        {live && (
          <div className="flex flex-col gap-2 border-t border-line-soft bg-inset/60 px-3 py-2.5">
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <input
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-label={`Value for ${secret.name}`}
                placeholder={secret.exists ? "Paste a new value to replace the stored one" : "Paste the value"}
                disabled={busy !== null}
                className={cn(
                  "min-w-0 flex-1 basis-56 rounded-md border border-line bg-panel-2 px-2.5 py-1.5",
                  "cm-mono text-sm text-primary placeholder:font-sans placeholder:text-faint",
                  "focus:border-accent-line focus:outline-none disabled:opacity-60",
                )}
              />
              <Button
                type="submit"
                variant="primary"
                size="md"
                leftIcon={busy === "save" ? <Spinner size={12} /> : <Check />}
                disabled={busy !== null || !value}
              >
                {secret.exists ? "Replace" : "Save"}
              </Button>
              <Button type="button" variant="default" size="md" leftIcon={<X />} disabled={busy !== null} onClick={skip}>
                {SECRET_ANSWERS.skip}
              </Button>
            </form>
            <p className="text-2xs leading-snug text-faint">
              Encrypted on the Dispatch host and never shown again — the agent only learns that it
              was saved. Anything using <span className="cm-mono">{`\${secret:${secret.name}}`}</span>{" "}
              reloads.
            </p>
            {error && (
              <div className="flex items-start gap-1.5 text-2xs leading-snug text-danger">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>
        )}

        {!live && (
          <div className="border-t border-line-soft px-3 py-2">
            <p className="text-xs text-muted">
              {saved
                ? `Saved.${report ? ` ${refreshSummary(report)}.` : ""}`
                : (row.message ?? "Not provided.")}
            </p>
          </div>
        )}
      </div>
    </RowShell>
  );
}
