/**
 * WHERE each subagent run is working on disk — the half of a run card the
 * Agents rail was missing.
 *
 * WHY this exists (the 2026-08-07 wrong-worktree incident). A session ran five
 * background subagents at once. At 02:27:45 the MAIN loop called
 * `EnterWorktree` to go commit one agent's work; `cwd` is SESSION-scoped in the
 * Agent SDK (`Options.cwd` is documented as "Current working directory for the
 * session", and `AgentDefinition` has no cwd of its own), so that one call moved
 * every non-isolated subagent still running underneath it. One of them —
 * "Fix upgrade tool findings", spawned with no `isolation` — noticed a minute
 * later ("The harness has flipped this session into a different worktree and now
 * blocks writes"), delegated its last two edits to a fresh subagent, and that
 * subagent wrote `package.json` and `RUNNING.md` into the OTHER agent's
 * worktree. A `git add -A` in that worktree came within seconds of committing
 * them onto an unrelated PR.
 *
 * Nothing on the run card said any of that. The rail said "running". So this
 * module answers, per run: which directory is it working in, what has it
 * written, and has it wandered.
 *
 * EVIDENCE, NOT INFERENCE. Every fact here comes from a path the transcript
 * literally records — `Edit`/`Write`/`NotebookEdit` carry an absolute
 * `file_path` by tool contract, `EnterWorktree` carries the worktree it moved
 * to, `Bash` carries its own `cd`. Roots are never guessed from common
 * prefixes: a root is a directory some row NAMED as one. A run whose rows
 * happen to carry no path yields an empty location rather than a plausible
 * fiction, because on this feature a confident wrong answer is worse than a
 * blank — it is the answer that would have said the stray edits were fine.
 *
 * Pure and cheap: called from the same `useMemo` that folds the runs.
 */
import type { ChatMessage, ToolUseRow } from "@dispatch/shared";

/** Tools whose call MODIFIES a file — the ones that can land in the wrong tree. */
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

/** Where a run has been working, and whether it stayed there. */
export interface RunLocation {
  /**
   * The directory this run is expected to be working in — the first root it was
   * seen in, or its spawner's home when the spawner had already been displaced
   * (see {@link deriveRunLocations} for why that inheritance matters).
   */
  home?: string;
  /** The most recent root it was observed working in. */
  current?: string;
  /** Every root it touched, in first-seen order. */
  roots: string[];
  /** Absolute paths it WROTE, deduped, in order. */
  files: string[];
  /** Roots it wrote into that are not its {@link home} — the alarm. */
  strayRoots: string[];
  /** Files it wrote outside its {@link home}. */
  strayFiles: string[];
}

/** Empty location — a run whose rows named no path at all. */
function emptyLocation(): RunLocation {
  return { roots: [], files: [], strayRoots: [], strayFiles: [] };
}

/* ------------------------------------------------------------------- paths */

/** Forward-slash, drop a trailing separator, case-fold (Windows is the host). */
function canon(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** The display form of a root — its last segment, which is the worktree name. */
export function rootLabel(root: string): string {
  const segs = root.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return segs[segs.length - 1] || root;
}

/** Is `child` at or below `root`? Segment-aware, so `/a/bc` is not under `/a/b`. */
function isUnder(child: string, root: string): boolean {
  const c = canon(child);
  const r = canon(root);
  return c === r || c.startsWith(`${r}/`);
}

/**
 * The absolute path a tool call names, when it names one.
 *
 * Deliberately narrow. `file_path` and `notebook_path` are absolute by tool
 * contract, and `EnterWorktree.path` is the worktree it switched into. A
 * relative path is dropped rather than resolved against a cwd we don't have —
 * guessing the base is exactly how a file list starts lying.
 */
function namedPath(use: ToolUseRow): string | undefined {
  const i = use.input;
  const raw =
    (typeof i.file_path === "string" && i.file_path) ||
    (typeof i.notebook_path === "string" && i.notebook_path) ||
    (use.name === "EnterWorktree" && typeof i.path === "string" && i.path) ||
    undefined;
  return raw && isAbsolutePath(raw) ? raw : undefined;
}

/** Absolute on either host: `C:\x`, `C:/x`, or a leading `/`. */
function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/");
}

/**
 * The directory a `Bash` row moved into, from a leading `cd <abs>`.
 *
 * Only a LEADING `cd` counts, and only with an absolute argument: a `cd` buried
 * mid-pipeline may never run, and a relative one would need the very cwd this
 * module is trying to establish.
 */
function bashCd(use: ToolUseRow): string | undefined {
  const cmd = typeof use.input.command === "string" ? use.input.command : "";
  const m = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(cmd);
  const path = m?.[1] ?? m?.[2] ?? m?.[3];
  return path && isAbsolutePath(path) ? path : undefined;
}

/* ------------------------------------------------------------------- roots */

/**
 * The work roots this transcript NAMED — every `EnterWorktree` target, plus any
 * root the caller already knows (the chat's own worktrees, the project
 * checkout).
 *
 * These are the only directories a path is ever attributed to. Sorted
 * longest-first so a nested root wins over its parent — a worktree inside the
 * checkout must not be read as "the checkout".
 */
export function collectWorkRoots(
  messages: ChatMessage[],
  known: string[] = [],
): string[] {
  const seen = new Map<string, string>();
  const add = (p: string): void => {
    const key = canon(p);
    if (key && !seen.has(key)) seen.set(key, p);
  };
  for (const p of known) if (p) add(p);
  for (const row of messages) {
    if (row.kind !== "tool_use") continue;
    if (row.name === "EnterWorktree" && typeof row.input.path === "string") {
      if (isAbsolutePath(row.input.path)) add(row.input.path);
    }
  }
  const named = [...seen.values()];
  for (const p of siblingRoots(named, messages)) add(p);
  return [...seen.values()].sort((a, b) => canon(b).length - canon(a).length);
}

