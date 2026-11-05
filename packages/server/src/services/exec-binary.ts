/**
 * Spawn seam shared by every service that shells out to `git`, `gh` and the
 * OS process tools: resolves the executable ONCE per name, and keeps a running
 * account of what each command family costs the event loop.
 *
 * WHY THE RESOLUTION. On Windows execa hands every spawn to cross-spawn, which
 * runs `which.sync` over PATH × PATHEXT before `child_process.spawn` ever
 * happens. On the box this was profiled on (2026-09-19) that is 58 PATH entries
 * × 13 extensions ≈ 750 `statSync` calls per `git`/`gh` invocation — all on the
 * event loop — and with Defender and the search indexer contending for the
 * disk each one took milliseconds. One spawn cost hundreds of ms of loop time,
 * `/api/health` took 0.8–2.4 s to answer `ok`, HAProxy's check timed out, and
 * the whole app 503'd for everyone while the store underneath was perfectly
 * healthy. `which` short-circuits to a single stat when the command is already
 * an absolute path, so resolving each binary once — with async `access`, off
 * the loop — and spawning THAT removes the walk from every call after the first.
 *
 * WHY THE ACCOUNTING. That outage was invisible from inside the process: the
 * supervisor discards stdout, health said `ok`, and nothing measured the loop.
 * `execStats` is what `/api/health` and `perf.log` name when the loop stalls,
 * so the next episode says "gh from watch_pr, 40 spawns, 6 s sync" instead of
 * needing a live CPU profile to find out.
 *
 * WHY THE GATE. Resolving once was not enough. On 2026-11-04 perf.log showed
 * the stable app stalling almost every minute — `p99=12826ms max=17566ms`,
 * `git×24 sync=13578ms max=3356ms` — while the process used 0.3 of a core. The
 * remaining cost is `CreateProcess` itself, which `spawn` calls synchronously:
 * milliseconds on a quiet box, up to 3.3 s each with the machine loaded. The
 * callers fan out (`Promise.all` over several reads, several pollers landing on
 * the same tick), so a burst of N spawns ran back to back in ONE macrotask and
 * the loop was gone for the sum of them. HAProxy's health check timed out and
 * 503'd everything, and the client's 10 s pong deadline tore the WebSocket
 * down. {@link execBinary} now takes a FIFO slot per command family and a FIFO
 * turn on a global start pacer that yields the loop between starts; see the
 * gating section below for the parameters and the evidence behind them.
 */
import { access, constants } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { execa, type Options, type Result } from "execa";

/* --------------------------------------------------------------- resolution */

const resolved = new Map<string, Promise<string>>();

/** PATHEXT as cross-spawn/which read it: lower-cased, leading dot kept. */
function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM";
  return raw
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The same walk `which` does, but asynchronous and once. The FIRST hit wins —
 * PATH order, then PATHEXT order — which is also what cross-spawn would have
 * picked on every call, so the resolved binary is the one the process was
 * already running.
 */
