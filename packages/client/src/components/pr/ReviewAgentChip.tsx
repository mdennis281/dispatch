/**
 * What Dispatch's own reviewer is doing on a pull request.
 *
 * The whole `reviewAgent` block on a PR row was write-only: rounds, the sha it
 * covered, and the reviewer's chat id were all persisted and none of it was
 * drawn anywhere. Three states in particular read as "the feature is broken"
 * when they are invisible —
 *
 *   - a review IN FLIGHT, which takes minutes and whose only evidence was a
 *     chat quietly appearing in the sidebar;
 *   - a review that LANDED, with nothing saying it was Dispatch's, which round
 *     it was, or where the transcript is;
 *   - a reviewer that REFUSED to run, which is a standing misconfiguration that
 *     surfaced as one transient toast.
 *
 * One component for both surfaces (the per-chat PRs panel and the workspace
 * roster) because the phase derivation is subtle enough that two of them would
 * drift — see `prReviewAgentView` in @dispatch/shared, which holds the rules.
 */
import { Bot, ScanEye, MessageSquareWarning, Ban } from "lucide-react";
import { prReviewAgentView, type PrReviewAgentPhase } from "@dispatch/shared";
import type { PrReviewAgentState } from "@dispatch/shared";
import { Chip, type Tone } from "../ui/Chip.js";
import { Spinner } from "../ui/Spinner.js";
import { Button } from "../ui/Button.js";
import { selectChat } from "../../stores/navigation.js";
import { relTime } from "../../lib/format.js";

const PHASE_TONE: Record<PrReviewAgentPhase, Tone> = {
  blocked: "warn",
  queued: "neutral",
  running: "accent",
  reviewed: "agent",
  // Muted, not warn: a spent cap is the configured behaviour working, not a
  // fault. It is here so the stop is legible, not so it nags.
  spent: "muted",
};

/**
 * The round counter, as `2/4`.
 *
 * `maxRounds` is optional because rows written before it was recorded don't
 * carry it, and inventing a denominator would turn "we don't know the cap" into
 * a confident claim about when the reviewer stops.
 */
function rounds(v: { round: number; maxRounds?: number }): string {
  if (v.round <= 0) return "";
  return v.maxRounds != null ? ` ${v.round}/${v.maxRounds}` : ` ${v.round}`;
}

export function ReviewAgentChip({
  state,
  /** Called after the reviewer chat is selected — an overlay closes itself here. */
  onNavigate,
}: {
  state?: PrReviewAgentState;
  onNavigate?: () => void;
}) {
  const v = prReviewAgentView(state);
  if (!v) return null;

  const when = v.at ? relTime(v.at) : "";
  let icon = <Bot />;
  let label = "";
  let title = "";

  switch (v.phase) {
    case "blocked":
      icon = <Ban />;
      label = "reviewer off";
      title = v.problem ?? "Dispatch's reviewer cannot run for this PR.";
      break;
    case "queued":
      icon = <ScanEye />;
      label = "review queued";
      title = `Dispatch's reviewer was asked ${when} — it starts on the next sweep.`;
      break;
    case "running":
      icon = <Spinner size={12} />;
      label = `reviewing…${rounds(v)}`;
      title = `Dispatch has been reviewing since ${when}. Nothing is posted on the PR yet.`;
      break;
    case "reviewed":
    case "spent": {
      const blocked = v.postedEvent === "REQUEST_CHANGES";
      icon = blocked ? <MessageSquareWarning /> : <Bot />;
      const found =
        v.findings && v.findings > 0
          ? ` · ${v.findings} finding${v.findings === 1 ? "" : "s"}`
          : "";
      // The cap says so IN THE LABEL, not just in the tone. A spent cap is a
      // permanent stop — the sweep will never spawn another round for this head
      // — and leaving that to a colour is how it stayed a silent stop.
      const last = v.phase === "spent" ? " · last round" : "";
      label = v.posted
        ? `reviewed${rounds(v)}${found}${last}`
        : `reviews spent${rounds(v)}`;
      title = !v.posted
        ? `Every review round is spent (${v.round} of ${v.maxRounds}) and none of them ` +
          "posted anything. Push a commit or re-request to get another."
        : `Dispatch reviewed this ${when}` +
          (blocked ? ", asking for changes" : "") +
          (v.phase === "spent"
            ? `. That was the last round (${v.round} of ${v.maxRounds}) — push a commit ` +
              "or re-request to get another."
            : "");
      break;
    }
  }

  const chip = (
    <Chip tone={PHASE_TONE[v.phase]} icon={icon} title={title}>
      {label}
    </Chip>
  );

  // Linked only when there IS a transcript to open. The reviewer chat is where
  // the reasoning behind a verdict lives, and it is the one thing the row could
  // never point at before.
  if (!v.chatId) return chip;
  return (
    <Button
      variant="subtle"
      size="sm"
      className="gap-1 px-1.5 text-2xs"
      title={`${title} Open the reviewer's chat.`}
      onClick={() => {
        selectChat(v.chatId!);
        onNavigate?.();
      }}
    >
      <span className="[&_svg]:size-3">{icon}</span>
      {label}
    </Button>
  );
}

/**
 * The standing reason Dispatch's reviewer is not running, above the list of PRs
 * it is not running on.
 *
 * The per-row chip alone is not enough for this one. A misconfiguration applies
 * to every PR in the project at once, so as a chip it is both repeated on every
 * row and invisible the moment the affected rows scroll away — and it is the
 * state a person is most likely to be in the roster *because* of. Derived from
 * the rows rather than fetched: `problem` is recorded onto them by the sweep, so
 * the answer is already in the store that feeds this list.
 */
export function ReviewerProblemNotice({
  prs,
}: {
  prs: ReadonlyArray<{ reviewAgent?: PrReviewAgentState }>;
}) {
  const problems = [
    ...new Set(prs.map((p) => p.reviewAgent?.problem).filter((x): x is string => !!x)),
  ];
  if (problems.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-warn/30 bg-warn-ghost px-2.5 py-2 text-xs text-warn">
      {problems.map((p) => (
        <div key={p} className="flex items-start gap-1.5">
          <Ban className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0">{p}</span>
        </div>
      ))}
    </div>
  );
}
