/**
 * CI rollup for the SPA. The arithmetic — what counts as failing, how a check
 * list folds into counts — lives in `@dispatch/shared` (shared/checks.ts), so
 * the server's `chat_state`/`chat_find` and every client surface agree on it.
 * Only the presentation is here.
 */
import { ciState, type CheckSummary } from "@dispatch/shared";

export { checkIsFailing, summarizeChecks, type CheckSummary } from "@dispatch/shared";

/** The one-word rollup verdict + tone — see `ciState` for the ordering rule. */
export function checksVerdict(s: CheckSummary): {
  tone: "muted" | "danger" | "warn" | "success";
  label: string;
} {
  switch (ciState(s)) {
    case "none":
      return { tone: "muted", label: "no checks" };
    case "failing":
      return { tone: "danger", label: "failing" };
    case "running":
      return { tone: "warn", label: "running" };
    case "passing":
      return { tone: "success", label: "passing" };
  }
}