async function walkPath(file: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const exts = windowsExtensions(env);
  // A name that already carries an extension (`gh.exe`) is tried bare first,
  // exactly as `which` does.
  const candidates = file.includes(".") ? ["", ...exts] : exts;
  for (const dir of dirs) {
    for (const ext of candidates) {
      const candidate = join(dir, file + ext);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Absolute path for `file`, memoised for the life of the process.
 *
 * Only Windows pays the PATH walk (posix `execvp` does the lookup in the
 * kernel, and cross-spawn stays out of the way there), so elsewhere the name
 * is returned untouched. A name that cannot be found is ALSO returned untouched
 * so the spawn fails exactly as it would have — `gh` not installed is a
 * condition the callers already handle and report.
 */
export function resolveBinary(file: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (process.platform !== "win32" || isAbsolute(file) || /[\\/]/.test(file)) {
    return Promise.resolve(file);
  }
  let hit = resolved.get(file);
  if (!hit) {
    hit = walkPath(file, env).then((found) => found ?? file);
    // A failed walk must not be cached: PATH may gain the tool later (an
    // install mid-session) and the memo would pin the miss forever.
    hit.then((found) => {
      if (found === file) resolved.delete(file);
    });
    resolved.set(file, hit);
  }
  return hit;
}

/** Test seam: forget every resolution. */
export function resetResolvedBinaries(): void {
  resolved.clear();
}

/* --------------------------------------------------------------- accounting */

export interface ExecStat {
  /** The command name as the caller spelled it (`git`, `gh`), not its path. */
  file: string;
  /** Spawns started (coalesced joiners are NOT spawns — see {@link coalesced}). */
  count: number;
  /**
   * Milliseconds the `execa()` CALL itself took, summed — the part that runs
   * synchronously on the event loop (command resolution + `spawn`). This is
   * the number that stalls the server; wall time below is merely latency.
   */
  syncMs: number;
  /** Milliseconds from spawn to exit, summed. */
  wallMs: number;
  /** Longest single synchronous spawn seen. */
  maxSyncMs: number;
  /**
   * Milliseconds requests spent queued at the gate (family slot + start pacer)
   * before spawning, summed. Big `waitMs` with small `syncMs` means the CAP is
   * the bottleneck — loosen it; big both means the machine is the bottleneck
   * and the cap is doing its job.
   */
  waitMs: number;
  /** Longest single wait at the gate. */
  maxWaitMs: number;
  /** Deepest the family's queue got (requests waiting, not yet spawned). */
  maxQueue: number;
  /** Requests answered by joining an identical queued call instead of spawning. */
  coalesced: number;
  /**
   * Spawns per subcommand (`status`, `worktree list`, `repo view`, …). The
   * family total says the loop is drowning in git; this says WHICH poller.
   */
  subs: Record<string, number>;
}

const stats = new Map<string, ExecStat>();

function statFor(file: string): ExecStat {
  let s = stats.get(file);
  if (!s) {
    s = {
      file,
      count: 0,
      syncMs: 0,
      wallMs: 0,
      maxSyncMs: 0,
      waitMs: 0,
      maxWaitMs: 0,
      maxQueue: 0,
      coalesced: 0,
      subs: {},
    };
    stats.set(file, s);
  }
  return s;
}

/** Snapshot of every command family's cost since the last {@link resetExecStats}. */
export function execStats(): ExecStat[] {
  return [...stats.values()]
    .map((s) => ({
      ...s,
      syncMs: Math.round(s.syncMs),
      wallMs: Math.round(s.wallMs),
      maxSyncMs: Math.round(s.maxSyncMs),
      waitMs: Math.round(s.waitMs),
      maxWaitMs: Math.round(s.maxWaitMs),
      subs: { ...s.subs },
    }))
    .sort((a, b) => b.syncMs - a.syncMs);
}

/** Start a fresh accounting window (the perf monitor rolls one per minute). */
export function resetExecStats(): void {
  stats.clear();
}

/** Leading git options that take a value as the NEXT argument. */
const GIT_VALUE_OPTS = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace"]);
/** git subcommands whose first argument is itself a verb worth keeping. */
const GIT_TWO_LEVEL = new Set(["worktree", "remote", "stash", "submodule", "config", "notes"]);

/** The first two non-option words of an argv, skipping git's global `-c x` / `-C dir`. */
function verbs(file: string, args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length && out.length < 2; i++) {
    const a = args[i]!;
    if (file === "git" && out.length === 0 && GIT_VALUE_OPTS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    out.push(a);
  }
  return out;
}

/**
 * A short label for "which kind of call is this" — `status`, `worktree list`,
 * `pr view`, `api graphql`. perf.log prints it per family.
 */
export function subcommandOf(file: string, args: readonly string[]): string {
  const [a, b] = verbs(file, args);
  if (!a) return "(none)";
  if (file === "git") return GIT_TWO_LEVEL.has(a) && b ? `${a} ${b}` : a;
  if (file === "gh") {
    if (a === "api") return b === "graphql" ? "api graphql" : "api rest";
    return b ? `${a} ${b}` : a;
  }
  return a;
}

/* ------------------------------------------------------------------ gating */

/**
 * The gate's knobs. Chosen from the 2026-11-04 perf.log, where the windows that
 * stalled carried 24–173 git spawns and 3–39 gh spawns a minute, and per-spawn
 * synchronous cost ranged from ~36 ms average (`git×173 sync=6214ms`) to
 * ~565 ms average (`git×24 sync=13578ms`) with a 3.3 s worst case.
 */
export interface SpawnGateConfig {
  /**
   * Live children allowed per command family; `default` covers any family not
   * named. git and gh get their own lanes so a slow network-bound `gh api`
   * can never hold up a local `git status`, nor the reverse.
   */
  concurrency: { default: number } & Record<string, number>;
  /**
   * Floor on the idle time between the END of one spawn's synchronous part and
   * the START of the next, across ALL families. Any gap > 0 goes through a
   * timer, which is what hands the loop back for a full turn — I/O, the health
   * probe, WebSocket pongs — between two `CreateProcess` calls.
   */
  minGapMs: number;
  /**
   * The gap also scales with how long the last spawn blocked: gap =
   * max(minGapMs, lastSync × dutyRatio). At 1 the spawns can hold the loop at
   * most half the time however slow the machine gets, and NO two spawns ever
   * run back to back in one macrotask.
   */
  dutyRatio: number;
  /**
   * After this long a live child stops counting against its family's slots.
   * Not every caller sets a timeout (worktree.ts's runner doesn't), and a git
   * wedged on an AV-locked index would otherwise hold its slot forever — six of
   * those and every git call in the server queues behind them for good. The
   * child is not killed; the gate just stops waiting for it.
   */
  leaseMs: number;
}

/**
 * The parameters, and why:
 *
 *  - minGapMs 10 — the loop needs one turn between spawns, not a sabbatical.
 *    10 ms caps the start rate around 60–100/s (Windows timers round up to the
 *    ~15.6 ms system tick), i.e. ≥ 3,600/min against a worst observed demand
 *    of ~250/min. On a healthy machine the pacer is invisible.
 *  - dutyRatio 1 — this is the part that bites under load. At 565 ms per spawn
 *    the pacer still allows ~53 starts/min — more than the 24 that window
 *    actually wanted — yet the loop is guaranteed the other half of every
 *    second, so the longest stall a burst can cause is ONE spawn (worst seen
 *    3.3 s, inside the 10 s pong deadline) instead of the burst's sum.
 *  - git 6 / gh 6 / other 4 live — enough that measured demand never queues on
 *    a healthy box (173 git/min at tens of ms wall each averages well under one
 *    live child), few enough that a burst of 20–30 polls does not put 30
 *    processes on a disk that is already the bottleneck: under load git's wall
 *    time was ~12 s each (`wall=290958ms` for 24), and piling more concurrent
 *    gits onto that only makes each of them slower.
 *  - leaseMs 30 s — git.ts's own default per-call timeout, so a healthy call
 *    is never evicted from its slot by the lease.
 */
export const DEFAULT_SPAWN_GATE: SpawnGateConfig = {
  concurrency: { default: 4, git: 6, gh: 6 },
  minGapMs: 10,
  dutyRatio: 1,
  leaseMs: 30_000,
};

let gate: SpawnGateConfig = DEFAULT_SPAWN_GATE;

/** A FIFO counting semaphore: one per command family. */
class Lane {
  private live = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly file: string) {}

  private limit(): number {
    return Math.max(1, gate.concurrency[this.file] ?? gate.concurrency.default);
  }

  /** Resolves with an idempotent release once a slot is ours. Strictly FIFO. */
  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = (): void => {
        this.live += 1;
        resolve(this.lease());
      };
      // Never jump a non-empty queue even when a slot is free — that is the
      // difference between FIFO and "whoever happens to ask right after a
      // release", and the latter can starve a request indefinitely.
      if (this.waiters.length === 0 && this.live < this.limit()) grant();
      else this.waiters.push(grant);
    });
  }

  private lease(): () => void {
    let done = false;
    const release = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.live -= 1;
      this.pump();
    };
    const timer = setTimeout(release, gate.leaseMs);
    timer.unref?.();
    return release;
  }

  private pump(): void {
    while (this.waiters.length > 0 && this.live < this.limit()) this.waiters.shift()!();
  }
}

