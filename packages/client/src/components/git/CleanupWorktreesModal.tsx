/**
 * "Clean up worktrees" — the human-driven half of WorktreeReaper.
 *
 * The reaper's unattended sweep and this panel ask the SAME question through the
 * same endpoint, so what you approve here is exactly what the sweep would have
 * done on its own. This exists for the two things a sweep can't do: drain a
 * backlog faster than an hourly cap, and show you the reasoning before anything
 * is deleted.
 *
 * THE TWO-PHASE LOAD IS THE WHOLE UX PROBLEM. Answering "is this tree dirty?"
 * costs ~35 seconds PER TREE on this repo (see WorktreeReaper's cost model — git
 * subprocess spawns here are ~6s each before they do any work). With 91 trees, a
 * modal that waits for a complete answer would spin for several minutes against
 * a blank panel. So it loads in two passes:
 *
 *   1. The cheap pass paints every tree immediately with every gate but `dirty`
 *      answered. Rows arrive knowing they're merged, pushed, unowned — just not
 *      yet whether someone left uncommitted work in them.
 *   2. The probe pass fills that last gate in, and only then may a row be
 *      selected. Until a row is `probed` its checkbox is disabled, because a
 *      checkbox that can be ticked before the safety check has run is an
 *      invitation to delete work.
 *
 * Nothing is pre-selected. A bulk delete of ninety directories behind one
 * pre-ticked "select all" is precisely the interaction this panel exists to
 * avoid — you choose, having read why each row qualifies.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, GitBranch, Loader2, Trash2 } from "lucide-react";
import {
  REAP_BLOCKER_LABEL,
  type ReapCandidate,
  type ReapPlan,
  type ReapResult,
} from "@dispatch/shared";
import { Modal, InlineError } from "../sidebar/Modal.js";
import { Button } from "../ui/Button.js";
import { Chip } from "../ui/Chip.js";
import { Spinner } from "../ui/Spinner.js";
import { api } from "../../lib/api.js";
import { useNotices } from "../../stores/notices.js";
import { midTruncate } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";

/** A tree is offerable once the probe has run and found nothing in the way. */
function isReady(c: ReapCandidate): boolean {
  return c.probed && c.blockers.length === 0;
}

/**
 * Rows worth showing at all.
 *
 * The primary checkout and the trunk worktree are filtered out rather than
 * listed as blocked: they are not stale trees someone forgot about, they are
 * the two directories that are SUPPOSED to be there, and listing them under a
 * cleanup heading only makes the real list harder to read.
 */
function isListable(c: ReapCandidate): boolean {
  return !c.blockers.includes("primary") && !c.blockers.includes("default-branch");
}

