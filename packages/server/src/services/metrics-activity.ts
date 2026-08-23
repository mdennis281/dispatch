/**
 * WHAT AN AGENT IS DOING RIGHT NOW, and for how long — the state machine behind
 * the runtime span ledger (`metric_span`, see metrics.ts).
 *
 * Two pieces, deliberately together:
 *
 *   classifyActivity  one tool call → the ONE state it puts its caller in
 *   ActivityTracker   the per-actor timeline that opens and closes spans
 *
 * WHY IT ISN'T IN THE BROKER. The broker sees the events; the arithmetic of
 * "which actor was in which state when" is a small machine with a handful of
 * invariants — an actor is generating exactly when its turn is live and nothing
 * is blocking it; a span is opened once and closed once — and those are worth
 * testing without standing up a session, a database and a fake SDK.
 *
 * WHY IT'S DRIVEN BY NEUTRAL EVENTS. Everything here is fed from `HarnessEvent`
 * (tool-use, tool-result, permission-request, turn-end), which is the vocabulary
 * every runtime already speaks. A third adapter gets runtime accounting for free
 * the day it emits those five events — nothing below the harness seam knows this
 * file exists. See harness/types.ts.
 *
 * THE ACTOR. `(chatId, runId)` where `runId` is the spawning Task's tool_use id,
 * or "" for the chat's own main loop. One tracker serves one chat, so it keys on
 * `runId` alone.
 */
import {
  LEGACY_MANAGER_TOOL_PREFIX,
  isManagerServerOrLegacy,
  managerToolQualifiedName,
  parseMcpToolName,
  type ChatStatus,
  type MetricState,
} from "@dispatch/shared";
import { spawnedSubagent } from "./metrics-classify.js";

/** The main loop's run id. Empty string, matching the NULL-is-"" convention. */
export const MAIN_ACTOR = "";

/**
 * Ids for the two spans that belong to a chat rather than to a tool call.
 *
 * NUL-prefixed so they cannot collide with a runtime's tool_use id or request
 * id, and written as an ESCAPE rather than as the literal control character:
 * with that byte in the source, git classifies this whole file as binary, and
 * all 435 lines of it rendered as an opaque blob on the PR that introduced it
 * — which is why none of it was reviewed.
 */
const QUEUED_ID = "\u0000queued";
const LIMIT_ID = "\u0000limit";

/* ------------------------------------------------------------- classifying */

/**
 * The BARE Dispatch tool a name refers to, or undefined when it isn't one.
 *
 * Legacy-tolerant, like the transcript renderer: this classifies a name that may
 * have been RECORDED before the split, so answering `tool` for a pre-split
 * `terminal` call would quietly reclassify historical shell time.
 *
 * These predicates used to match the substring for the old server plus a tool
 * name, which was wrong in two directions and only ever half-noticed: `terminal_output` had to be
 * excluded by hand because it contains `terminal`, and any third-party server
 * whose name ended in `manager` matched too. Parsing the name instead means the
 * split onto `dispatch-*` servers moved these for free — and it is why a
 * substring sweep did NOT have to find this file's strings correctly.
 */
function dispatchTool(name: string): string | undefined {
  const parsed = parseMcpToolName(name);
  return parsed && isManagerServerOrLegacy(parsed.server) ? parsed.tool : undefined;
}

/**
 * Tools whose name means "a shell command is running".
 *
 * `terminal` is here and `terminal_output` is not: the first runs a command, the
 * second reads scrollback that already exists.
 */
function isShell(n: string, tool: string | undefined): boolean {
  return (
    n === "bash" ||
    n === "powershell" ||
    n === "shell_command" ||
    n.endsWith("_shell_command") ||
    tool === "terminal" ||
    tool === "run_subapp"
  );
}

/** Tools that block on another agent — a spawned subagent or a peer chat. */
function isAgentWait(n: string, tool: string | undefined): boolean {
  return (
    n === "task" ||
    n === "agent" ||
    n.endsWith("_wait_agent") ||
    n.includes("collaboration_wait_agent") ||
    tool === "wait_for_chat"
  );
}

/**
 * Tools that block on a human answering.
 *
 * A permission prompt is NOT here — that arrives as its own harness event
 * (`permission-request`) and is opened by {@link ActivityTracker.blocked}, since
 * it can gate a tool whose own state is something else entirely.
 */
function isHumanWait(n: string, tool: string | undefined): boolean {
  return (
    n === "askuserquestion" ||
    n === "exitplanmode" ||
    tool === "ask_user" ||
    tool === "request_exemption" ||
    tool === "spawn_chat"
  );
}

/**
 * Tools that block on something across the network.
 *
 * An explicit LIST, not "everything that isn't built in". A third-party MCP
 * server is usually a local stdio subprocess — Playwright driving a browser on
 * this machine is not the network — so calling every `mcp__` tool remote would
 * file most of the working time under blocked.
 */