/**
 * Roots that no row NAMED as one, recovered from the directory that holds the
 * ones that did.
 *
 * A subagent spawned with `isolation: "worktree"` gets a worktree made for it by
 * the runtime — there is no `EnterWorktree` row, and its `Agent` result carries
 * the path only as prose. Those runs were the ones left blank, which is a real
 * gap: on the incident's transcript three of eight runs could be placed and five
 * could not.
 *
 * So: a directory that DEMONSTRABLY holds two or more known roots is a worktree
 * container, and its direct children are worktrees. Two is the threshold that
 * keeps this from firing on a project checkout, whose siblings are unrelated
 * repositories rather than tasks. Still evidence, not prefix-guessing: the
 * container is established from paths the transcript named, and only the
 * segment directly beneath it is claimed.
 */
function siblingRoots(known: string[], messages: ChatMessage[]): string[] {
  // canonical parent → the distinct known roots it holds, keeping one original
  // spelling of the parent for the slicing below.
  const kids = new Map<string, Set<string>>();
  const spelling = new Map<string, string>();
  for (const r of known) {
    const parent = parentDir(r);
    if (!parent) continue;
    const key = canon(parent);
    spelling.set(key, parent);
    (kids.get(key) ?? kids.set(key, new Set()).get(key)!).add(canon(r));
  }
  const containers = [...kids.entries()]
    .filter(([, set]) => set.size >= 2)
    .map(([key]) => spelling.get(key)!);
  if (containers.length === 0) return [];

  const found = new Map<string, string>();
  for (const row of messages) {
    if (row.kind !== "tool_use") continue;
    const p = namedPath(row) ?? bashCd(row);
    if (!p) continue;
    for (const container of containers) {
      if (!isUnder(p, container) || canon(p) === canon(container)) continue;
      // The direct child of the container, in the PATH's own spelling — sliced
      // by segment count rather than by index, so a mixed-separator or
      // differently-cased container can't shift the cut.
      const segs = p.split(/[\\/]/);
      const depth = container.replace(/[\\/]+$/, "").split(/[\\/]/).length;
      const root = segs.slice(0, depth + 1).join(p.includes("\\") ? "\\" : "/");
      if (!found.has(canon(root))) found.set(canon(root), root);
      break;
    }
  }
  return [...found.values()];
}

/** The containing directory of a path, or undefined at a filesystem root. */
function parentDir(p: string): string | undefined {
  const trimmed = p.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut > 0 ? trimmed.slice(0, cut) : undefined;
}

/** The longest known root containing `path`, or undefined when none does. */
function rootOf(path: string, roots: string[]): string | undefined {
  for (const r of roots) if (isUnder(path, r)) return r;
  return undefined;
}

/* -------------------------------------------------------------- derivation */

/** A run's rows plus the identity the fold already established. */
export interface RunRowsInput {
  id: string;
  /** The run that spawned this one, when it was itself spawned by a subagent. */
  parentRunId?: string;
  rows: ChatMessage[];
}

/**
 * Locate every run, in spawn order.
 *
 * The one non-obvious rule is HOME INHERITANCE, and it is the incident in a
 * sentence. A run's home is normally just the first root it worked in — which
 * is right for an `isolation: "worktree"` subagent, whose own temp worktree
 * legitimately differs from its spawner's and must not read as a stray. But a
 * run spawned BY an already-displaced run starts life in the wrong tree, so its
 * own first root is not evidence of anything: it inherits its spawner's home
 * instead. That is exactly how "Apply two doc/config edits" came to write
 * `RUNNING.md` into another agent's branch — its first and only root was the
 * wrong one, so nothing local to it could have caught it.
 */
export function deriveRunLocations(
  runs: RunRowsInput[],
  roots: string[],
): Map<string, RunLocation> {
  const out = new Map<string, RunLocation>();
  // Runs arrive in spawn order, so a parent's home is already settled when its
  // child is located. A child that somehow precedes its parent just falls back
  // to its own first root — no worse than having no rule at all.
  for (const run of runs) {
    const loc = emptyLocation();
    out.set(run.id, loc);

    const parent = run.parentRunId ? out.get(run.parentRunId) : undefined;
    const parentDisplaced = Boolean(parent?.strayRoots.length);

    for (const row of run.rows) {
      if (row.kind !== "tool_use") continue;
      const named = namedPath(row);
      const moved = bashCd(row);
      const path = named ?? moved;
      if (!path) continue;
      const root = rootOf(path, roots);
      if (!root) continue; // outside every named root — not attributable

      if (!loc.roots.some((r) => canon(r) === canon(root))) loc.roots.push(root);
      loc.current = root;
      // Home is claimed by the first root seen — unless the spawner was already
      // off its own home, in which case this run inherits the spawner's.
      loc.home ??= parentDisplaced && parent?.home ? parent.home : root;

      if (WRITE_TOOLS.has(row.name) && named) {
        if (!loc.files.includes(named)) loc.files.push(named);
        if (loc.home && !isUnder(named, loc.home)) {
          if (!loc.strayRoots.some((r) => canon(r) === canon(root))) {
            loc.strayRoots.push(root);
          }
          if (!loc.strayFiles.includes(named)) loc.strayFiles.push(named);
        }
      }
    }
  }
  return out;
}
