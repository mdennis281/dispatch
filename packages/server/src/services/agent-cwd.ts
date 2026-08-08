/**
 * AgentCwdTracker — keep a subagent writing in the worktree it started in.
 *
 * WHY (the 2026-08-07 wrong-worktree incident). A session ran five background
 * subagents at once. At 02:27:45 its MAIN loop called `EnterWorktree` to go
 * commit one agent's finished work in that agent's worktree. Fifty-three
 * seconds later a DIFFERENT subagent — "Fix upgrade tool findings", spawned with
 * no `isolation`, still running — found itself in that same directory, said so
 * out loud ("The harness has flipped this session into a different worktree and
 * now blocks writes to the target directory"), and delegated its last two edits
 * to a fresh subagent. That subagent wrote `package.json` and `RUNNING.md` into
 * the other agent's worktree. A `git add -A` there came within seconds of
 * committing them onto an unrelated PR; it was caught only because the diff
 * didn't make sense.
 *
 * WHY IT CANNOT SIMPLY BE PINNED. `cwd` is SESSION-scoped in the Agent SDK, not
 * thread-scoped: `Options.cwd` is documented as "Current working directory for
 * the session", `SDKSystemMessage` carries one `cwd`, and `AgentDefinition` has
 * no `cwd` field at all — so there is no per-subagent working directory for
 * Dispatch to set. `EnterWorktree` / `ExitWorktree` mutate that single value out
 * from under every thread (the SDK even ships a `CwdChanged` hook, with
 * `old_cwd` / `new_cwd`, to announce it). Whether a subagent gets its own
 * directory is decided by the `isolation` argument the MODEL passes to the
 * `Agent` tool, which never reaches this side. Prevention is the runtime's to
 * offer; it does not currently offer it.
 *
 * SO THIS DETECTS AND REFUSES. `PreToolUse` fires for subagent calls too and
 * carries the real `cwd` of the call, which makes it the one place on this side
 * that can see a thread move. Each subagent thread claims the worktree of its
 * first filesystem-touching call, and a later WRITE into a different worktree is
 * denied with the reason — the hook runs under `bypassPermissions`, which is
 * exactly the posture the incident happened in.
 *
 * Two rules earn their complexity, and both come straight from the transcript:
 *
 *   - THE MAIN LOOP IS NEVER WRONG. It is the human's agent; moving between
 *     worktrees is its job (the house flow has agents create and enter their own
 *     — see worktree-detector.ts). It re-pins wherever it goes and is never
 *     blocked.
 *   - A RUN SPAWNED BY A DISPLACED RUN INHERITS ITS PIN. The subagent that
 *     actually wrote the stray files only ever saw the wrong worktree, so its
 *     own first sighting is worthless as a pin. Taking the spawner's pin instead
 *     is what closes the hole — and taking the spawner's *pin* rather than its
 *     *current location* is what keeps an `isolation: "worktree"` subagent,
 *     which legitimately starts life somewhere else, from being flagged.
 *
 * Only Edit/Write-shaped tools are refused. A `Bash` that `cd`s into another
 * worktree to read is normal and constant here, and a guard with false
 * positives gets switched off.
 */
