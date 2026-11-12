/**
 * A report's dependencies, judged — design §1.4. Kept apart from the scan
 * because it is judged more than once per report: `inspectPluginDir` judges
 * against what is installed; a collection judges each member again with its
 * siblings; a catalog's cached report is judged again on every read, since
 * what is installed moves under a cache that lives for hours.
 */
import {
  judgeInstallDependencies,
  parsePluginUse,
  pluginDependencyLine,
  type PluginDependencyNode,
  type PluginInspection,
  type PluginInspectionDependency,
} from "@dispatch/shared";

/** An installed plugin as the judgement reads it: the resolver's node, and the name to say. */
export type NamedDependencyNode = PluginDependencyNode & { name?: string };

/** A sibling in the same collection at the same sha, installable with the one being judged. */
export interface CollectionSibling {
  node: NamedDependencyNode;
  subdir: string;
}

/**
 * A dependency refusal starts with this, and no other refusal does — so a
 * re-judgement can replace its own refusal and keep any other.
 */
const DEPENDENCY_REFUSAL = "needs ";

/** The resolver's node for the plugin a report describes, or undefined for one it cannot place (no valid manifest). */
export function nodeOfReport(r: PluginInspection, enabled = true): NamedDependencyNode | undefined {
  if (!r.valid || !r.id) return undefined;
  const provides: Record<string, number[]> = {};
  for (const use of r.provides ?? []) {
    const p = parsePluginUse(use);
    if (p) (provides[p.name] ??= []).push(p.major);
  }
  return {
    id: r.id,
    ...(r.version ? { version: r.version } : {}),
    ...(r.name ? { name: r.name } : {}),
    valid: r.compatibility.compatible,
    enabled,
    ...(r.dependencies?.length
      ? {
          dependencies: Object.fromEntries(
            r.dependencies.map((d) => [d.id, { uses: [...d.uses], ...(d.optional ? { optional: true } : {}), ...(d.range ? { version: d.range } : {}) }]),
          ),
        }
      : {}),
    ...(Object.keys(provides).length ? { provides } : {}),
  };
}

/**
 * `report` with its `dependencies`, `breaks`, `installable` and `refusal`
 * judged against `installed` and `siblings`. A report that declares no
 * dependencies and replaces nothing anyone uses comes back unchanged.
 */
export function judgeReportDependencies(
  report: PluginInspection,
  installed: readonly NamedDependencyNode[],
  siblings: readonly CollectionSibling[] = [],
): PluginInspection {
  const candidate = nodeOfReport(report, installed.find((n) => n.id === report.id)?.enabled ?? true);
  if (!candidate) return report;
  const j = judgeInstallDependencies(
    candidate,
    installed,
    siblings.map((s) => s.node),
  );
  const names = new Map<string, string>();
  for (const n of [...installed, ...siblings.map((s) => s.node)]) if (n.name) names.set(n.id, n.name);
  const subdirs = new Map(siblings.map((s) => [s.node.id, s.subdir]));
  const dependencies: PluginInspectionDependency[] = j.dependencies.map((d) => {
    const name = names.get(d.id);
    const subdir = d.from === "collection" ? subdirs.get(d.id) : undefined;
    return { ...d, ...(name ? { name } : {}), ...(subdir !== undefined ? { subdir } : {}), line: pluginDependencyLine(d, name) };
  });
  const otherRefusal = report.refusal && !report.refusal.startsWith(DEPENDENCY_REFUSAL) ? report.refusal : undefined;
  const refusal = otherRefusal ?? j.refusal;
  const { refusal: _old, breaks: _oldBreaks, ...rest } = report;
  return {
    ...rest,
    ...(dependencies.length ? { dependencies } : {}),
    ...(j.breaks.length ? { breaks: j.breaks } : {}),
    installable: !refusal,
    ...(refusal ? { refusal } : {}),
  };
}

/**
 * Every member of a collection judged with the others as siblings: a member
 * whose provider is listed beside it is installable, provider first.
 */
export function judgeCollection<T extends { subdir: string; report?: PluginInspection }>(
  members: readonly T[],
  installed: readonly NamedDependencyNode[],
): T[] {
  const siblings: CollectionSibling[] = members.flatMap((m) => {
    const node = m.report ? nodeOfReport(m.report) : undefined;
    return node ? [{ node, subdir: m.subdir }] : [];
  });
  return members.map((m) =>
    m.report ? { ...m, report: judgeReportDependencies(m.report, installed, siblings.filter((s) => s.subdir !== m.subdir)) } : m,
  );
}
