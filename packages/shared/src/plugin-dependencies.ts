/**
 * Plugin dependencies — one plugin calling another's API.
 *
 * A consumer's manifest names the plugins it uses and which of their exports
 * (`dependencies: { remote-host: { uses: [machines@1] } }`); a provider's names
 * what it exports (`provides: { machines: [1] }`). This file is the grammar
 * both are validated with and the resolver that turns a set of installed
 * plugins into an activation order and a verdict per dependency. It is pure:
 * the server runs it at every boot, and the inspector runs it to say what an
 * install would leave behind, so the two cannot disagree.
 *
 * It must not import `plugin-manifest.ts` (or anything that does) for values:
 * the manifest schema imports the patterns below while it is being built, and
 * an ES-module cycle would hand it `undefined`.
 *
 * See docs/plugins.md → "Dependencies".
 */

/* ------------------------------------------------------------- grammar */

/** An export's name: `machines`. A path segment of nothing, but kept as strict as an id. */
export const PLUGIN_EXPORT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** One `uses:` entry: `<export>@<major>`, e.g. `machines@1`. */
export const PLUGIN_USE_PATTERN = /^([a-z][a-z0-9-]{0,31})@([1-9]\d{0,2})$/;

/** At most this many dependencies, and this many exports, per manifest. */
export const MAX_PLUGIN_DEPENDENCIES = 8;
export const MAX_PLUGIN_EXPORTS = 8;

/** `machines@1` → `{ name: "machines", major: 1 }`; null for anything else. */
export function parsePluginUse(use: string): { name: string; major: number } | null {
  const m = PLUGIN_USE_PATTERN.exec(use);
  return m ? { name: m[1]!, major: Number(m[2]) } : null;
}

/* ------------------------------------------------------- semver ranges */

interface Version {
  nums: [number, number, number];
  pre?: string[];
}

const FULL_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A plugin's own `version` (x.y.z, optional prerelease and build). Null when it is not one. */
function parseVersion(s: string): Version | null {
  const m = FULL_VERSION.exec(s.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], ...(m[4] ? { pre: m[4].split(".") } : {}) };
}

/** Semver precedence. Prerelease identifiers compare field by field; numeric ones sort below alphanumeric ones. */
function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i]! - b.nums[i]!;
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Semver precedence of two version strings, or null when either is not one.
 * The inspector uses it for "newer / older than what is installed".
 */
export function compareSemver(a: string, b: string): number | null {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  return va && vb ? Math.sign(compare(va, vb)) : null;
}

type Op = ">=" | ">" | "<=" | "<" | "=";
interface Comparator {
  op: Op;
  v: Version;
}

/** The lowest version of `[major, minor, patch]`, prereleases included: `x.y.z-0`. */
const floorOf = (nums: [number, number, number]): Version => ({ nums, pre: ["0"] });

/**
 * One clause of a range as comparators, or null when it is not one. Partial
 * versions mean "any in this place": `1` is `>=1.0.0 <2.0.0-0`, `1.2` is
 * `>=1.2.0 <1.3.0-0`, and an `x` or `*` in a place ends it there.
 */
