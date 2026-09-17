/**
 * "Reset main" — put the primary checkout back on a pristine trunk that
 * matches origin, in one click.
 *
 * Under the review profile nobody works in the primary checkout; it sits on the
 * trunk so worktrees can be cut from it. Which is exactly why it rots: a
 * scratch dir from a review, a screenshot an agent dropped in the root, a file
 * edited in the wrong window, a rebase the trunk-sync aborted. None of it is
 * work anyone wants, and cleaning it up by hand is four git commands you have
 * to get in the right order.
 *
 * The modal exists to show the counts BEFORE anything is destroyed. It is one
 * button, but it is a button that deletes files, so it says how many.
 *
 * Local-only commits are the one thing it keeps by default — the memory
 * committer puts `chore(memory)` commits straight on the local trunk, and an
 * unpushed one is memory that isn't anywhere else. They are replayed onto the
 * new tip; dropping them is a checkbox, shown only when there are any.
 */
import { useState } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import type { GitResetSummary, GitStatus } from "@dispatch/shared";
import { Modal, InlineError } from "../sidebar/Modal.js";
import { Button } from "../ui/Button.js";
import { Spinner } from "../ui/Spinner.js";
import { api } from "../../lib/api.js";
import { useNotices } from "../../stores/notices.js";

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One line per thing the reset will do, so an empty list means "nothing". */
export function resetPlan(status: GitStatus | null, trunk: string): string[] {
  if (!status) return [];
  const lines: string[] = [];
  const edits = status.staged.length + status.unstaged.length + status.conflicted.length;
  if (edits > 0) lines.push(`Throw away ${plural(edits, "uncommitted change")}`);
  if (status.untracked.length > 0) {
    lines.push(`Delete ${plural(status.untracked.length, "untracked file")}`);
  }
  if (status.detached || (status.branch && status.branch !== trunk)) {
    lines.push(`Switch from ${status.detached ? "a detached HEAD" : status.branch} to ${trunk}`);
  }
  // ahead/behind only describe the trunk when we are ON it; from another branch
  // the numbers are that branch's and would mislead.
  if (status.branch === trunk && status.behind > 0) {
    lines.push(`Pull ${plural(status.behind, "commit")} from origin/${trunk}`);
  }
  return lines;
}

/** Sentence for the toast — what actually happened, from the server's counts. */
export function summarize(s: GitResetSummary): string {
  const parts: string[] = [];
  if (s.discarded) parts.push(`discarded ${plural(s.discarded, "change")}`);
  if (s.pulled) parts.push(`pulled ${plural(s.pulled, "commit")}`);
  if (s.replayed) parts.push(`replayed ${plural(s.replayed, "local commit")}`);
  if (s.dropped) parts.push(`dropped ${plural(s.dropped, "local commit")}`);
  if (!parts.length) return `${s.branch} was already clean and level with origin.`;
  const text = parts.join(", ");
  return text[0]!.toUpperCase() + text.slice(1) + ".";
}

export function ResetTrunkModal({
  repoPath,
  trunk,
  status,
  onClose,
  onDone,
}: {
  repoPath: string;
  trunk: string;
  status: GitStatus | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [dropLocal, setDropLocal] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plan = resetPlan(status, trunk);
  const onTrunk = status?.branch === trunk;
  const ahead = onTrunk ? (status?.ahead ?? 0) : 0;

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const { summary } = await api.git.resetToOrigin(repoPath, trunk, {
        dropLocalCommits: dropLocal,
      });
      useNotices.getState().push({
        level: "info",
        text: `${trunk} reset to origin`,
        detail: summarize(summary),
      });
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      open
      title={`Reset ${trunk} to origin`}
      icon={<RotateCcw />}
      onClose={onClose}
      width={460}
      description={`Make this checkout a clean copy of origin/${trunk}.`}
      footer={
        <div className="flex w-full items-center justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={onClose} disabled={running}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="danger"
            leftIcon={running ? <Spinner size={12} /> : <RotateCcw />}
            disabled={running}
            onClick={() => void run()}
          >
            Reset {trunk}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {plan.length > 0 ? (
          <ul className="space-y-1 text-sm text-secondary">
            {plan.map((line) => (
              <li key={line} className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warn" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">
            Nothing to throw away — this will fetch and fast-forward if origin has moved.
          </p>
        )}

        {ahead > 0 && (
          <label className="flex cursor-pointer select-none items-start gap-2 rounded-md border border-line bg-panel-2/40 p-2 text-xs text-muted hover:text-secondary">
            <input
              type="checkbox"
              checked={dropLocal}
              onChange={(e) => setDropLocal(e.target.checked)}
              className="mt-0.5 size-3 accent-[var(--p-accent)]"
            />
            <span>
              Also drop {plural(ahead, "local commit")} that origin doesn't have.
              <span className="block text-2xs text-faint">
                Unchecked, they are replayed on top of the new tip — that is where memory commits
                land before they are pushed.
              </span>
            </span>
          </label>
        )}

        <p className="text-2xs text-faint">
          Ignored files (build output, node_modules) are left alone. Stashes are kept.
        </p>

        <InlineError message={error} />
      </div>
    </Modal>
  );
}
