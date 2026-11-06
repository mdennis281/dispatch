/**
 * The command palette's transcript search — wire types.
 *
 * One NDJSON stream per query: the server walks chats NEWEST-FIRST in 24-hour
 * windows (the last day, then the day before, …) and emits a frame per page it
 * finishes, so the palette's results grow while you watch instead of waiting on
 * a sweep of every transcript ever written. The walk ends when it runs out of
 * chats, or when the client drops the connection (palette closed, query
 * changed, chat picked) — which is the only cancel there is, and the only one
 * needed.
 */

/** One chat whose transcript (or title) matched. */
export interface ChatSearchHit {
  chatId: string;
  title: string;
  projectId: string;
  projectName?: string;
  archived?: boolean;
  /** The chat's last activity (epoch ms) — what placed it in its window. */
  at: number;
  /** Similarity in [0,1] — the best of the title and every hit row. */
  score: number;
  /** The best-matching passage, or the title itself on a title-only match. */
  snippet: string;
  /** Row kind the snippet came from: `user`, `assistant`, or `title`. */
  kind: string;
  /** The matching row's id, when the snippet came from a row. */
  messageId?: string;
}

export type ChatSearchFrame =
  | {
      type: "hits";
      hits: ChatSearchHit[];
      /** How far back the walk has now reached, in whole days. */
      daysBack: number;
      /** Chats inside the windows covered so far (searched, matched or not). */
      searched: number;
      /** Chats the walk will cover in total. */
      total: number;
    }
  | { type: "done"; searched: number; total: number; daysBack: number }
  | { type: "error"; error: string };