function clauseComparators(clause: string): Comparator[] | null {
  const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(clause);
  if (!m) return null;
  const op = m[1] ?? "";
  const parts = [m[2], m[3], m[4]];
  const wild = (p: string | undefined) => p === undefined || p === "x" || p === "X" || p === "*";
  // How many leading places are real numbers; after the first wildcard, the rest must be too.
  let given = 0;
  while (given < 3 && !wild(parts[given])) given++;
  if (parts.slice(given).some((p) => p !== undefined && !wild(p))) return null;
  const pre = m[5];
  if (pre && given < 3) return null; // `1.2-beta` is not a version
  const n = (i: number) => (i < given ? Number(parts[i]) : 0);
  const base: [number, number, number] = [n(0), n(1), n(2)];
  const lower: Version = pre ? { nums: base, pre: pre.split(".") } : { nums: base };
  if (given === 0) {
    // `*`, `x`, `>=*`: anything. `<*` and `>*` admit nothing, which no-one writes on purpose.
    return op === "" || op === "=" || op === ">=" || op === "<=" || op === "^" || op === "~" ? [] : null;
  }
  /** The first version past the place the clause names: `1` → 2.0.0, `1.2` → 1.3.0. */
  const nextAt = (place: number): [number, number, number] =>
    place === 0 ? [base[0] + 1, 0, 0] : place === 1 ? [base[0], base[1] + 1, 0] : [base[0], base[1], base[2] + 1];
  switch (op) {
    case "":
    case "=":
      return given === 3 ? [{ op: "=", v: lower }] : [{ op: ">=", v: lower }, { op: "<", v: floorOf(nextAt(given - 1)) }];
    case ">=":
      return [{ op: ">=", v: lower }];
    case ">":
      return given === 3 ? [{ op: ">", v: lower }] : [{ op: ">=", v: floorOf(nextAt(given - 1)) }];
    case "<":
      return [{ op: "<", v: given === 3 ? lower : floorOf(base) }];
    case "<=":
      return given === 3 ? [{ op: "<=", v: lower }] : [{ op: "<", v: floorOf(nextAt(given - 1)) }];
    case "~":
      // ~1.2.3 and ~1.2 pin the minor; ~1 pins the major.
      return [{ op: ">=", v: lower }, { op: "<", v: floorOf(nextAt(given >= 2 ? 1 : 0)) }];
    case "^": {
      // The leftmost non-zero place is the one that may not change.
      let place = 0;
      if (base[0] === 0 && given >= 2) place = base[1] === 0 && given === 3 ? 2 : 1;
      return [{ op: ">=", v: lower }, { op: "<", v: floorOf(nextAt(place)) }];
    }
    default:
      return null;
  }
}

function parseRange(range: string): Comparator[] | null {
  const clauses = range.trim().split(/\s+/).filter(Boolean);
  if (!clauses.length) return null;
  const out: Comparator[] = [];
  for (const c of clauses) {
    const cs = clauseComparators(c);
    if (!cs) return null;
    out.push(...cs);
  }
  return out;
}

/** Whether `range` parses — the manifest schema's check. */
export function isValidSemverRange(range: string): boolean {
  return parseRange(range) !== null;
}

/**
 * Does `version` satisfy `range`? Clauses separated by spaces AND together;
 * `||` is not supported (nothing needs it yet, and a range nobody can read
 * should be refused, not guessed at). Forms: `1.2.3`, `=1.2.3`, `>=`, `>`,
 * `<=`, `<`, `^`, `~`, partial (`1`, `1.2`) and `x`/`*` wildcards.
 *
 * A PRERELEASE version satisfies a range only when some clause names a
 * prerelease of the same x.y.z — npm's rule, so `>=0.10.0` does not quietly
 * admit `0.11.0-beta.1` that nobody asked to depend on. Unparseable input on
 * either side is `false`.
 */
export function semverRangeAccepts(range: string, version: string): boolean {
  const comps = parseRange(range);
  const v = parseVersion(version);
  if (!comps || !v) return false;
  for (const c of comps) {
    const d = compare(v, c.v);
    const ok =
      c.op === "=" ? d === 0 : c.op === ">=" ? d >= 0 : c.op === ">" ? d > 0 : c.op === "<=" ? d <= 0 : d < 0;
    if (!ok) return false;
  }
  if (!v.pre) return true;
  // A floor's `-0` is how a bound is written, not a prerelease anyone named.
  return comps.some(
    (c) => c.v.pre && !(c.v.pre.length === 1 && c.v.pre[0] === "0") && c.v.nums.every((n, i) => n === v.nums[i]),
  );
}

/* ---------------------------------------------------------- resolution */

/** One `dependencies:` entry, as the resolver reads it. */
export interface PluginDependencySpec {
  uses: string[];
  version?: string;
  optional?: boolean;
}

/**
 * Where one declared dependency stands:
 *
 *   ok            — installed, valid, enabled, in range, provides every `uses`
 *   missing       — not installed
 *   invalid       — installed, but its manifest is invalid or built for another host
 *   disabled      — switched off
 *   incompatible  — its version is outside the range, or it does not provide a `uses`
 *   blocked       — it is itself blocked by one of ITS required dependencies
 *   failed        — its `activate` threw or ran out of time (known only at run time)
 *   not-served    — it activated without serving an export it declares (known only at run time)
 *   cycle         — it depends, directly or not, on the plugin that depends on it
 */
export type PluginDependencyState =
  | "ok"
  | "missing"
  | "invalid"
  | "disabled"
  | "incompatible"
  | "blocked"
  | "failed"
  | "not-served"
  | "cycle";

