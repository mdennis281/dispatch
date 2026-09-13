/**
 * IssueProvider — the seam between Dispatch and one issue tracker.
 *
 * Everything above this interface (the `dispatch-issues` MCP, the watcher, the
 * config route) speaks the neutral types in `@dispatch/shared/issues`. A tracker
 * is added by implementing this once; nothing else should need to learn its name.
 *
 * Deliberately narrow: the operations an agent handling an issue actually needs,
 * not a mirror of any one tracker's API. A method that only one provider could
 * honour does not belong here.
 */
import type {
  Issue,
  IssueComment,
  IssuePatch,
  IssueProviderId,
  IssueSource,
  IssueState,
} from "@dispatch/shared";

export interface IssueListQuery {
  /** Default `open`. `all` = both. */
  state?: IssueState | "all";
  /** Only issues carrying ALL of these labels. */
  labels?: string[];
  /** Newest first. Capped by the provider (100 on GitHub). */
  limit?: number;
}

export interface IssueProvider {
  readonly id: IssueProviderId;
  /** Issues only — a tracker that also lists pull/merge requests filters them out. */
  list(source: IssueSource, query?: IssueListQuery): Promise<Issue[]>;
  /** Null when there is no such issue (or the number is a pull request). */
  get(source: IssueSource, number: number): Promise<Issue | null>;
  /** The most recent `limit` comments, oldest first. */
  comments(source: IssueSource, number: number, limit?: number): Promise<IssueComment[]>;
  comment(source: IssueSource, number: number, body: string): Promise<{ id: string; url?: string }>;
  /** Apply a patch and return the issue as it now stands. */
  update(source: IssueSource, number: number, patch: IssuePatch): Promise<Issue>;
}
