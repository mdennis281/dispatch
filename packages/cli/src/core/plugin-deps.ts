/**
 * Plugin dependencies for the CLI (docs/plugins.md → "Dependencies"): the
 * same shared install judgement the server's Inspect uses, over what is
 * installed under `<configDir>/plugins/`.
 *
 * One blind spot the server does not have: the CLI cannot see the BUILT-IN
 * plugins — they ship in the app payload, not the config dir — and a user
 * plugin may depend on one. So a required dependency that is simply ABSENT
 * here is a warning (the plugin shows `blocked` until it arrives, which is
 * harmless), never a refusal the owner has no way round. Everything the CLI
 * can see for certain — an installed provider that is too old or does not
 * offer the export, a collection member left out, a replace that breaks an
 * installed plugin — refuses, as the app does.
 */
import {
  judgeInstallDependencies,
  normaliseCollectionPath,
  type PluginDependencyNode,
  type PluginDependencyState,
  type PluginInstallJudgement,
  type PluginManifest,
} from "@dispatch/shared";
import { CmError } from "./manifest.js";
import { discoverPlugins, readPluginToggles, type CollectionMember } from "./plugins.js";

export type NamedNode = PluginDependencyNode & { name?: string };

/** The resolver's node for a manifest. */
export function nodeOfManifest(m: PluginManifest, enabled = true): NamedNode {
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    valid: true,
    enabled,
    ...(m.dependencies ? { dependencies: m.dependencies } : {}),
    ...(m.provides ? { provides: m.provides } : {}),
  };
}

/** Every plugin installed under the config dir, with its toggle — read fresh: each add changes it. */
export async function installedDependencyNodes(configDir: string): Promise<NamedNode[]> {
  const [plugins, toggles] = await Promise.all([discoverPlugins(configDir), readPluginToggles(configDir)]);
  return plugins.map((p) => ({
    id: p.id,
    ...(p.manifest?.name ? { name: p.manifest.name } : {}),
    ...(p.manifest?.version ? { version: p.manifest.version } : {}),
    valid: !!p.manifest && !p.incompatible,
    enabled: toggles[p.id] ?? true,
    ...(p.manifest?.dependencies ? { dependencies: p.manifest.dependencies } : {}),
    ...(p.manifest?.provides ? { provides: p.manifest.provides } : {}),
  }));
}

/**
 * States `judgeInstallDependencies` installs over (the owner fixes them in
 * place) — mirrored so a refusal can be split into what the CLI knows for
 * certain and what may be a built-in it cannot see.
 */
const FIXABLE: ReadonlySet<PluginDependencyState> = new Set(["ok", "disabled", "blocked", "failed", "not-served"]);

/** A judgement, read the CLI's way: refuse on what is certain, warn on what may be a built-in. */
function verdict(id: string, j: PluginInstallJudgement): { refusal?: string; warnings: string[] } {
  const stops = j.dependencies.filter((d) => !d.optional && !FIXABLE.has(d.state));
  if (!stops.length) return { warnings: [] };
  if (stops.some((d) => d.state !== "missing")) return { refusal: `${id}: ${j.refusal}`, warnings: [] };
  return {
    warnings: stops.map(
      (d) =>
        `${id} needs ${d.id} (${d.uses.join(", ")}), which is not installed — it stays blocked until ${d.id} is ` +
        `(unless ${d.id} is built in: the CLI cannot see those)`,
    ),
  };
}

/**
 * The check `addPlugin` runs on a validated candidate before anything is
 * copied, judged against what is installed AT THAT MOMENT — so a provider
 * added earlier in the same run counts. Refuses what `verdict` refuses, and a
 * replace that breaks an installed plugin using it unless `allowBreaking` or
 * that plugin is itself being added in this run.
 */
