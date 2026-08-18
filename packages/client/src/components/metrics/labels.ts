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
 */
import { METRIC_CATEGORY_LABELS, METRIC_OTHER_KEY, type MetricDimension } from "@dispatch/shared";
import { useProjects } from "../../stores/projects.js";

/** Resolve a group key to what a human should see. */
export type MetricLabeller = (key: string, fallback?: string) => string;

/**
 * A labeller for one dimension.
 *
 * `fallback` is the server's own label, which already spells out what a null
 * column MEANS for this dimension ("(default agent)", "(main loop)") — so this
 * only has to handle the ids and enums the server couldn't resolve.
 *
 * A project or agent that no longer exists falls through to its raw id rather
 * than to a blank: it still owns rows, and history is most surprising exactly
 * where the thing that made it is gone.
 */
export function useMetricLabel(dim: MetricDimension): MetricLabeller {
  const projects = useProjects((s) => s.projects);
  const agents = useProjects((s) => s.agents);
  return (key, fallback) => {
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
  };
}