function isRemoteWait(n: string, tool: string | undefined): boolean {
  return (
    n === "webfetch" ||
    n === "websearch" ||
    // Everything on the GitHub category server blocks on github.com. Named
    // individually rather than by category so adding a LOCAL tool there later
    // doesn't silently start counting as network time.
    tool === "watch_pr" ||
    tool === "create_pr" ||
    tool === "approve_pr" ||
    tool === "request_review" ||
    tool === "post_review" ||
    tool === "resolve_thread"
  );
}

/** JSON that can't throw on a cycle or a bigint — inputs come from a runtime. */
function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 4_000 ? `${text.slice(0, 4_000)}…` : text;
  } catch {
    return String(value);
  }
}

/**
 * The ONE state a tool call puts its caller in.
 *
 * Exactly one, most specific first, the same discipline `classifyTool` uses for
 * the event ledger — so summing an actor's states gives its time rather than
 * double-counting the interesting stretches.
 *
 * Name matching is a FALLBACK, and an unhappy one: it has to guess at tools this
 * build has never seen, and it guesses `tool`. The manager's own tools are the
 * ones whose blocking semantics are known for certain (`wait` sleeps, `watch_pr`
 * waits on GitHub), and a later pass should have them declare it rather than be
 * recognised by name here.
 */
export function classifyActivity(name: string, input?: Record<string, unknown>): MetricState {
  const n = name.toLowerCase().replace(/[.:/]/g, "_");
  const tool = dispatchTool(name);
  // Codex routes some calls through a generic `functions.exec` carrier, so the
  // real tool is in the payload rather than the name.
  const payload = input ? safeJson(input).toLowerCase() : "";
  // Both spellings: a payload recorded before the split names the retired
  // server, and Codex transcripts are re-read for as long as the chat exists.
  // Fixing `dispatchTool` above and not this line left exactly half the bug.
  const carried =
    n === "functions_exec" &&
    (payload.includes(managerToolQualifiedName("terminal").toLowerCase()) ||
      payload.includes(`${LEGACY_MANAGER_TOOL_PREFIX}terminal`) ||
      payload.includes("shell_command"));
  // Agent waits are tested BEFORE sleeps, because `wait_for_chat` is a peer it's
  // blocked on, not a nap.
  if (isAgentWait(n, tool)) return "waiting_agent";
  if (n === "functions_wait" || tool === "wait") return "sleeping";
  if (isHumanWait(n, tool)) return "waiting_human";
  if (isRemoteWait(n, tool)) return "waiting_remote";
  if (isShell(n, tool) || carried) return "shell";
  return "tool";
}

/**
 * The chat dot's status for a tool call, expressed over the same classification.
 *
 * One map, so the dot and the chart can't disagree about what "waiting" means —
 * which they did while this was a separate list of tool names: `watch_pr` could
 * block for ten minutes under a "running" dot.
 */
export function chatStatusForActivity(state: MetricState): ChatStatus {
  return state === "tool" || state === "generating" ? "running" : "waiting";
}

/* ---------------------------------------------------------------- tracking */

/** A span the tracker wants written. The sink stamps the rest of the columns. */
export interface SpanOpen {
  state: MetricState;
  identifier: string;
  /** The subagent run, or "" for the main loop. */
  runId: string;
  subagent?: string;
  detail?: string;
  /** The runtime's tool_use id, when this span is one tool call. */
  toolUseId?: string;
  /**
   * When the span opened. Always supplied, and always the SAME instant as the
   * close that preceded it — a transition is one moment, and letting the sink
   * default to its own `now()` would leave a sliver of unaccounted time between
   * every pair of adjacent spans.
   */
  startTs: number;
}

/** Where the tracker's spans go. Implemented by the broker over MetricsService. */
export interface SpanSink {
  now(): number;
  /** Open a span; returns the key it can be closed by. */
  open(span: SpanOpen): string;
  close(key: string, at: number, extra?: { ok?: boolean; reportedMs?: number }): void;
}

/** One actor's live state. */
interface Actor {
  /** True while this actor's turn/run is in flight. */
  live: boolean;
  /** The open `generating` span, when nothing is blocking. */
  generating?: string;
  /** Ids currently occupying this actor (tool calls, permission waits). */
  open: Set<string>;
  subagent?: string;
}

/**
 * One chat's runtime timeline.
 *
 * THE INVARIANT: an actor is `generating` exactly when its turn is live and
 * nothing else is occupying it. Everything below is that one rule plus the
 * bookkeeping to notice when it changes — which is why the tool spans and the
 * permission waits share a single `open` set rather than being tracked apart.
 * The alternative, deriving "generating" at query time from the gaps between
 * other spans, needs the whole timeline in memory to answer anything.
 */