export function dependencyCheck(
  configDir: string,
  opts: { allowBreaking?: boolean; alsoAdding?: ReadonlySet<string> } = {},
): (m: PluginManifest) => Promise<string[]> {
  return async (m) => {
    const installed = await installedDependencyNodes(configDir);
    const enabled = installed.find((n) => n.id === m.id)?.enabled ?? true;
    const j = judgeInstallDependencies(nodeOfManifest(m, enabled), installed);
    const v = verdict(m.id, j);
    if (v.refusal) throw new CmError(v.refusal);
    const breaking = j.breaks.filter((b) => !opts.alsoAdding?.has(b.id));
    if (breaking.length && !opts.allowBreaking) {
      throw new CmError(
        `replacing ${m.id} with v${m.version} breaks ${breaking.map((b) => `${b.id} (${b.detail})`).join(", ")} — ` +
          "re-run with --allow-breaking to replace it anyway",
      );
    }
    return [
      ...v.warnings,
      ...(breaking.length ? [`replacing ${m.id} breaks ${breaking.map((b) => b.id).join(", ")} — allowed by --allow-breaking`] : []),
    ];
  };
}

/** What `add <collection> --plugin …` will do, decided before anything is installed. */
export interface CollectionAddPlan {
  /** Members to add, each after the members it depends on. */
  add: CollectionMember[];
  /** Picks refused up front, with why — nothing of theirs is installed. */
  refused: Array<{ member: CollectionMember; reason: string }>;
  /** Things worth saying that refuse nothing. */
  notes: string[];
}

export type WithDeps = "none" | "required" | "all";

/** `--with-deps` → required, `--with-deps=all` → optional too. */
export function parseWithDeps(value: string | undefined): WithDeps {
  if (value === undefined) return "none";
  if (value === "" || value === "required") return "required";
  if (value === "all") return "all";
  throw new CmError(`--with-deps takes no value, or "all" (got "${value}")`);
}

/** The member a `--plugin` value names — by its path in the collection, or its id. */
export function memberNamed(members: readonly CollectionMember[], pick: string): CollectionMember | undefined {
  const n = normaliseCollectionPath(pick);
  return members.find((m) => (!("error" in n) && m.path === n.path) || m.id === pick);
}

/**
 * Plan adding `picks` out of a collection whose members are `members`.
 * `withDeps` brings in what the picks need from the same collection —
 * `required`, or `all` for optional ones too — transitively, and only where
 * nothing installed already satisfies it. A pick whose required dependency
 * is in the collection but left out is refused with the flag that fixes it.
 */
export function planCollectionAdd(
  members: readonly CollectionMember[],
  picks: readonly CollectionMember[],
  installed: readonly NamedNode[],
  withDeps: WithDeps,
): CollectionAddPlan {
  const byId = new Map(members.filter((m) => m.id && m.manifest).map((m) => [m.id!, m]));
  const chosen = new Map(picks.map((p) => [p.path, p]));
  const enabledOf = (id: string) => installed.find((n) => n.id === id)?.enabled ?? true;
  // What installed plugins cannot give it: absent, too old, not offering the
  // export. A provider that is merely switched off is the owner's to switch
  // on — the collection's copy would come in switched off too.
  const lacking = (m: PluginManifest, dep: string) => {
    const state = judgeInstallDependencies(nodeOfManifest(m, enabledOf(m.id)), installed).dependencies.find((d) => d.id === dep)?.state;
    return !!state && !FIXABLE.has(state);
  };

  if (withDeps !== "none") {
    for (let grew = true; grew; ) {
      grew = false;
      for (const p of [...chosen.values()]) {
        if (!p.manifest) continue;
        for (const [dep, spec] of Object.entries(p.manifest.dependencies ?? {})) {
          if (spec.optional && withDeps !== "all") continue;
          const member = byId.get(dep);
          if (!member || chosen.has(member.path) || !lacking(p.manifest, dep)) continue;
          chosen.set(member.path, member);
          grew = true;
        }
      }
    }
  }

  const selected = [...chosen.values()];
  const refused: CollectionAddPlan["refused"] = [];
  const notes: string[] = [];
  for (const p of selected) {
    // No manifest that validates: `addPlugin` refuses it with the reason.
    if (!p.manifest) continue;
    const siblings = selected.filter((s) => s !== p && s.manifest).map((s) => nodeOfManifest(s.manifest!, enabledOf(s.id!)));
    const j = judgeInstallDependencies(nodeOfManifest(p.manifest, enabledOf(p.manifest.id)), installed, siblings);
    const leftOut = j.dependencies.filter((d) => !FIXABLE.has(d.state) && byId.has(d.id) && !chosen.has(byId.get(d.id)!.path));
    const required = leftOut.filter((d) => !d.optional);
    if (required.length) {
      refused.push({
        member: p,
        reason: required
          .map((d) => `needs ${d.id} (${d.uses.join(", ")}): add --plugin ${byId.get(d.id)!.path || d.id}, or --with-deps`)
          .join("; "),
      });
      continue;
    }
    for (const d of leftOut) {
      notes.push(`${p.manifest.id} can use ${d.id} (optional: ${d.uses.join(", ")}) — add --plugin ${byId.get(d.id)!.path || d.id}, or --with-deps=all`);
    }
    const v = verdict(p.manifest.id, j);
    if (v.refusal) refused.push({ member: p, reason: v.refusal });
    else notes.push(...v.warnings);
  }

  // A refused provider takes down what needs it in this plan, transitively.
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of selected) {
      if (!p.manifest || refused.some((r) => r.member === p)) continue;
      const gone = Object.entries(p.manifest.dependencies ?? {}).find(
        ([dep, spec]) => !spec.optional && refused.some((r) => r.member.id === dep) && lacking(p.manifest!, dep),
      );
      if (!gone) continue;
      refused.push({ member: p, reason: `needs ${gone[0]}, which is not being installed (above)` });
      grew = true;
    }
  }

  // What `--with-deps` brought in goes only where a pick still going needs
  // it: a provider the owner never named is not installed for a pick that
  // was refused.
  const going = selected.filter((p) => !refused.some((r) => r.member === p));
  const pickPaths = new Set(picks.map((p) => p.path));
  const wanted = new Set<CollectionMember>();
  const want = (m: CollectionMember) => {
    if (wanted.has(m)) return;
    wanted.add(m);
    for (const dep of Object.keys(m.manifest?.dependencies ?? {})) {
      const provider = byId.get(dep);
      if (provider && going.includes(provider)) want(provider);
    }
  };
  for (const p of going) if (pickPaths.has(p.path)) want(p);
  return { add: providersFirst(going.filter((p) => wanted.has(p))), refused, notes };
}

