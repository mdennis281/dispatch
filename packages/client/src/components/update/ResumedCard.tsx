/**
 * "Your chats picked themselves back up" — the standing card shown once, on the
 * boot after a deliberate restart, in the same bottom-right stack as the update
 * and install nudges.
 *
 * It exists because auto-resume is the app acting on its own behalf while
 * nobody was watching. The turns it started are real: they spend tokens, they
 * touch worktrees, they can open pull requests. A human who came back to the tab
 * expecting the restart to have ended everything must be able to see what it
 * started instead, and take it back in one click — hence "Stop them" as a
 * first-class button rather than a per-chat hunt through the sidebar.
 *
 * The chats it did NOT resume are listed in the same card on purpose. They are
 * the ones blocked on a human, so the card is also the only place that says "and
 * these two still need you" at the moment that is actionable.
 */
import { RotateCw, X } from "lucide-react";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { useRestartResume } from "../../stores/restartResume.js";

/**
 * Chat titles as their own line, never inlined into the prose.
 *
 * Titles are arbitrary user text — "Fix the release retention sweep" — and
 * folding them into a sentence produced "…broker and Fix the release retention
 * sweep were mid-turn", which reads as a run-on with a stray capital. On their
 * own line, separated by a middot, they are scannable and the sentence stays a
 * sentence.
 */
function names(entries: Array<{ title: string }>): string {
  const titles = entries.map((e) => e.title.trim() || "Untitled");
  if (titles.length <= 3) return titles.join(" · ");
  return `${titles.slice(0, 3).join(" · ")} · +${titles.length - 3} more`;
}

export function ResumedCard() {
  const status = useRestartResume((s) => s.status);
  const stopping = useRestartResume((s) => s.stopping);
  const stopAll = useRestartResume((s) => s.stopAll);
  const dismiss = useRestartResume((s) => s.dismiss);
  if (!status) return null;

  const { resumed, needsInput, cause } = status;
  const what = cause === "update" ? "the update" : "the restart";

  return (
    <div className="pointer-events-auto rounded-lg border border-accent-line/70 bg-overlay px-3 py-2.5 text-left shadow-[var(--shadow-pop)] cm-anim-rise">
      <div className="flex items-start gap-2.5">
        <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-md text-accent-hi ring-1 ring-accent-line [&_svg]:size-3.5">
          <RotateCw />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-base font-medium leading-snug text-primary">
            {resumed.length > 0
              ? `${resumed.length === 1 ? "1 chat" : `${resumed.length} chats`} resumed after ${what}`
              : `Waiting for you after ${what}`}
          </p>
          {resumed.length > 0 && (
            <>
              <p className="mt-0.5 break-words text-xs leading-snug text-secondary">
                {names(resumed)}
              </p>
              <p className="mt-0.5 text-xs leading-snug text-muted">
                {resumed.length === 1 ? "It was" : "They were"} mid-turn when Dispatch stopped,
                so {resumed.length === 1 ? "it" : "they"} carried on{" "}
                {resumed.length === 1 ? "by itself" : "by themselves"}.
              </p>
            </>
          )}
          {needsInput.length > 0 && (
            <>
              {/* Kept visually separate from the resumed list: these were NOT
                  continued, and one merged count would misreport what the app did
                  on its own — the exact thing this card exists to disclose. */}
              <p className="mt-1.5 text-xs leading-snug text-muted">
                Waiting on you, so left alone — the prompt{" "}
                {needsInput.length === 1 ? "it" : "they"} stopped on is gone:
              </p>
              <p className="mt-0.5 break-words text-xs leading-snug text-secondary">
                {names(needsInput)}
              </p>
            </>
          )}
          <div className="mt-1.5 flex items-center gap-2">
            {resumed.length > 0 && (
              <Button variant="ghost" disabled={stopping} onClick={() => void stopAll()}>
                {stopping ? "Stopping…" : "Stop them"}
              </Button>
            )}
            <Button variant="link" onClick={dismiss}>
              Got it
            </Button>
          </div>
        </div>
        <IconButton tip="Dismiss" onClick={dismiss} className="-mr-1 -mt-0.5 shrink-0 text-faint">
          <X />
        </IconButton>
      </div>
    </div>
  );
}