export class ActivityTracker {
  private readonly actors = new Map<string, Actor>();
  /** Occupying id → the actor holding it and the span it opened. */
  private readonly byId = new Map<string, { runId: string; key: string; state: MetricState }>();

  constructor(private readonly sink: SpanSink) {}

  /** Spans currently open. For tests and for the session view. */
  get openCount(): number {
    let n = 0;
    for (const actor of this.actors.values()) if (actor.generating !== undefined) n++;
    return n + this.byId.size;
  }

  /* -------------------------------------------------------- turn lifecycle */

  /** The chat is behind the concurrency cap with a message it can't start yet. */
  queued(at = this.sink.now()): void {
    if (this.byId.has(QUEUED_ID)) return;
    this.occupy(MAIN_ACTOR, QUEUED_ID, "queued", "queued", at);
  }

  /** A turn begins: the queue wait (and any usage-limit pause) ends here. */
  turnStart(at = this.sink.now()): void {
    this.release(QUEUED_ID, at);
    this.release(LIMIT_ID, at);
    const actor = this.ensure(MAIN_ACTOR);
    actor.live = true;
    this.settle(MAIN_ACTOR, actor, at);
  }

  /**
   * A turn ended. Closes EVERY actor, not just the main loop.
   *
   * A background subagent can in principle outlive its turn, and closing it here
   * measures it only up to the moment the stream stopped. That is the last
   * instant we can honestly claim to have observed it — the alternative is a
   * span left open until crash recovery truncates it days later, which is worse
   * in both directions.
   */
  turnEnd(opts: { limit?: boolean } = {}, at = this.sink.now()): void {
    this.closeAll(at);
    if (opts.limit) this.occupy(MAIN_ACTOR, LIMIT_ID, "paused_limit", "usage limit", at);
  }

  /** The session is going away. Closes everything, including a limit pause. */
  dispose(at = this.sink.now()): void {
    this.closeAll(at);
    this.release(LIMIT_ID, at);
    this.release(QUEUED_ID, at);
    this.actors.clear();
  }

  /* ---------------------------------------------------------- tool spans */

  /** A tool call started. `runId` is "" for the main loop. */
  toolStart(
    runId: string,
    toolUseId: string,
    name: string,
    input?: Record<string, unknown>,
    subagent?: string,
    at = this.sink.now(),
  ): void {
    const actor = this.ensure(runId);
    // A subagent has no turn-start event of its own; its first tool call IS the
    // evidence that it is running — unless its spawn was seen, in which case
    // {@link spawnChild} has already started it at the earlier, truer instant.
    if (runId !== MAIN_ACTOR) {
      actor.live = true;
      actor.subagent = subagent ?? actor.subagent;
    }
    this.occupy(runId, toolUseId, classifyActivity(name, input), name, at, toolUseId);
    // The child's run id IS this call's tool_use id, so a spawn is the one
    // moment we can start the child's timeline where it really starts.
    const spawned = spawnedSubagent(name, input);
    if (spawned !== undefined) this.spawnChild(toolUseId, spawned, at);
  }

  /** A tool call finished. */
  toolEnd(
    toolUseId: string,
    at = this.sink.now(),
    extra?: { ok?: boolean; reportedMs?: number },
  ): void {
    const held = this.byId.get(toolUseId);
    this.release(toolUseId, at, extra);
    // The spawner's result is when a SYNCHRONOUS subagent finished. Quiesce the
    // run rather than closing it: an async spawn answers in milliseconds and its
    // child keeps working, and that child's next tool call revives it.
    if (held?.state === "waiting_agent") this.quiesce(toolUseId, at);
  }

  /** A background task reported its own verdict — that run is done. */
  runEnd(runId: string, at = this.sink.now(), reportedMs?: number): void {
    const actor = this.actors.get(runId);
    if (!actor) return;
    for (const id of [...this.byId].filter(([, v]) => v.runId === runId).map(([id]) => id)) {
      this.release(id, at, { reportedMs });
    }
    this.closeGenerating(actor, at);
    actor.live = false;
    this.actors.delete(runId);
  }

  /* ------------------------------------------------------- blocking waits */

  /** The actor is blocked on something that isn't a tool call of its own. */
  blocked(
    runId: string,
    id: string,
    state: MetricState,
    identifier: string,
    at = this.sink.now(),
  ): void {
    this.occupy(runId, id, state, identifier, at);
  }

  /** That block was answered. */
  unblocked(id: string, at = this.sink.now()): void {
    this.release(id, at);
  }

  /* ------------------------------------------------------------ internals */

  private ensure(runId: string): Actor {
    let actor = this.actors.get(runId);
    if (!actor) this.actors.set(runId, (actor = { live: runId === MAIN_ACTOR, open: new Set() }));
    return actor;
  }