/**
 * Items in an order where each comes after the items it depends on
 * (required or optional), otherwise as given — the owner's own order, where
 * the resolver's would re-sort everything by id. A cycle is cut where the
 * walk meets it; the host blocks a required one at boot anyway.
 */
export function providersFirst<T extends { id?: string; manifest?: PluginManifest }>(going: readonly T[]): T[] {
  const byId = new Map(going.filter((m) => m.id).map((m) => [m.id!, m]));
  const out: T[] = [];
  const seen = new Set<T>();
  const visit = (m: T) => {
    if (seen.has(m)) return;
    seen.add(m);
    for (const dep of Object.keys(m.manifest?.dependencies ?? {})) {
      const provider = byId.get(dep);
      if (provider) visit(provider);
    }
    out.push(m);
  };
  for (const m of going) visit(m);
  return out;
}

/**
 * The first required dependency of `m` that did not get installed in this
 * run (`notInstalled`) and that nothing installed now satisfies — a failed
 * REPLACE leaves the old provider in place, which may still do.
 */
export async function stillLacking(configDir: string, m: PluginManifest, notInstalled: ReadonlySet<string>): Promise<string | undefined> {
  const gone = Object.entries(m.dependencies ?? {}).filter(([dep, spec]) => !spec.optional && notInstalled.has(dep));
  if (!gone.length) return undefined;
  const j = judgeInstallDependencies(nodeOfManifest(m), await installedDependencyNodes(configDir));
  return gone.map(([dep]) => dep).find((dep) => !FIXABLE.has(j.dependencies.find((d) => d.id === dep)?.state ?? "missing"));
}

/**
 * Installed plugins that declare a dependency on `id`. `required` ones stop
 * without it — and so does whatever requires THEM, so the walk follows
 * required edges through; `optional` ones run with less.
 */
export function dependentsOf(nodes: readonly NamedNode[], id: string): { required: string[]; optional: string[] } {
  const required = new Set<string>();
  const walk = (provider: string) => {
    for (const n of nodes) {
      const spec = n.dependencies?.[provider];
      if (!spec || spec.optional || required.has(n.id) || n.id === id) continue;
      required.add(n.id);
      walk(n.id);
    }
  };
  walk(id);
  const optional = nodes.filter((n) => n.dependencies?.[id]?.optional && !required.has(n.id)).map((n) => n.id);
  return { required: [...required].sort(), optional: optional.sort() };
}