const lanes = new Map<string, Lane>();
function laneFor(file: string): Lane {
  let l = lanes.get(file);
  if (!l) {
    l = new Lane(file);
    lanes.set(file, l);
  }
  return l;
}

/** Requests queued (waiting for a slot or a pacer turn) per family, right now. */
const queued = new Map<string, number>();

/** Global FIFO of spawn STARTS. Each turn waits for the previous one to finish. */
let paceChain: Promise<unknown> = Promise.resolve();
let nextStartAt = 0;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

/**
 * Run `start` (one synchronous spawn) on the pacer's next turn. The value is
 * returned boxed: `start` returns execa's ResultPromise, which is a thenable,
 * and returning a thenable from here would make the pacer ADOPT it — hold every
 * later spawn until this child EXITED, serialising the whole server.
 */
function paced<T>(start: () => T): Promise<{ value: T; syncMs: number }> {
  const turn = paceChain.then(async () => {
    const wait = nextStartAt - performance.now();
    if (wait > 0) await sleep(wait);
    const t0 = performance.now();
    try {
      return { value: start(), syncMs: performance.now() - t0 };
    } finally {
      const end = performance.now();
      nextStartAt = end + Math.max(gate.minGapMs, (end - t0) * gate.dutyRatio);
    }
  });
  paceChain = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

/** Override some of the gate's knobs (tests; an operator escape hatch later). */
export function configureSpawnGate(next: Partial<SpawnGateConfig>): void {
  gate = {
    ...gate,
    ...next,
    concurrency: { ...gate.concurrency, ...(next.concurrency ?? {}) },
  };
}

/**
 * Test seam: back to defaults with empty queues. Only safe with nothing in
 * flight — a child still running holds a slot on a lane this forgets.
 */
export function resetSpawnGate(): void {
  gate = DEFAULT_SPAWN_GATE;
  lanes.clear();
  queued.clear();
  pending.clear();
  paceChain = Promise.resolve();
  nextStartAt = 0;
}

/* -------------------------------------------------------------- coalescing */

/** git reads: nothing a second identical run would repeat or do differently. */
const GIT_READS = new Set([
  "status",
  "rev-parse",
  "for-each-ref",
  "log",
  "show",
  "diff",
  "ls-files",
  "ls-tree",
  "merge-base",
  "cat-file",
  "rev-list",
  "show-ref",
  "describe",
  "blame",
  "worktree list",
  "remote get-url",
]);

const GH_READS = new Set([
  "repo view",
  "pr list",
  "pr view",
  "pr checks",
  "pr diff",
  "run list",
  "run view",
  "issue list",
  "issue view",
  "release list",
  "release view",
]);

/**
 * `gh api` flags known to shape only the OUTPUT or transport of a request, with
 * whether each takes the next argument as its value. Anything not listed here
 * makes the call a non-read — see {@link ghApiIsRead}.
 */
const GH_API_READ_FLAGS = new Map<string, boolean>([
  ["--jq", true],
  ["-q", true],
  ["--template", true],
  ["-t", true],
  ["-H", true],
  ["--header", true],
  ["--hostname", true],
  ["--cache", true],
  ["--paginate", false],
  ["--slurp", false],
  ["--silent", false],
  ["--include", false],
  ["-i", false],
  ["--verbose", false],
]);
/** Fields that carry a value: GraphQL variables, or a REST body. */
const GH_API_FIELD_FLAGS = new Set(["-f", "-F", "--field", "--raw-field"]);

/**
 * Is this `gh api` call a read? FAILS CLOSED: a wrong "read" silently drops a
 * write (two identical queued calls become one spawn), while a wrong "write"
 * only costs a spawn. So every flag must be one this function understands —
 * `-XPOST`, `--field=x`, `--input f.json`, or a spelling gh adds next year all
 * land on "not a read" instead of slipping past an exact-match check.
 */
function ghApiIsRead(args: readonly string[], graphql: boolean): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("-")) continue; // `api`, the endpoint, `graphql`
    const eq = a.indexOf("=");
    const name = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    const attached = a.startsWith("--") && eq > 0 ? a.slice(eq + 1) : undefined;
    if (name === "-X" || name === "--method") {
      const method = attached ?? args[++i] ?? "";
      if (method.toUpperCase() !== "GET") return false;
      continue;
    }
    if (a.startsWith("-X")) {
      // Attached short form: `-XGET` / `-XPOST`.
      if (a.slice(2).toUpperCase() !== "GET") return false;
      continue;
    }
    if (GH_API_FIELD_FLAGS.has(name)) {
      // REST with a body is a write by definition. GraphQL is always POSTed
      // with fields; only the operation says whether it writes, and only an
      // INLINE query can be read — `query=@file` could hold anything.
      if (!graphql) return false;
      const field = attached ?? args[++i] ?? "";
      if (field.startsWith("query=")) {
        const query = field.slice("query=".length);
        if (query.startsWith("@") || /^\s*mutation\b/.test(query)) return false;
      }
      continue;
    }
    const takesValue = GH_API_READ_FLAGS.get(name);
    if (takesValue === undefined) return false; // unknown — includes `--input`
    if (takesValue && attached === undefined) i++;
  }
  return true;
}