  /** Take a slot on an actor, opening the span for it. */
  private occupy(
    runId: string,
    id: string,
    state: MetricState,
    identifier: string,
    at: number,
    toolUseId?: string,
  ): void {
    if (this.byId.has(id)) return; // a duplicate start is the same occupation
    const actor = this.ensure(runId);
    if (state === "waiting_human" && this.holdsHumanWait(actor)) return;
    this.closeGenerating(actor, at);
    const key = this.sink.open({
      state,
      identifier,
      runId,
      subagent: actor.subagent,
      toolUseId,
      startTs: at,
    });
    actor.open.add(id);
    this.byId.set(id, { runId, key, state });
  }

  /**
   * Is this actor already waiting on a human?
   *
   * The tools that block on a human RAISE the very card they are waiting for,
   * and that card registers a permission wait of its own — so one wait arrived
   * twice and production spans showed the pair nested, `spawn_chat` inside
   * `spawn_chat`, doubling the `waiting_human` total. Whichever
   * sighting lands first owns the wait; the second is the same wait again.
   *
   * Per ACTOR, and a scan of a set that holds one or two ids: the main loop and
   * a subagent run can each be waiting on their own human, and neither of those
   * is a duplicate of the other.
   */
  private holdsHumanWait(actor: Actor): boolean {
    for (const id of actor.open) if (this.byId.get(id)?.state === "waiting_human") return true;
    return false;
  }

  /** Give a slot back, closing its span and resuming generation if it was last. */
  private release(
    id: string,
    at: number,
    extra?: { ok?: boolean; reportedMs?: number },
  ): void {
    const held = this.byId.get(id);
    if (!held) return;
    this.byId.delete(id);
    this.sink.close(held.key, at, extra);
    const actor = this.actors.get(held.runId);
    if (!actor) return;
    actor.open.delete(id);
    this.settle(held.runId, actor, at);
  }

  /** Open `generating` if the invariant now says it should be. */
  private settle(runId: string, actor: Actor, at: number): void {
    if (!actor.live || actor.open.size > 0 || actor.generating !== undefined) return;
    actor.generating = this.sink.open({
      state: "generating",
      identifier: "turn",
      runId,
      subagent: actor.subagent,
      startTs: at,
    });
  }

  private closeGenerating(actor: Actor, at: number): void {
    // `!== undefined`, not truthiness: a sink with nowhere to write hands back
    // an empty key, and treating that as "no span open" would leave the machine
    // convinced it was never generating.
    if (actor.generating === undefined) return;
    this.sink.close(actor.generating, at);
    actor.generating = undefined;
  }

  /**
   * A spawn opened the parent's wait — start the child at that same instant.
   *
   * Waiting for the child's first tool call loses its OPENING REASONING, which
   * is the one state this ledger exists to isolate. Measured on a production
   * run: the parent was blocked on an `Agent` for 336.7s, the child's timeline
   * began 3.3s later, and those 3.3s belonged to no actor at all — the tail was
   * exact, so the whole error is at the start. On a subagent that thinks for
   * twenty seconds and then makes two quick calls, that is most of the run.
   *
   * Same `at` as the parent's `waiting_agent` span, so the two timelines start
   * together rather than a millisecond apart.
   *
   * Only for a REAL spawn — see {@link spawnedSubagent}. Several other tools
   * classify as `waiting_agent` while blocking on a peer chat, and pre-opening
   * for one of those would invent an actor that never existed — a phantom
   * timeline in every chart grouped by run, and an extra body in the `actors`
   * count on every summary.
   */
  private spawnChild(runId: string, subagent: string, at: number): void {
    const actor = this.ensure(runId);
    actor.live = true;
    actor.subagent = subagent;
    // `settle` is what keeps this from double-opening: if the child somehow
    // already has a span (a re-delivered spawn event), it does nothing.
    this.settle(runId, actor, at);
  }

  /** A run stopped producing, but may yet revive (the async-spawn case). */
  private quiesce(runId: string, at: number): void {
    const actor = this.actors.get(runId);
    if (!actor) return;
    this.closeGenerating(actor, at);
    actor.live = false;
  }

  private closeAll(at: number): void {
    for (const [id, held] of [...this.byId]) {
      // The usage-limit pause is not activity that a turn ending should end —
      // it is what happens BECAUSE the turn ended.
      if (id === LIMIT_ID) continue;
      this.byId.delete(id);
      this.sink.close(held.key, at);
      this.actors.get(held.runId)?.open.delete(id);
    }
    for (const [runId, actor] of this.actors) {
      this.closeGenerating(actor, at);
      actor.live = false;
      if (runId !== MAIN_ACTOR) this.actors.delete(runId);
    }
  }
}
