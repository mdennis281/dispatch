/**
 * The project switcher's ordering and filtering, kept out of the component so
 * it can be tested without a DOM.
 */
import type { Chat, Project } from "@dispatch/shared";
import { fuzzyMatch } from "../../lib/fuzzy.js";

export type ProjectSort = "recent" | "name";

/**
 * When YOU last touched each project, epoch ms: the newest message you sent to
 * any of its chats.
 *
 * `lastUserMessageAt` rather than `updatedAt`, because `updatedAt` moves on
 * every bookkeeping write — a PR watcher settling, a title being generated, an
 * agent finishing a turn hours after you walked away. Sorting on it put the
 * project a background agent happened to be noisy in at the top, which is the
 * one you are least likely to be reaching for. A chat that predates
 * `lastUserMessageAt` falls back to its `createdAt`, and a project with no
 * chats at all to its own `createdAt` — so a project you only just added still
 * floats up rather than sinking below everything you have ever used.
 */
export function projectLastTouched(
  projects: readonly Pick<Project, "id" | "createdAt">[],
  chats: Iterable<Pick<Chat, "projectId" | "lastUserMessageAt" | "createdAt">>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of projects) out[p.id] = p.createdAt;
  for (const c of chats) {
    const prev = out[c.projectId];
    // Only projects we were asked about: the chat map also carries the global
    // pseudo-project, which the switcher lists separately.
    if (prev === undefined) continue;
    const at = c.lastUserMessageAt ?? c.createdAt;
    if (at > prev) out[c.projectId] = at;
  }
  return out;
}

export interface RankedProject {
  project: Project;
  /** Matched character indices in `project.name`, for highlighting. Empty when the query matched the path instead, or there is no query. */
  nameHits: number[];
  /** True when only the repo path matched — the row should show the path so you can see WHY it is listed. */
  pathOnly: boolean;
}

/** A path hit is worth less than a name hit: names are what you are recalling. */
const PATH_WEIGHT = 0.5;

/**
 * Filter by `query` and order the rest.
 *
 * With no query, `sort` is the order. With one, match quality leads and `sort`
 * only breaks ties: typing "disp" and pressing Enter must land on `dispatch`,
 * not on whichever project you happened to message last that also contains a
 * d, an i, an s and a p.
 */
export function rankProjects(
  projects: readonly Project[],
  opts: { query: string; sort: ProjectSort; lastTouched: Record<string, number> },
): RankedProject[] {
  const q = opts.query.trim();
  const byName = (a: Project, b: Project) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  const tiebreak =
    opts.sort === "name"
      ? byName
      : (a: Project, b: Project) =>
          (opts.lastTouched[b.id] ?? 0) - (opts.lastTouched[a.id] ?? 0) || byName(a, b);

  const scored: (RankedProject & { score: number })[] = [];
  for (const project of projects) {
    const name = fuzzyMatch(q, project.name);
    if (name) {
      scored.push({ project, nameHits: name.indices, pathOnly: false, score: name.score });
      continue;
    }
    // A path is a SUBSTRING match, never a subsequence one. Every repo path is
    // a long run of `C:\Users\<you>\projects\…`, so a subsequence over it hit
    // almost anything — "st" listed all fifteen repos, because every one of
    // them lives under `Users`.
    if (q && project.repoPath.toLowerCase().includes(q.toLowerCase())) {
      scored.push({ project, nameHits: [], pathOnly: true, score: q.length * PATH_WEIGHT });
    }
  }
  scored.sort((a, b) => b.score - a.score || tiebreak(a.project, b.project));
  return scored.map(({ score: _score, ...rest }) => rest);
}

/* ---------------------------------------------------------------- the pref */

const SORT_KEY = "dispatch:project-switcher-sort";

function backing(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked by cookie policy
  }
}

/** Remembered across sessions: how you like the list is a habit, not a moment. */
export function loadProjectSort(): ProjectSort {
  try {
    return backing()?.getItem(SORT_KEY) === "name" ? "name" : "recent";
  } catch {
    return "recent";
  }
}

export function saveProjectSort(sort: ProjectSort): void {
  try {
    backing()?.setItem(SORT_KEY, sort);
  } catch {
    // quota / policy — the choice just won't survive a reload
  }
}