/** Can two identical requests for this command share one child? */
export function isCoalescibleRead(file: string, args: readonly string[]): boolean {
  const sub = subcommandOf(file, args);
  if (file === "git") return GIT_READS.has(sub);
  if (file === "gh") {
    if (sub === "api graphql" || sub === "api rest") return ghApiIsRead(args, sub === "api graphql");
    return GH_READS.has(sub);
  }
  return false;
}

/**
 * Options that only shape HOW the child runs and what comes back. Anything
 * else (a cancel signal, a stream, a callback) makes two requests differ in
 * ways a key can't see, so its presence turns coalescing off.
 */
const KEYABLE_OPTIONS = new Set([
  "cwd",
  "env",
  "extendEnv",
  "encoding",
  "timeout",
  "reject",
  "stripFinalNewline",
  "windowsHide",
  "maxBuffer",
  "all",
  "input",
]);

function coalesceKey(file: string, args: readonly string[], options: object | undefined): string | null {
  if (!isCoalescibleRead(file, args)) return null;
  const opts = (options ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(opts)) {
    if (!KEYABLE_OPTIONS.has(k)) return null;
    if (k === "input" && typeof v !== "string") return null;
  }
  return JSON.stringify([file, args, opts]);
}

/**
 * Identical read requests that are QUEUED — not yet spawned. Joining one of
 * those is always correct: its child starts after the joiner asked, so it sees
 * repo state at least as fresh as the joiner's own spawn would have. Joining a
 * call ALREADY RUNNING would not be — a `status` launched before the caller's
 * `git add` finished reports the pre-add tree — so an entry leaves this map
 * the moment its child is spawned.
 *
 * It is also exactly where duplicates pile up: on a healthy box nothing queues
 * and nothing coalesces; under load every open tab's 5 s Source Control poll
 * and every worktree-detector tick lands in the queue behind the same slow
 * spawns, and each identical one there is a `CreateProcess` the loop no longer
 * pays for.
 */
