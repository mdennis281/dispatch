/**
 * How a ledger value READS, in one place.
 *
 * The server labels a group by its raw stored value, because that is the only
 * thing it can honestly do: a project id is a nanoid and an agent id is a slug,
 * and the names behind them live in the client's project store. The category
 * enum is worse — `manager` is a correct key and a poor label.
 *
 * This existed twice before it existed once: the breakdown table mapped
 * categories to titles while the legend and the tooltip printed the raw enum, so
 * the same series was "Manager MCP" in the table and "manager" six pixels above
 * it. One resolver, used by all three.
 *
 * Each ledger exposes the resolver TWICE: once with the dimension as an
 * argument ({@link useMetricLabels}) and once bound to a single dimension
 * ({@link useMetricLabel}). The bound form is what a chart or a table wants —
 * it groups by exactly one thing. The unbound form is what the filter row
 * wants, because it renders one picker PER dimension and a hook called in a
 * loop is not a hook.
 *
 * Every resolver is MEMOISED on what it reads. The charts are `React.memo`'d
 * and take the labeller as a prop, so a fresh closure per render would redraw
 * every Recharts mark on every store write — a `refetching` flip included.
 */
import {
  METRIC_ACTIVITY_CLASS_LABELS,
  METRIC_CATEGORY_LABELS,
  METRIC_OTHER_KEY,
  METRIC_STATE_LABELS,
  stripTitleMarks,
  type MetricDimension,
  type MetricSpanDimension,
} from "@dispatch/shared";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useChats } from "../../stores/chats.js";
import { useProjects } from "../../stores/projects.js";

/** Resolve a group key to what a human should see. */
export type MetricLabeller = (key: string, fallback?: string) => string;

/** The same, for a page that has to label several dimensions at once. */
export type DimLabeller<D extends string> = (dim: D, key: string, fallback?: string) => string;

/**
 * The usage ledger's resolver, over every dimension.
 *
 * `fallback` is the server's own label, which already spells out what a null
 * column MEANS for this dimension ("(default agent)", "(main loop)") — so this
 * only has to handle the ids and enums the server couldn't resolve.
 *
 * A project or agent that no longer exists falls through to its raw id rather
 * than to a blank: it still owns rows, and history is most surprising exactly
 * where the thing that made it is gone.
 */
export function useMetricLabels(): DimLabeller<MetricDimension> {
  const projects = useProjects((s) => s.projects);
  const agents = useProjects((s) => s.agents);
  return useMemo<DimLabeller<MetricDimension>>(
    () => (dim, key, fallback) => {
      const raw = fallback ?? key;
      if (key === "" || key === METRIC_OTHER_KEY) return raw;
      switch (dim) {
        case "projectId":
          return projects.find((p) => p.id === key)?.name ?? raw;
        case "agent":
          return agents.find((a) => a.id === key)?.name ?? raw;
        case "category":
          return METRIC_CATEGORY_LABELS[key as keyof typeof METRIC_CATEGORY_LABELS] ?? raw;
        default:
          return raw;
      }
    },
    [projects, agents],
  );
}

/** The usage resolver, bound to the one dimension a chart is grouped by. */
export function useMetricLabel(dim: MetricDimension): MetricLabeller {
  const labels = useMetricLabels();
  return useMemo<MetricLabeller>(
    () => (key, fallback) => labels(dim, key, fallback),
    [labels, dim],
  );
}

/**
 * The runtime ledger's resolver.
 *
 * Three differences from the usage one, all of them because the runtime page
 * groups by things the usage page never did:
 *
 *   - `state` and `class` are enums with authored labels, like `category`.
 *   - `chatId` is the dimension that answers "which chat owns the window", and
 *     a nanoid answers it uselessly — so it resolves through the chats store to
 *     the chat's own title, with its bold marks stripped (a title reads
 *     `**MCP server**: …` on the wire and must not print its asterisks here).
 *   - `runId` is a `Task` tool_use id, which has no prettier form. It keeps its
 *     raw value, and the EMPTY one — the chat's main loop, and the majority
 *     group in almost every window — keeps the server's `(main loop)`.
 *
 * Chats from other projects may not be hydrated in this client's store; those
 * fall through to the raw id for the same reason a deleted project does.
 */
export function useSpanLabels(): DimLabeller<MetricSpanDimension> {
  const projects = useProjects((s) => s.projects);
  const agents = useProjects((s) => s.agents);
  // Titles only, compared shallowly. Subscribing to `byId` itself re-rendered
  // the whole Runtime page on every chat upsert — and a running chat upserts
  // on every status and activity tick, which is precisely while someone is
  // watching this page.
  const titles = useChats(useShallow(chatTitles));
  return useMemo<DimLabeller<MetricSpanDimension>>(
    () => (dim, key, fallback) => {
      const raw = fallback ?? key;
      // The empty key is a REAL group (the main loop, the default agent, an
      // unclassified column), not a missing one — the server has already spelled
      // out what it means for this dimension, so never overwrite that.
      if (key === "" || key === METRIC_OTHER_KEY) return raw;
      switch (dim) {
        case "state":
          return METRIC_STATE_LABELS[key as keyof typeof METRIC_STATE_LABELS] ?? raw;
        case "class":
          return (
            METRIC_ACTIVITY_CLASS_LABELS[key as keyof typeof METRIC_ACTIVITY_CLASS_LABELS] ?? raw
          );
        case "projectId":
          return projects.find((p) => p.id === key)?.name ?? raw;
        case "agent":
          return agents.find((a) => a.id === key)?.name ?? raw;
        case "chatId": {
          const title = titles[key];
          return title ? stripTitleMarks(title) : raw;
        }
        default:
          return raw;
      }
    },
    [projects, agents, titles],
  );
}

/** id → title for every chat the client holds. */
function chatTitles(s: ReturnType<typeof useChats.getState>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id in s.byId) {
    const t = s.byId[id]!.title;
    if (t) out[id] = t;
  }
  return out;
}

/** The runtime resolver, bound to the one dimension a chart is grouped by. */
export function useSpanLabel(dim: MetricSpanDimension): MetricLabeller {
  const labels = useSpanLabels();
  return useMemo<MetricLabeller>(
    () => (key, fallback) => labels(dim, key, fallback),
    [labels, dim],
  );
}
