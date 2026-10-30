/**
 * A chat's PRs as a reader outside the app needs them: not just "#465" but
 * whether it is still open, whether CI is green, and whether review is in the
 * way. Built from the chat's own `PRRef`s joined to the PR registry rows the
 * sweep keeps current — `chat_state` and `chat_find` both report it, so a
 * connector tracking "what's still unmerged?" never has to open GitHub.
 *
 * The REF's `state` is only written when the chat's own watcher sees a PR
 * settle, so it lags; the registry row is preferred whenever one exists.
 */
import { ciState, summarizeChecks, type CiState } from "./checks.js";
import { prRecordKey, type PRRef, type PrRecord } from "./domain.js";

export interface ChatPrStatus {
  number: number;
  repo?: string;
  url: string;
  title?: string;
  branch: string;
  /** `unknown` when neither the ref nor a registry row has said. */
  state: "open" | "merged" | "closed" | "unknown";
  isDraft?: boolean;
  /** Parked by a hold label. */
  hold?: boolean;
  ci: CiState;
  checks?: { passed: number; failed: number; pending: number };
  /** GitHub's review decision; `none` when it has not computed one. */
  review: "approved" | "changes_requested" | "review_required" | "none";
  /** Review threads still open (outdated ones excluded). */
  unresolvedThreads?: number;
  /** false = merge conflicts; absent while GitHub is still computing it. */
  mergeable?: boolean;
}

/** Join one ref to its registry row (when the sweep tracks it). */
export function chatPrStatus(ref: PRRef, record?: PrRecord | null): ChatPrStatus {
  const s = record ? summarizeChecks(record.checks) : null;
  const unresolved = record?.threads.filter((t) => !t.isResolved && !t.isOutdated).length;
  return {
    number: ref.number,
    ...(ref.repo ?? record?.repo ? { repo: ref.repo ?? record?.repo } : {}),
    url: record?.url || ref.url,
    ...((record?.title || ref.title) ? { title: record?.title || ref.title } : {}),
    branch: record?.branch || ref.branch,
    state: record?.state ?? ref.state ?? "unknown",
    ...(record?.isDraft ? { isDraft: true } : {}),
    ...(record?.hold ? { hold: true } : {}),
    ci: s ? ciState(s) : "none",
    ...(s && s.total ? { checks: { passed: s.passed, failed: s.failed, pending: s.pending } } : {}),
    review: record?.reviewDecision ?? "none",
    ...(unresolved ? { unresolvedThreads: unresolved } : {}),
    ...(record && record.mergeable !== null ? { mergeable: record.mergeable } : {}),
  };
}

/** Every ref of a chat, joined against a key → row lookup. */
export function chatPrStatuses(
  refs: readonly PRRef[] | undefined,
  lookup: (key: string) => PrRecord | null | undefined,
): ChatPrStatus[] {
  return (refs ?? []).map((ref) => chatPrStatus(ref, ref.repo ? lookup(prRecordKey(ref.repo, ref.number)) : null));
}

/** Still in flight: neither merged nor closed. An unknown state counts — it has not been seen to land. */
export function isUnmerged(pr: Pick<ChatPrStatus, "state">): boolean {
  return pr.state === "open" || pr.state === "unknown";
}

/** `#465 open · CI failing (2/9) · changes requested · 3 threads` — one line per PR. */
export function describeChatPr(pr: ChatPrStatus): string {
  const bits: string[] = [pr.state + (pr.isDraft ? " (draft)" : "") + (pr.hold ? " (hold)" : "")];
  if (pr.state === "open" || pr.state === "unknown") {
    bits.push(
      `CI ${pr.ci}${pr.checks && pr.ci === "failing" ? ` (${pr.checks.failed} of ${pr.checks.passed + pr.checks.failed + pr.checks.pending} failed)` : ""}`,
    );
    if (pr.review !== "none") bits.push(pr.review.replace("_", " "));
    if (pr.unresolvedThreads) bits.push(`${pr.unresolvedThreads} open thread${pr.unresolvedThreads === 1 ? "" : "s"}`);
    if (pr.mergeable === false) bits.push("merge conflicts");
  }
  return `${pr.repo ? `${pr.repo}` : ""}#${pr.number} ${bits.join(" · ")}${pr.title ? ` — ${pr.title}` : ""}`;
}