const pending = new Map<string, Promise<unknown>>();

/* ------------------------------------------------------------------- spawn */

type SpawnFn = (file: string, args: readonly string[], options?: Options) => PromiseLike<unknown>;
const realSpawn: SpawnFn = (file, args, options) => execa(file, args, options);
let spawnImpl: SpawnFn = realSpawn;

/** Test seam: replace the real `execa` call (null restores it). */
export function setSpawnImplForTest(fn: SpawnFn | null): void {
  spawnImpl = fn ?? realSpawn;
}

/**
 * `execa`, but through the memoised binary and the gate, and counted. Same
 * arguments, same result — every option execa accepts passes straight through
 * — so a seam that read `execa(file, args, opts)` reads
 * `execBinary(file, args, opts)` and nothing downstream changes.
 *
 * Returns a plain Promise of execa's result rather than its ResultPromise: the
 * resolution step is async, so the child does not exist yet when this returns.
 * A caller that needs the child object itself (to stream its output) keeps
 * calling execa directly, with `await resolveBinary(file)` as the command —
 * and is therefore NOT gated.
 *
 * A coalesced caller gets the SAME result object as the request it joined (and
 * the same rejection, if that one fails) — callers only read it.
 */
export function execBinary<O extends Options = {}>(
  file: string,
  args: readonly string[],
  options?: O,
): Promise<Result<O>> {
  const key = coalesceKey(file, args, options);
  if (key) {
    const hit = pending.get(key);
    if (hit) {
      statFor(file).coalesced += 1;
      return hit as Promise<Result<O>>;
    }
  }
  const run = gatedSpawn<O>(file, args, options, key);
  if (key) {
    pending.set(key, run);
    // The spawn removes it, but a failure BEFORE spawning (binary resolution,
    // a pacer rejection) must not leave a dead promise for others to join.
    const clear = (): void => {
      if (pending.get(key) === run) pending.delete(key);
    };
    run.then(clear, clear);
  }
  return run;
}

