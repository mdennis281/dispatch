import { useState } from "react";
import {
  Check,
  ExternalLink,
  GitPullRequest,
  MonitorPlay,
  OctagonX,
  RefreshCw,
  ScanEye,
  Undo2,
} from "lucide-react";
import {
  HTTP_URL_RE,
  HUMAN_REVIEW_ANSWERS,
  composeMessageText,
  parseHumanReviewAnswer,
  type HumanReviewPayload,
  type HumanReviewVerdict,
  type MessagePart,
  type PermissionRow,
} from "@dispatch/shared";
import { RowShell } from "./RowShell.js";
import { MediaGroup } from "./MediaGroup.js";
import { Button } from "../../ui/Button.js";
import { Chip, type Tone } from "../../ui/Chip.js";
import { cn } from "../../../lib/cn.js";
import { actions } from "../../../lib/actions.js";
import { classifyReach } from "../../../lib/connectionDiagnosis.js";
import { useChats } from "../../../stores/chats.js";
import { attentionCardId } from "../../attention/focus.js";
import { rowHarnessLabel } from "../../../lib/harness.js";

/** How a settled verdict reads on the card: chip word, chip tone, footer sentence. */
const SETTLED: Record<HumanReviewVerdict, { chip: string; tone: Tone; said: string }> = {
  approve: { chip: "approved", tone: "success", said: "You approved this" },
  iterate: { chip: "iterating", tone: "accent", said: "You asked for another pass" },
  stop: { chip: "stopped", tone: "danger", said: "You stopped this work" },
};

/** What each verdict tells the agent to do — repeated in a correction, which
 *  arrives as a plain message with no tool result around it to explain itself. */
const MEANING: Record<HumanReviewVerdict, string> = {
  approve: "Carry on and land it the normal way.",
  iterate: "Make the changes, then request review again with fresh evidence. Don't merge.",
  stop: "Make no further changes and don't merge. Say where you left it and stop.",
};

/**
 * The correction sent when the human changes a verdict after it was delivered.
 *
 * Same reasoning as the question card's: the original tool call is long settled,
 * so the change interrupts the turn and arrives as a `brief` — Dispatch's words
 * about the human, laid out as markdown because a brief renders through it.
 */
function buildCorrection(
  verdict: HumanReviewVerdict,
  comment: string | undefined,
  previous: HumanReviewVerdict | null,
): string {
  const out = [
    "The human changed their review verdict and stopped you to apply it:",
    "",
    `- **Revised verdict:** ${HUMAN_REVIEW_ANSWERS[verdict]}`,
  ];
  if (comment) out.push(`- **Comment:** ${comment}`);
  out.push(
    "",
    previous
      ? `(Their previous verdict was: ${HUMAN_REVIEW_ANSWERS[previous]}.)`
      : "(They previously dismissed the review without a verdict.)",
    "",
    `Disregard the previous verdict. ${MEANING[verdict]}`,
  );
  return out.join("\n");
}

/** Loopback hostnames — a preview served on one only opens on the host itself. */
function isLoopbackUrl(url: string): boolean {
  try {
    return classifyReach(new URL(url).hostname.replace(/^\[|\]$/g, "")) === "loopback";
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function prLabel(url: string): string {
  const n = /\/pull\/(\d+)/.exec(url)?.[1];
  return n ? `PR #${n}` : "Pull request";
}

/**
 * The link row: a running preview to click through and the PR, when given.
 *
 * Every href is re-checked against http(s) here even though the tool schema
 * already enforced it — the row is re-read from disk for the life of the chat,
 * and an `<a href="javascript:…">` is not something to trust a file for.
 */
function EvidenceLinks({ review }: { review: HumanReviewPayload }) {
  const preview = review.previewUrl && HTTP_URL_RE.test(review.previewUrl) ? review.previewUrl : null;
  const pr = review.prUrl && HTTP_URL_RE.test(review.prUrl) ? review.prUrl : null;
  if (!preview && !pr) return null;
  // Most of the time Dispatch is reached through a proxy, not on the host —
  // and from there a `localhost:5173` link opens the READER's own machine.
  // Saying so beats a link that silently fails.
  const hostOnly =
    preview !== null &&
    isLoopbackUrl(preview) &&
    typeof location !== "undefined" &&
    classifyReach(location.hostname) !== "loopback";
  const link =
    "inline-flex min-w-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm transition-colors [&_svg]:size-3.5 [&_svg]:shrink-0";
  return (
    <div className="flex flex-wrap items-center gap-2">
      {preview && (
        <a
          href={preview}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(link, "border-success/30 bg-success-ghost text-success hover:border-success/60")}
        >
          <MonitorPlay />
          <span className="font-medium">Try the preview</span>
          <span className="cm-mono truncate !text-2xs opacity-80">{hostOf(preview)}</span>
          <ExternalLink className="opacity-70" />
        </a>
      )}
      {pr && (
        <a
          href={pr}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(link, "border-line bg-panel-2 text-secondary hover:border-line-strong hover:text-primary")}
        >
          <GitPullRequest />
          <span className="font-medium">{prLabel(pr)}</span>
          <ExternalLink className="opacity-70" />
        </a>
      )}
      {hostOnly && (
        <span className="text-xs text-muted">The preview runs on the host machine — it may not open from here.</span>
      )}
    </div>
  );
}