export function CleanupWorktreesModal({
  projectId,
  onClose,
  onDone,
}: {
  projectId: string;
  onClose: () => void;
  /** Fired after a successful removal so the caller can refresh its repo list. */
  onDone?: (result: ReapResult) => void;
}) {
  const [plan, setPlan] = useState<ReapPlan | null>(null);
  const [probing, setProbing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* --------------------------------------------------------------- load */

  useEffect(() => {
    let live = true;
    setError(null);
    // Pass 1 — cheap. Paints the list.
    void api.worktrees
      .cleanupPlan({ projectId, probe: false })
      .then((p) => {
        if (!live) return;
        setPlan(p);
        setProbing(true);
        // Pass 2 — the expensive cleanliness probe. Deliberately a second
        // request: it can take minutes, and the list must be readable before it
        // lands rather than after.
        return api.worktrees.cleanupPlan({ projectId, probe: true });
      })
      .then((probed) => {
        if (!live || !probed) return;
        setPlan(probed);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (live) setProbing(false);
      });
    return () => {
      live = false;
    };
  }, [projectId]);

  const rows = useMemo(
    () => (plan?.candidates ?? []).filter(isListable),
    [plan],
  );
  const ready = useMemo(() => rows.filter(isReady), [rows]);
  const blocked = useMemo(() => rows.filter((c) => !isReady(c)), [rows]);

  // Never offer a row that stopped qualifying between passes.
  useEffect(() => {
    setSelected((prev) => {
      const allowed = new Set(ready.map((c) => c.path));
      const next = new Set([...prev].filter((p) => allowed.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [ready]);

  /* ------------------------------------------------------------ actions */

  const toggle = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) =>
      prev.size === ready.length ? new Set() : new Set(ready.map((c) => c.path)),
    );
  }, [ready]);

  const remove = async () => {
    if (selected.size === 0 || removing) return;
    setRemoving(true);
    setError(null);
    try {
      const result = await api.worktrees.cleanup([...selected], deleteBranch);
      useNotices.getState().push({
        level: result.failed > 0 ? "warn" : "info",
        text:
          result.failed > 0
            ? `Removed ${result.removed}, ${result.failed} refused`
            : `Removed ${result.removed} worktree${result.removed === 1 ? "" : "s"}`,
        detail: result.outcomes
          .filter((o) => !o.removed)
          .map((o) => `${o.branch || o.path}: ${o.error ?? "refused"}`)
          .join("\n") || undefined,
      });
      onDone?.(result);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoving(false);
    }
  };

  /* ------------------------------------------------------------- render */

  const loading = plan === null;

  return (
    <Modal
      open
      title="Clean up worktrees"
      onClose={onClose}
      width={720}
      footer={
        <div className="flex w-full items-center gap-3">
          <label
            className={cn(
              "flex select-none items-center gap-1.5 text-xs",
              ready.length === 0
                ? "cursor-not-allowed text-faint"
                : "cursor-pointer text-muted hover:text-secondary",
            )}
          >
            <input
              type="checkbox"
              checked={deleteBranch}
              disabled={ready.length === 0}
              onChange={(e) => setDeleteBranch(e.target.checked)}
              className="size-3 accent-[var(--p-accent)]"
            />
            Delete the local branch too
          </label>
          <div className="ml-auto flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              leftIcon={removing ? <Spinner size={12} /> : <Trash2 />}
              disabled={selected.size === 0 || removing}
              onClick={() => void remove()}
            >
              {selected.size > 0 ? `Remove ${selected.size}` : "Remove"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <InlineError message={error} />

        {/* status line — says plainly what is known and what is still coming */}
        <div className="flex items-center gap-2 text-xs text-muted">
          {loading ? (
            <>
              <Loader2 className="size-3 animate-spin" />
              Reading worktrees…
            </>
          ) : probing ? (
            <>
              <Loader2 className="size-3 animate-spin" />
              Checking {rows.length} worktree{rows.length === 1 ? "" : "s"} for
              uncommitted work — this takes a moment per tree.
            </>
          ) : ready.length === 0 ? (
            <>Nothing to clean up. Every worktree is still holding something.</>
          ) : (
            <>
              <strong className="font-semibold text-secondary">
                {ready.length}
              </strong>
              {" "}
              of {rows.length} can be removed — merged, clean, fully pushed, and
              nothing running in them.
            </>
          )}
        </div>

        {/* A truncated scan must never read as a complete one. */}
        {plan?.truncated && (
          <div className="flex items-start gap-1.5 rounded-md border border-warn/40 bg-warn/10 px-2 py-1.5 text-xs text-warn">
            <AlertTriangle className="mt-px size-3 shrink-0" />
            <span>
              The scan stopped before checking every worktree. What's listed is
              accurate; it just isn't everything.
            </span>
          </div>
        )}

        {ready.length > 0 && (
          <Button variant="link" size="sm" className="self-start" onClick={toggleAll}>
            {selected.size === ready.length ? "Select none" : `Select all ${ready.length}`}
          </Button>
        )}

        <div className="max-h-[46vh] overflow-y-auto rounded-md border border-line">
          {ready.map((c) => (
            <label
              key={c.path}
              className="flex cursor-pointer items-center gap-2 border-b border-line/60 px-2.5 py-2 last:border-b-0 hover:bg-panel-2"
            >
              <input
                type="checkbox"
                checked={selected.has(c.path)}
                onChange={() => toggle(c.path)}
                className="size-3 shrink-0 accent-[var(--p-accent)]"
              />
              <GitBranch className="size-3 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate text-xs text-primary">
                {c.branch}
              </span>
              {c.prNumber !== undefined && (
                <Chip tone="accent" mono>
                  #{c.prNumber}
                </Chip>
              )}
              <span
                className="shrink-0 text-2xs text-faint"
                title={c.path}
              >
                {midTruncate(c.path, 44)}
              </span>
            </label>
          ))}

          {/* Blocked rows are shown, not hidden: "why is that one still here?"
              is the question this panel gets asked, and the answer is the row. */}
          {blocked.map((c) => (
            <div
              key={c.path}
              className="flex items-center gap-2 border-b border-line/60 bg-inset/40 px-2.5 py-2 last:border-b-0"
            >
              <span className="size-3 shrink-0" />
              <GitBranch className="size-3 shrink-0 text-faint" />
              <span className="min-w-0 flex-1 truncate text-xs text-muted">
                {c.branch}
              </span>
              {!c.probed && probing ? (
                <Chip tone="muted">
                  <Loader2 className="mr-1 inline size-2.5 animate-spin" />
                  checking
                </Chip>
              ) : c.blockers.length > 0 ? (
                c.blockers.map((b) => (
                  <Chip key={b} tone={b === "dirty" ? "warn" : "muted"}>
                    {REAP_BLOCKER_LABEL[b]}
                  </Chip>
                ))
              ) : (
                // Cleared every cheap gate but the scan ran out of budget before
                // reaching it. Saying so beats an empty row, which would read as
                // "blocked, reason unknown".
                <Chip tone="muted">Not checked</Chip>
              )}
            </div>
          ))}

          {!loading && rows.length === 0 && (
            <p className="px-2.5 py-6 text-center text-xs text-faint">
              This project has no disposable worktrees.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