export const PLUGIN_DEPENDENCY_STATES: readonly PluginDependencyState[] = [
  "ok",
  "missing",
  "invalid",
  "disabled",
  "incompatible",
  "blocked",
  "failed",
  "not-served",
  "cycle",
];

/** One plugin as the resolver sees it. */
export interface PluginDependencyNode {
  id: string;
  /** Its manifest `version`; absent when the manifest did not parse. */
  version?: string;
  /** The manifest parsed AND its `dispatch` range admits this host. */
  valid: boolean;
  enabled: boolean;
  /** Ships in the app payload. A built-in may only depend on built-ins. */
  builtin?: boolean;
  dependencies?: Record<string, PluginDependencySpec>;
  provides?: Record<string, number[]>;
}

/** The verdict on one declared dependency. */
export interface PluginDependencyStatus {
  id: string;
  uses: string[];
  optional: boolean;
  state: PluginDependencyState;
  /** A sentence for a human, naming the plugin and what is wrong. Empty when `ok`. */
  detail: string;
}

export interface PluginDependencyResolution {
  /**
   * Every node in activation order: each after everything it depends on
   * (required or optional), ties broken by id. Nodes on a cycle come in id
   * order where the cycle sits.
   */
  order: string[];
  /** Per plugin that declares any: the verdict on each of its dependencies, in manifest order. */
  dependencies: Map<string, PluginDependencyStatus[]>;
  /**
   * Plugins that must NOT activate, and why: an enabled, valid plugin with a
   * REQUIRED dependency that is not `ok`. The sentence names it.
   */
  blocked: Map<string, string>;
  /** Per provider: the installed plugins that declare a dependency on it (any status), sorted. */
  dependents: Map<string, string[]>;
}

/**
 * Resolve every plugin's dependencies against the others. Pure; `nodes` is
 * everything installed (built-ins included), valid or not.
 *
 * Only what can be known BEFORE anything runs is decided here. Whether a
 * provider's `activate` worked, and whether it served what it declared, is
 * the host's to add at run time (`failed`, `not-served`) — see
 * {@link liveDependencyState}.
 */