export interface ReviewCardProps {
  row: PermissionRow;
  review: HumanReviewPayload;
}

/**
 * A `request_human_review` card: the agent's evidence, then three verdicts.
 *
 * Laid out in reading order for someone with thirty seconds — what it is, the
 * few sentences the agent was allowed, the things to actually look at, and
 * then the decision. The comment box sits ABOVE the verdict buttons and each
 * button sends on click, the way a code review works: say what you think, then
 * pick what happens. That is one click for the common "looks good" and no
 * separate submit step to discover.
 *
 * The misclick escape is the same as the question card's: once a verdict is
 * delivered, "Change verdict" stops the agent and re-opens the buttons, and the
 * new verdict goes out as a correction.
 */
export function ReviewCard({ row, review }: ReviewCardProps) {
  const live = row.decision === "pending";
  const dismissed = row.decision === "deny";
  const delivered = row.decision === "allow" ? parseHumanReviewAnswer(row.message) : null;

  const chatStatus = useChats((s) => s.byId[row.chatId]?.status);
  const provider = rowHarnessLabel(row.harness, useChats((s) => s.byId[row.chatId]?.harness));

  const [comment, setComment] = useState("");
  // Optimistic latch, as on every card: one verdict per request, even under a
  // double-click, so the server never sees (and toasts about) a second answer.
  const [sent, setSent] = useState<HumanReviewVerdict | null>(null);
  const [changing, setChanging] = useState(false);
  const [confirmChange, setConfirmChange] = useState(false);
  const [corrected, setCorrected] = useState<{ verdict: HumanReviewVerdict; comment?: string } | null>(
    null,
  );
  const open = live || changing;
  const busy = live && sent !== null;

  const decide = (verdict: HumanReviewVerdict) => {
    if (!open || busy) return;
    const note = comment.trim() || undefined;
    if (changing) {
      const parts: MessagePart[] = [
        {
          kind: "brief",
          label: "Revised review",
          text: buildCorrection(verdict, note, delivered?.verdict ?? null),
        },
      ];
      actions.sendMessage(row.chatId, {
        text: composeMessageText(parts),
        parts,
        priority: chatStatus === "running" || chatStatus === "waiting" ? "next" : undefined,
      });
      setChanging(false);
      setCorrected({ verdict, comment: note });
      return;
    }
    setSent(verdict);
    const label = HUMAN_REVIEW_ANSWERS[verdict];
    actions.answerQuestion(row.chatId, row.requestId, { optionId: label, answer: label, notes: note });
  };

  /** Two clicks, because it interrupts a live turn — the destructive-action idiom. */
  const changeVerdict = () => {
    if (!confirmChange) {
      setConfirmChange(true);
      return;
    }
    setConfirmChange(false);
    if (chatStatus === "running" || chatStatus === "waiting" || chatStatus === "awaiting-input") {
      actions.interrupt(row.chatId);
    }
    setComment("");
    setCorrected(null);
    setChanging(true);
  };

  const settled = corrected ?? delivered;
  const chip = open
    ? { text: busy ? "sending…" : changing ? "changing verdict" : "needs review", tone: (busy ? "muted" : "accent") as Tone }
    : settled
      ? { text: corrected ? `${SETTLED[settled.verdict].chip} · revised` : SETTLED[settled.verdict].chip, tone: SETTLED[settled.verdict].tone }
      : { text: "dismissed", tone: "muted" as Tone };

  return (
    <RowShell
      gutter={
        <span
          className={cn(
            "flex size-6 items-center justify-center rounded-md ring-1 [&_svg]:size-3.5",
            open ? "bg-accent-ghost text-accent-hi ring-accent-line" : "bg-panel-2 text-muted ring-line",
          )}
        >
          <ScanEye />
        </span>
      }
    >
      <div
        id={attentionCardId(row.requestId)}
        className={cn(
          "overflow-hidden rounded-md border",
          open ? "border-accent-line bg-accent-ghost/20 cm-raise" : "border-line bg-panel-2/50",
        )}
      >
        <div className="flex items-start gap-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted">
              {provider} {open ? "wants" : "asked for"} your review
            </p>
            <p className="break-words text-base font-semibold text-primary">{review.title}</p>
          </div>
          <Chip tone={chip.tone} className="mt-0.5 shrink-0">
            {chip.text}
          </Chip>
        </div>

        <div className="flex flex-col gap-2.5 border-t border-line-soft px-3 py-2.5">
          <p className="whitespace-pre-wrap break-words text-base leading-relaxed text-secondary">
            {review.summary}
          </p>
          <EvidenceLinks review={review} />
          {review.screenshots.length > 0 && (
            <MediaGroup chatId={row.chatId} assets={review.screenshots} variant="strip" />
          )}
        </div>

        {changing && (
          <div className="border-t border-line-soft bg-accent-ghost/30 px-3 py-2">
            <p className="text-xs text-secondary">
              Agent stopped.{" "}
              {delivered ? `Your verdict was “${HUMAN_REVIEW_ANSWERS[delivered.verdict]}”.` : "You dismissed this."}{" "}
              Pick again — it's sent as a correction.
            </p>
          </div>
        )}

        {open && (
          <div className="flex flex-col gap-2 border-t border-line-soft bg-inset/60 px-3 py-2.5">
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              disabled={busy}
              rows={2}
              aria-label="Review comment"
              placeholder="Comments (optional) — sent with whichever you pick"
              className={cn(
                "cm-scroll w-full resize-y rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm text-primary",
                "placeholder:text-faint focus:border-line-strong focus:outline-none",
              )}
            />
            {/* On a phone the three don't fit one line. Growing them makes the
                wrap read as a deliberate two-row layout, instead of "Stop work"
                stranded at the right end of a line of its own. */}
            <div className="flex flex-wrap items-center gap-2 max-sm:[&>button]:grow">
              <Button
                variant="primary"
                size="md"
                leftIcon={<Check />}
                disabled={busy}
                onClick={() => decide("approve")}
              >
                {HUMAN_REVIEW_ANSWERS.approve}
              </Button>
              <Button
                variant="default"
                size="md"
                leftIcon={<RefreshCw />}
                disabled={busy}
                onClick={() => decide("iterate")}
              >
                {HUMAN_REVIEW_ANSWERS.iterate}
              </Button>
              {changing && (
                <Button variant="link" size="md" onClick={() => setChanging(false)}>
                  Cancel
                </Button>
              )}
              <Button
                variant="danger"
                size="md"
                leftIcon={<OctagonX />}
                className="ml-auto"
                disabled={busy}
                onClick={() => decide("stop")}
              >
                {HUMAN_REVIEW_ANSWERS.stop}
              </Button>
            </div>
          </div>
        )}

        {!open && (
          <div className="flex items-center gap-2 border-t border-line-soft px-3 py-2">
            <p className="min-w-0 flex-1 break-words text-xs text-muted">
              {settled ? (
                <>
                  {corrected
                    ? `Correction sent — ${SETTLED[settled.verdict].said.replace(/^Y/, "y")}`
                    : SETTLED[settled.verdict].said}
                  {settled.comment ? (
                    <>
                      : <span className="text-secondary">“{settled.comment}”</span>
                    </>
                  ) : (
                    "."
                  )}
                </>
              ) : (
                (row.message ?? "Dismissed without a verdict.")
              )}
            </p>
            <Button
              variant={confirmChange ? "toggle" : "link"}
              size="sm"
              aria-pressed={confirmChange}
              leftIcon={<Undo2 />}
              onClick={changeVerdict}
              onBlur={() => setConfirmChange(false)}
              title="Stop the agent and give a different verdict"
            >
              {confirmChange ? "Stop & change verdict?" : dismissed ? "Give a verdict" : "Change verdict"}
            </Button>
          </div>
        )}
      </div>
    </RowShell>
  );
}