async function gatedSpawn<O extends Options>(
  file: string,
  args: readonly string[],
  options: O | undefined,
  key: string | null,
): Promise<Result<O>> {
  // A test fake never runs the binary, so it is spared the PATH walk — on a
  // loaded box the first walk takes over a second and the gate tests would be
  // timing the disk instead of the queue.
  const bin = await (spawnImpl === realSpawn ? resolveBinary(file) : file);
  const enqueuedAt = performance.now();
  const depth = (queued.get(file) ?? 0) + 1;
  queued.set(file, depth);
  const before = statFor(file);
  if (depth > before.maxQueue) before.maxQueue = depth;
  let dequeued = false;
  const dequeue = (): void => {
    if (dequeued) return;
    dequeued = true;
    queued.set(file, Math.max(0, (queued.get(file) ?? 1) - 1));
  };
  let release: (() => void) | undefined;
  try {
    release = await laneFor(file).acquire();
    const { value: child, syncMs } = await paced(() => {
      // Spawning now: from here on a newcomer must NOT join this request —
      // see `pending` for why a running call is never shared.
      if (key) pending.delete(key);
      dequeue();
      return spawnImpl(bin, args, options);
    });
    // Looked up AFTER the await, so a window that rolled while this request
    // was queued charges it to the window in which it actually spawned.
    const stat = statFor(file);
    const waited = Math.max(0, performance.now() - enqueuedAt - syncMs);
    stat.count += 1;
    stat.syncMs += syncMs;
    if (syncMs > stat.maxSyncMs) stat.maxSyncMs = syncMs;
    stat.waitMs += waited;
    if (waited > stat.maxWaitMs) stat.maxWaitMs = waited;
    const sub = subcommandOf(file, args);
    stat.subs[sub] = (stat.subs[sub] ?? 0) + 1;
    const t1 = performance.now();
    try {
      // execa's ResultPromise<O> does not narrow to Result<O> under a generic O
      // in TS's eyes, though that is exactly what awaiting it yields.
      return (await child) as unknown as Result<O>;
    } finally {
      statFor(file).wallMs += performance.now() - t1;
    }
  } finally {
    dequeue();
    release?.();
  }
}
