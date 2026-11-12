import type { PluginCollectionEntry, PluginDependencyState, PluginInfo, PluginInspectionDependency } from "@dispatch/shared";

/**
 * Settings → Plugins, dependencies (docs/plugins.md → "Dependencies"): the
 * decisions the pane makes on its own, kept pure so they are tested here
 * rather than by clicking. Everything about WHETHER a dependency is met is
 * the server's verdict on the report or the row; this only decides what to
 * tick, in which order to install, and who a switch-off reaches.
 */

/** Why a collection member is going to be installed. */
export type PickReason =
  /** The owner ticked it. */
  | "picked"
  /** A ticked plugin cannot run without it — ticked for them, and locked. */
  | "required"
  /** A ticked plugin can use it — ticked for them, and the owner may untick it. */
  | "recommended";

export interface CollectionPick {
  entry: PluginCollectionEntry;
  why: PickReason;
  /** The names of the ticked plugins that need or can use it. */
  neededBy: string[];
  /** It is installed already (an older copy): the install replaces it. */
  replace: boolean;
}

const label = (e: PluginCollectionEntry) => e.report?.name ?? e.report?.id ?? e.subdir;

/**
 * What "Install N" installs, provider first. `picked` are the subdirs the
 * owner ticked; `declined` the recommended ones they unticked. A pick's
 * dependency that its report says comes from this collection (`from:
 * "collection"`) is added — required ones always, optional ones unless
 * declined — and so are THEIR dependencies, transitively.
 */
export function collectionPicks(
  entries: readonly PluginCollectionEntry[],
  picked: ReadonlySet<string>,
  declined: ReadonlySet<string> = new Set(),
): CollectionPick[] {
  const bySubdir = new Map(entries.map((e) => [e.subdir, e]));
  const picks = new Map<string, CollectionPick>();
  const add = (e: PluginCollectionEntry, why: PickReason, by?: string) => {
    const have = picks.get(e.subdir);
    if (have) {
      // The strongest reason wins: a provider both ticked and required stays
      // "picked"; one recommended by A and required by B is locked.
      if (why === "picked" || (have.why === "recommended" && why === "required")) have.why = why;
      if (by && !have.neededBy.includes(by)) have.neededBy.push(by);
      return;
    }
    picks.set(e.subdir, { entry: e, why, neededBy: by ? [by] : [], replace: !!e.report?.installed });
    for (const d of e.report?.dependencies ?? []) {
      if (d.from !== "collection" || d.subdir === undefined) continue;
      const provider = bySubdir.get(d.subdir);
      if (!provider || (d.optional && declined.has(d.subdir))) continue;
      add(provider, d.optional ? "recommended" : "required", label(e));
    }
  };
  for (const e of entries) if (picked.has(e.subdir)) add(e, "picked");
  return providersFirst([...picks.values()]);
}

/** Each pick after the picks it depends on; otherwise in the collection's order. */
function providersFirst(picks: CollectionPick[]): CollectionPick[] {
  const bySubdir = new Map(picks.map((p) => [p.entry.subdir, p]));
  const out: CollectionPick[] = [];
  const seen = new Set<CollectionPick>();
  const visit = (p: CollectionPick) => {
    if (seen.has(p)) return;
    seen.add(p);
    for (const d of p.entry.report?.dependencies ?? []) {
      const provider = d.subdir !== undefined ? bySubdir.get(d.subdir) : undefined;
      if (provider) visit(provider);
    }
    out.push(p);
  };
  for (const p of picks) visit(p);
  return out;
}

/**
 * The pick a failed install takes down with it: a later pick that REQUIRES
 * one that did not install is not attempted — it would only be refused, or
 * land blocked. Returns the missing provider's label, or undefined.
 */
export function skippedFor(pick: CollectionPick, failed: ReadonlySet<string>, picks: readonly CollectionPick[]): string | undefined {
  for (const d of pick.entry.report?.dependencies ?? []) {
    if (d.optional || d.subdir === undefined || !failed.has(d.subdir)) continue;
    const provider = picks.find((p) => p.entry.subdir === d.subdir);
    return provider ? label(provider.entry) : d.id;
  }
  return undefined;
}

/**
 * Who switching `id` off (or removing it) reaches, among installed plugins:
 * `stops` need it — and so does whatever requires THEM, through any chain of
 * required uses; `degrades` can use it and keep running with less.
 */
export function dependentsReach(id: string, all: readonly PluginInfo[]): { stops: PluginInfo[]; degrades: PluginInfo[] } {
  const stops = new Map<string, PluginInfo>();
  const walk = (provider: string) => {
    for (const p of all) {
      if (p.id === id || stops.has(p.id)) continue;
      const d = p.dependencies?.find((x) => x.id === provider);
      if (!d || d.optional) continue;
      stops.set(p.id, p);
      walk(p.id);
    }
  };
  walk(id);
  const degrades = all.filter((p) => !stops.has(p.id) && p.dependencies?.some((d) => d.id === id && d.optional));
  return { stops: [...stops.values()], degrades };
}

/** How a dependency's state reads at a glance. */
export function dependencyTone(state: PluginDependencyState): "success" | "warn" | "danger" | "muted" {
  if (state === "ok") return "success";
  if (state === "disabled" || state === "not-served") return "warn";
  if (state === "cycle" || state === "missing" || state === "incompatible" || state === "invalid") return "danger";
  return "warn";
}

/** Where an inspected dependency would come from, in a few words. */
export function dependencySource(d: PluginInspectionDependency): string {
  if (d.from === "collection") return `from this collection${d.found ? ` (v${d.found})` : ""} — installed with it`;
  if (d.from === "installed") return d.state === "ok" ? `installed${d.found ? ` (v${d.found})` : ""}` : d.detail;
  return d.detail;
}