export function resolvePluginDependencies(nodes: readonly PluginDependencyNode[]): PluginDependencyResolution {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edgesOf = (n: PluginDependencyNode) => Object.keys(n.dependencies ?? {}).filter((d) => byId.has(d) && d !== n.id);
  const requiredEdgesOf = (n: PluginDependencyNode) => edgesOf(n).filter((d) => !n.dependencies![d]!.optional);

  // Two sets of strongly connected components. Over EVERY edge, for the
  // order: an optional dependency still starts first when it can. Over
  // REQUIRED edges only, for blocking: a cycle that an optional use closes
  // can be started (p optionally uses q, q requires p: p, then q), and
  // blocking q for it would stop a plugin over a use it never needed.
  const all = stronglyConnected([...byId.keys()], (id) => edgesOf(byId.get(id)!));
  const required = stronglyConnected([...byId.keys()], (id) => requiredEdgesOf(byId.get(id)!));
  const { componentOf, components } = all;
  const sameComponent = (scc: typeof all, a: string, b: string) => a !== b && scc.componentOf.get(a) === scc.componentOf.get(b);

  // Topological order over the components (Kahn), the ready set ordered by
  // each component's smallest id.
  const compDeps = components.map(() => new Set<number>());
  const compUsers = components.map(() => new Set<number>());
  for (const n of nodes) {
    const c = componentOf.get(n.id)!;
    for (const dep of edgesOf(n)) {
      const d = componentOf.get(dep)!;
      if (d === c) continue;
      compDeps[c]!.add(d);
      compUsers[d]!.add(c);
    }
  }
  const waiting = compDeps.map((s) => s.size);
  const ready = components.map((_, i) => i).filter((i) => waiting[i] === 0);
  const order: string[] = [];
  while (ready.length) {
    ready.sort((a, b) => components[a]![0]!.localeCompare(components[b]![0]!));
    const c = ready.shift()!;
    order.push(...requiredFirst(components[c]!));
    for (const u of compUsers[c]!) if (--waiting[u]! === 0) ready.push(u);
  }

  const dependencies = new Map<string, PluginDependencyStatus[]>();
  const blocked = new Map<string, string>();
  const dependents = new Map<string, string[]>();
  for (const id of order) {
    const node = byId.get(id)!;
    const specs = Object.entries(node.dependencies ?? {});
    if (!specs.length) continue;
    const out: PluginDependencyStatus[] = [];
    for (const [depId, spec] of specs) {
      if (depId !== id && byId.has(depId)) {
        const list = dependents.get(depId) ?? [];
        list.push(id);
        dependents.set(depId, list);
      }
      out.push({ id: depId, uses: spec.uses, optional: !!spec.optional, ...verdict(node, depId, spec) });
    }
    dependencies.set(id, out);
    if (!node.valid || !node.enabled) continue;
    const stop = out.find((d) => !d.optional && d.state !== "ok");
    if (stop) blocked.set(id, blockedReason(stop));
  }
  for (const list of dependents.values()) list.sort();
  return { order, dependencies, blocked, dependents };

  /**
   * One component's members in an order that starts each after what it
   * REQUIRES (ties by id). Only an optional use closes the loop, so this
   * always exists — except on a required cycle, whose members are blocked
   * and go in id order.
   */
  function requiredFirst(members: string[]): string[] {
    if (members.length === 1) return members;
    const inside = new Set(members);
    const needs = new Map(members.map((m) => [m, new Set(requiredEdgesOf(byId.get(m)!).filter((d) => inside.has(d)))]));
    const out: string[] = [];
    while (out.length < members.length) {
      const next = members.find((m) => !out.includes(m) && [...needs.get(m)!].every((d) => out.includes(d)));
      if (!next) return [...out, ...members.filter((m) => !out.includes(m))];
      out.push(next);
    }
    return out;
  }

  function verdict(node: PluginDependencyNode, depId: string, spec: PluginDependencySpec): { state: PluginDependencyState; detail: string } {
    const p = byId.get(depId);
    if (depId === node.id) return { state: "cycle", detail: `"${node.id}" cannot depend on itself` };
    if (!p) return { state: "missing", detail: `${depId} is not installed` };
    if (!spec.optional && sameComponent(required, node.id, depId)) {
      return { state: "cycle", detail: `dependency cycle: ${cyclePath(node.id, depId, true)}` };
    }
    // An optional use that closes a loop is the one that gives: the other
    // side starts after this plugin, so it is never there to use at start.
    // Reported, and — being optional — it blocks nothing.
    if (spec.optional && sameComponent(all, node.id, depId)) {
      return { state: "cycle", detail: `dependency cycle: ${cyclePath(node.id, depId, false)} (an optional use, so ${node.id} starts without it)` };
    }
    if (node.builtin && !p.builtin) {
      return { state: "incompatible", detail: `${depId} is not built in, and a built-in plugin can only depend on built-in plugins` };
    }
    if (!p.valid) return { state: "invalid", detail: `${depId} is installed but cannot load (its manifest is invalid, or built for another Dispatch)` };
    if (!p.enabled) return { state: "disabled", detail: `${depId} is switched off` };
    if (spec.version && !(p.version && semverRangeAccepts(spec.version, p.version))) {
      return { state: "incompatible", detail: `${depId} ${p.version ?? "(no version)"} is installed; this needs ${spec.version}` };
    }
    for (const use of spec.uses) {
      const u = parsePluginUse(use);
      const majors = u ? p.provides?.[u.name] : undefined;
      if (!u || !majors?.includes(u.major)) {
        const offered = u && p.provides?.[u.name]?.length ? ` (it provides ${p.provides[u.name]!.map((m) => `${u.name}@${m}`).join(", ")})` : "";
        return { state: "incompatible", detail: `${depId} ${p.version ?? ""} does not provide ${use}${offered}`.replace(/\s+/g, " ") };
      }
    }
    if (blocked.has(depId)) return { state: "blocked", detail: `${depId} is blocked: ${blocked.get(depId)}` };
    return { state: "ok", detail: "" };
  }

  /**
   * `a → b → … → a`: the shortest way back to `from` once it depends on `to`
   * (breadth-first over dependency edges — required ones only, when it is a
   * required cycle being named — inside their shared component).
   */
  function cyclePath(from: string, to: string, requiredOnly: boolean): string {
    const scc = requiredOnly ? required : all;
    const comp = scc.componentOf.get(from);
    const prev = new Map<string, string | null>([[to, null]]);
    const queue = [to];
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === from) break;
      for (const next of (requiredOnly ? requiredEdgesOf : edgesOf)(byId.get(cur)!).sort()) {
        if (scc.componentOf.get(next) !== comp || prev.has(next)) continue;
        prev.set(next, cur);
        queue.push(next);
      }
    }
    // Walk back from `from` to `to`: [from, …, to], then read it forwards.
    const back: string[] = [];
    for (let cur: string | null | undefined = from; cur != null; cur = prev.get(cur)) back.push(cur);
    return [from, ...back.reverse()].join(" → ");
  }
}