import { dirname, isAbsolute, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Default key for the main loop. The broker passes its OWN constant through
 * `mainThread` so the two can never drift into disagreeing about which thread
 * is the human's — the whole guard hangs on that one distinction.
 */
export const MAIN_THREAD = "__main__";

/** Tools whose call MODIFIES a file — the only ones this guard refuses. */
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

/** One thread's disk position. */
export interface ThreadLocation {
  /** Run id (the spawning `Agent`/`Task` tool_use id), or {@link MAIN_THREAD}. */
  thread: string;
  /** The worktree this thread is held to. */
  pinned: string;
  /** The worktree its most recent call ran in. */
  current: string;
  /** True once `current` left `pinned` — the thread has been moved. */
  displaced: boolean;
  /** Absolute paths it wrote outside `pinned` (refused ones included). */
  strayWrites: string[];
}

/** What the hook saw. Mirrors the fields of the SDK's `PreToolUse` input. */
export interface CwdObservation {
  /** The run this call belongs to; {@link MAIN_THREAD} for the main loop. */
  thread: string;
  toolName: string;
  /** `BaseHookInput.cwd` — the directory the runtime ran this call in. */
  cwd: string;
  input: Record<string, unknown>;
}

/** A refusal, or null to let the call through. */
export interface CwdRefusal {
  reason: string;
  /** The worktree the thread should be writing in. */
  pinned: string;
  /** The worktree the write was aimed at. */
  attempted: string;
}

export interface AgentCwdTrackerDeps {
  /**
   * The worktree (or checkout) root containing `path` — the nearest ancestor
   * holding a `.git`. Injectable so the rules are testable without a real repo.
   * Returns null for a path in no repo at all, which this guard ignores: a
   * subagent writing to a temp dir is not the failure being prevented.
   */
  resolveRoot?: (path: string) => Promise<string | null>;
  /** The run that spawned `thread`, when a subagent spawned it. */
  parentOf?: (thread: string) => string | undefined;
  /** Called the first time a thread is seen off its pin. */
  onDisplaced?: (loc: ThreadLocation) => void;
  /** Called when a write is refused. */
  onRefused?: (loc: ThreadLocation, refusal: CwdRefusal) => void;
  /** The caller's key for the main loop. Defaults to {@link MAIN_THREAD}. */
  mainThread?: string;
}

export class AgentCwdTracker {
  private readonly threads = new Map<string, ThreadLocation>();
  private readonly resolveRoot: (path: string) => Promise<string | null>;
  private readonly parentOf: (thread: string) => string | undefined;
  private readonly mainThread: string;
  private readonly deps: AgentCwdTrackerDeps;
  /** Root lookups are filesystem walks; the same directories recur constantly. */
  private readonly rootCache = new Map<string, Promise<string | null>>();

  constructor(deps: AgentCwdTrackerDeps = {}) {
    this.deps = deps;
    this.resolveRoot = deps.resolveRoot ?? findWorktreeRoot;
    this.parentOf = deps.parentOf ?? (() => undefined);
    this.mainThread = deps.mainThread ?? MAIN_THREAD;
  }

  /** Every located thread, main loop first. Backs diagnostics + the notice text. */
  locations(): ThreadLocation[] {
    return [...this.threads.values()];
  }

  get(thread: string): ThreadLocation | undefined {
    return this.threads.get(thread);
  }

  /**
   * Record one tool call and decide whether it may proceed.
   *
   * Never throws: a filesystem hiccup resolving a root has to mean "allow",
   * because a guard that fails closed on a `stat` error would block real work
   * for a reason nobody could act on.
   */
  async observe(obs: CwdObservation): Promise<CwdRefusal | null> {
    try {
      return await this.decide(obs);
    } catch {
      return null;
    }
  }

  private async decide(obs: CwdObservation): Promise<CwdRefusal | null> {
    const isWrite = WRITE_TOOLS.has(obs.toolName);
    // Where this call ACTS: the file it names when it names one (absolute by
    // tool contract), else the directory it ran in.
    const target = writeTarget(obs) ?? obs.cwd;
    if (!target) return null;
    const root = await this.rootFor(target);
    if (!root) return null; // outside any repo — not this guard's business

    if (obs.thread === this.mainThread) {
      // The main loop re-pins wherever it goes; see the module header.
      const main = this.threads.get(this.mainThread);
      if (main) {
        main.pinned = root;
        main.current = root;
        main.displaced = false;
      } else {
        this.threads.set(this.mainThread, {
          thread: this.mainThread,
          pinned: root,
          current: root,
          displaced: false,
          strayWrites: [],
        });
      }
      return null;
    }

    let loc = this.threads.get(obs.thread);
    if (!loc) {
      // First sighting. Claim this root — unless the thread that spawned this
      // one had already been moved, in which case this thread's own starting
      // point is evidence of nothing and it inherits the spawner's pin.
      const parentId = this.parentOf(obs.thread);
      const parent = parentId ? this.threads.get(parentId) : undefined;
      const inherited = parent?.displaced ? parent.pinned : undefined;
      loc = {
        thread: obs.thread,
        pinned: inherited ?? root,
        current: root,
        displaced: false,
        strayWrites: [],
      };
      this.threads.set(obs.thread, loc);
    }

    loc.current = root;
    if (samePath(root, loc.pinned)) {
      loc.displaced = false;
      return null;
    }
    if (!loc.displaced) {
      loc.displaced = true;
      this.deps.onDisplaced?.(loc);
    }
    if (!isWrite) return null;

    const refusal: CwdRefusal = {
      pinned: loc.pinned,
      attempted: root,
      reason:
        `This subagent started work in ${loc.pinned} but this write targets ` +
        `${target}, which is in a different worktree (${root}). Worktrees belong to ` +
        `other tasks — a file written into one lands on someone else's branch and gets ` +
        `swept into their commit. The session's working directory can move underneath a ` +
        `running subagent, so do not trust a relative path or your own idea of "here": ` +
        `write to an absolute path under ${loc.pinned}. If you genuinely need to change ` +
        `another worktree, say so and stop instead.`,
    };
    if (!loc.strayWrites.includes(target)) loc.strayWrites.push(target);
    this.deps.onRefused?.(loc, refusal);
    return refusal;
  }

  private rootFor(path: string): Promise<string | null> {
    const dir = isFileish(path) ? dirname(path) : path;
    const key = canon(dir);
    let hit = this.rootCache.get(key);
    if (!hit) {
      hit = this.resolveRoot(dir).catch(() => null);
      this.rootCache.set(key, hit);
    }
    return hit;
  }
}

/* ======================================================== path + fs helpers */

/** Forward-slash, drop a trailing separator, case-fold (Windows is the host). */
function canon(p: string): string {
  return resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Two paths point at the same place. */
export function samePath(a: string, b: string): boolean {
  return canon(a) === canon(b);
}

/**
 * The path a call WRITES, when it names one.
 *
 * A relative `file_path` is resolved against the call's own cwd — which is the
 * very value that moved, and therefore exactly the case that must be caught
 * rather than waved through.
 */
function writeTarget(obs: CwdObservation): string | undefined {
  if (!WRITE_TOOLS.has(obs.toolName)) return undefined;
  const i = obs.input;
  const raw =
    (typeof i.file_path === "string" && i.file_path) ||
    (typeof i.notebook_path === "string" && i.notebook_path) ||
    undefined;
  if (!raw) return undefined;
  return isAbsolute(raw) ? raw : resolve(obs.cwd || ".", raw);
}

/** Does this path look like a file (has an extension in its last segment)? */
function isFileish(p: string): boolean {
  const last = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return /\.[^.\\/]+$/.test(last);
}

/**
 * The worktree root containing `dir`: the nearest ancestor with a `.git` entry.
 *
 * A linked worktree has `.git` as a FILE, the primary checkout as a directory —
 * either one ends the walk, because both are roots a task can own. Not derived
 * from the project's configured `worktreeRoot`: the worktrees in the incident
 * were made by the runtime under `.claude/worktrees/`, which no project manifest
 * knows about.
 */
export async function findWorktreeRoot(dir: string): Promise<string | null> {
  let cur = resolve(dir);
  for (;;) {
    try {
      await stat(join(cur, ".git"));
      return cur;
    } catch {
      /* not here — keep walking up */
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