/**
 * Strongly connected components (Tarjan) of the graph `ids` / `edges`. Small
 * graphs — a handful of plugins — so recursion depth is not a concern.
 * Members of each component are sorted; components come out in Tarjan's order.
 */
function stronglyConnected(
  ids: readonly string[],
  edges: (id: string) => string[],
): { componentOf: Map<string, number>; components: string[][] } {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const componentOf = new Map<string, number>();
  const components: string[][] = [];
  const strong = (id: string): void => {
    idx.set(id, index);
    low.set(id, index);
    index++;
    stack.push(id);
    onStack.add(id);
    for (const dep of edges(id).sort()) {
      if (!idx.has(dep)) {
        strong(dep);
        low.set(id, Math.min(low.get(id)!, low.get(dep)!));
      } else if (onStack.has(dep)) {
        low.set(id, Math.min(low.get(id)!, idx.get(dep)!));
      }
    }
    if (low.get(id) === idx.get(id)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        componentOf.set(w, components.length);
        comp.push(w);
      } while (w !== id);
      components.push(comp.sort());
    }
  };
  for (const id of [...ids].sort()) if (!idx.has(id)) strong(id);
  return { componentOf, components };
}

/** "needs remote-host, which is switched off" — the blocked row's sentence. */
export function blockedReason(d: PluginDependencyStatus): string {
  return `needs ${d.id} (${d.uses.join(", ")}): ${d.detail}`;
}

/**
 * Fold what only the running host knows into a resolved verdict: a provider
 * that was `ok` on paper but failed to activate, or is blocked, or was
 * switched off since boot, or came up without serving what is used of it.
 * `phase` is the provider's live phase; `served`, once its `activate` has
 * resolved, the `name@major` exports it served.
 */
export function liveDependencyState(
  resolved: PluginDependencyStatus,
  provider: { phase: "pending" | "activating" | "active" | "error" | "inactive" | "blocked"; enabled: boolean; error?: string } | undefined,
  served?: { has(use: string): boolean },
): PluginDependencyStatus {
  if (resolved.state !== "ok" || !provider) return resolved;
  if (!provider.enabled) return { ...resolved, state: "disabled", detail: `${resolved.id} is switched off` };
  if (provider.phase === "error") {
    return { ...resolved, state: "failed", detail: `${resolved.id} failed to start${provider.error ? `: ${provider.error}` : ""}` };
  }
  if (provider.phase === "blocked") {
    return { ...resolved, state: "blocked", detail: `${resolved.id} is blocked${provider.error ? `: ${provider.error}` : ""}` };
  }
  if (provider.phase === "inactive") return { ...resolved, state: "disabled", detail: `${resolved.id} is not running` };
  if (provider.phase === "active" && served) {
    // Declaring an export is a promise; serving it is the provider's code
    // keeping it. One that did not is as unusable as one that is missing.
    const missing = resolved.uses.filter((u) => !served.has(u));
    if (missing.length) return { ...resolved, state: "not-served", detail: `${resolved.id} did not serve ${missing.join(", ")}` };
  }
  return resolved;
}

/* ---------------------------------------------------------- at install */

/** Where one dependency of a plugin being installed would come from. */
export type PluginInstallSource = "installed" | "collection" | "missing";

/** {@link PluginDependencyStatus}, as installing the candidate would leave it, and where it resolved. */
export interface PluginInstallDependency extends PluginDependencyStatus {
  from: PluginInstallSource;
  /** The manifest's `version` range for it, verbatim. */
  range?: string;
  /** The version that satisfies it — installed, or the collection member's. */
  found?: string;
}

/** What installing a plugin would mean for the dependency graph. */
export interface PluginInstallJudgement {
  dependencies: PluginInstallDependency[];
  /** Installed plugins that work now and would not after this (a replace that drops a major, or leaves a range). */
  breaks: Array<{ id: string; detail: string }>;
  /** Why it cannot be installed, or undefined. Always starts with "needs ". */
  refusal?: string;
}

/** States a dependency may be left in by an install without refusing it: the owner can fix them in place. */
const FIXABLE_IN_PLACE: ReadonlySet<PluginDependencyState> = new Set(["ok", "disabled", "blocked", "failed", "not-served"]);

/**
 * Judge `candidate` against what is installed, the way the next boot's
 * resolver will — it IS that resolver, run over the graph the install would
 * leave. A dependency may come from (design §1.4, in this order):
 *
 *   1. what is already installed, from any origin;
 *   2. a member of the same collection at the same sha (`collection`), which
 *      the caller installs alongside it, provider first;
 *   3. nowhere else. A manifest never names a URL to fetch: that would let one
 *      author pull code in through another's consent card.
 *
 * A REQUIRED dependency that neither satisfies refuses the install, except
 * where the owner can put it right without installing anything (switched
 * off, blocked behind something else). `installed` holds every installed
 * plugin; the candidate's own id, if installed, is what it replaces.
 */
export function judgeInstallDependencies(
  candidate: PluginDependencyNode,
  installed: readonly PluginDependencyNode[],
  collection: readonly PluginDependencyNode[] = [],
): PluginInstallJudgement {
  const others = installed.filter((n) => n.id !== candidate.id);
  const afterInstall = resolvePluginDependencies([...others, candidate]);
  const siblings = new Map(
    collection
      .filter((n) => n.id !== candidate.id)
      // A sibling replacing an installed copy keeps that copy's toggle.
      .map((n) => [n.id, { ...n, enabled: others.find((o) => o.id === n.id)?.enabled ?? true }]),
  );
  const withSiblings = siblings.size
    ? resolvePluginDependencies([...others.filter((n) => !siblings.has(n.id)), ...siblings.values(), candidate])
    : afterInstall;
  const byId = new Map(others.map((n) => [n.id, n]));

  const dependencies: PluginInstallDependency[] = (afterInstall.dependencies.get(candidate.id) ?? []).map((d) => {
    const range = candidate.dependencies?.[d.id]?.version;
    const extra = { ...(range ? { range } : {}) };
    if (d.state === "ok") return { ...d, ...extra, from: "installed", ...(byId.get(d.id)?.version ? { found: byId.get(d.id)!.version } : {}) };
    const viaSibling = withSiblings.dependencies.get(candidate.id)?.find((x) => x.id === d.id);
    const sibling = siblings.get(d.id);
    if (sibling && viaSibling?.state === "ok") {
      const was = byId.get(d.id);
      const v = sibling.version ? ` v${sibling.version}` : "";
      return {
        ...viaSibling,
        ...extra,
        from: "collection",
        ...(sibling.version ? { found: sibling.version } : {}),
        detail: was
          ? `in this collection:${v}, replacing the installed v${was.version ?? "?"} (${d.detail}) — installed with it`
          : `in this collection:${v} — installed with it`,
      };
    }
    return { ...d, ...extra, from: byId.has(d.id) ? "installed" : "missing", ...(byId.get(d.id)?.version ? { found: byId.get(d.id)!.version } : {}) };
  });

  // A replace that pulls the floor out from under an installed dependent.
  const breaks: PluginInstallJudgement["breaks"] = [];
  if (byId.size !== installed.length) {
    const before = resolvePluginDependencies(installed);
    for (const n of others) {
      if (!n.dependencies?.[candidate.id]) continue;
      const was = before.dependencies.get(n.id)?.find((x) => x.id === candidate.id);
      const now = afterInstall.dependencies.get(n.id)?.find((x) => x.id === candidate.id);
      if (was?.state === "ok" && now && now.state !== "ok") breaks.push({ id: n.id, detail: now.detail });
    }
  }

  const stop = dependencies.find((d) => !d.optional && !FIXABLE_IN_PLACE.has(d.state));
  const refusal = stop
    ? `${blockedReason(stop)}${stop.state === "missing" ? ` — install ${stop.id} first, or install this from a collection that has it` : ""}`
    : undefined;
  return { dependencies, breaks, ...(refusal ? { refusal } : {}) };
}
