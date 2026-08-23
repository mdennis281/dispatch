import { describe, it, expect, beforeEach } from "vitest";
import type { MetricState } from "@dispatch/shared";
import {
  ActivityTracker,
  MAIN_ACTOR,
  chatStatusForActivity,
  classifyActivity,
  type SpanOpen,
  type SpanSink,
} from "./metrics-activity.js";

/** A span as the fake sink saw it. */
interface Recorded {
  key: string;
  state: MetricState;
  identifier: string;
  runId: string;
  subagent?: string;
  startTs: number;
  endTs?: number;
}

/** Records what the tracker asked for, on a clock the test drives by hand. */
class FakeSink implements SpanSink {
  clock = 0;
  readonly spans: Recorded[] = [];
  private readonly byKey = new Map<string, Recorded>();
  private n = 0;

  now(): number {
    return this.clock;
  }
  open(span: SpanOpen): string {
    const key = `k${++this.n}`;
    const row: Recorded = {
      key,
      state: span.state,
      identifier: span.identifier,
      runId: span.runId,
      subagent: span.subagent,
      startTs: span.startTs,
    };
    this.spans.push(row);
    this.byKey.set(key, row);
    return key;
  }
  close(key: string, at: number): void {
    const row = this.byKey.get(key);
    if (row && row.endTs === undefined) row.endTs = at;
  }

  /** Advance the clock. */
  at(t: number): void {
    this.clock = t;
  }
  /** Closed spans of one actor, in the order they opened. */
  of(runId = MAIN_ACTOR): Recorded[] {
    return this.spans.filter((s) => s.runId === runId);
  }
  /** Total ms per state across every actor. */
  msByState(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of this.spans) {
      if (s.endTs === undefined) continue;
      out[s.state] = (out[s.state] ?? 0) + (s.endTs - s.startTs);
    }
    return out;
  }
  /** Spans the tracker never closed. Named apart from `open()`, the method. */
  get running(): Recorded[] {
    return this.spans.filter((s) => s.endTs === undefined);
  }
}

let sink: FakeSink;
let track: ActivityTracker;

beforeEach(() => {
  sink = new FakeSink();
  track = new ActivityTracker(sink);
});

describe("classifyActivity", () => {
  const cases: [string, Record<string, unknown> | undefined, MetricState][] = [
    ["Bash", undefined, "shell"],
    ["shell_command", undefined, "shell"],
    ["mcp__dispatch-workspace__terminal", undefined, "shell"],
    // Reading scrollback that already exists is not running a command.
    ["mcp__dispatch-workspace__terminal_output", undefined, "tool"],
    ["mcp__dispatch-session__wait", undefined, "sleeping"],
    ["functions.wait", undefined, "sleeping"],
    // Matches both the sleep and the agent spelling; it's a peer, not a nap.
    ["mcp__dispatch-chat__wait_for_chat", undefined, "waiting_agent"],
    ["Task", undefined, "waiting_agent"],
    ["Agent", undefined, "waiting_agent"],
    ["collaboration.wait_agent", undefined, "waiting_agent"],
    ["mcp__dispatch-confirm__ask_user", undefined, "waiting_human"],
    ["AskUserQuestion", undefined, "waiting_human"],
    ["mcp__dispatch-github__watch_pr", undefined, "waiting_remote"],
    ["WebFetch", undefined, "waiting_remote"],
    ["Read", undefined, "tool"],
    ["mcp__playwright__browser_click", undefined, "tool"],
    ["functions.exec", { source: "await tools.mcp__dispatch-workspace__terminal({})" }, "shell"],
  ];
  for (const [name, input, expected] of cases) {
    it(`files ${name} as ${expected}`, () => {
      expect(classifyActivity(name, input)).toBe(expected);
    });
  }

  it("survives an input it cannot serialize", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => classifyActivity("functions.exec", circular)).not.toThrow();
    expect(() => classifyActivity("functions.exec", { value: 1n })).not.toThrow();
  });

  it("guesses `tool` for a name it has never seen", () => {
    // The honest default: an unknown tool is doing local work until something
    // says otherwise. Guessing `blocked` would inflate every new integration.
    expect(classifyActivity("SomeToolShippedNextMonth")).toBe("tool");
  });

  it("reads a state back as the chat dot's status", () => {
    expect(chatStatusForActivity("tool")).toBe("running");
    expect(chatStatusForActivity("generating")).toBe("running");
    expect(chatStatusForActivity("shell")).toBe("waiting");
    expect(chatStatusForActivity("waiting_remote")).toBe("waiting");
  });
});

describe("ActivityTracker — one actor's timeline", () => {
  it("tiles the turn with no gaps and no overlaps", () => {
    // THE invariant: at every instant the main loop is in exactly one state, so
    // the spans sum to the elapsed time of the turn. A gap means unaccounted
    // work; an overlap means double-counted work.
    sink.at(0);
    track.turnStart();
    sink.at(100);
    track.toolStart(MAIN_ACTOR, "t1", "Bash");
    sink.at(400);
    track.toolEnd("t1");
    sink.at(500);
    track.turnEnd();

    expect(sink.of()).toMatchObject([
      { state: "generating", startTs: 0, endTs: 100 },
      { state: "shell", identifier: "Bash", startTs: 100, endTs: 400 },
      { state: "generating", startTs: 400, endTs: 500 },
    ]);
    expect(sink.msByState()).toEqual({ generating: 200, shell: 300 });
    expect(sink.running).toEqual([]);
  });

  it("stays out of `generating` until the LAST parallel tool comes back", () => {
    sink.at(0);
    track.turnStart();
    sink.at(10);
    track.toolStart(MAIN_ACTOR, "a", "Bash");
    sink.at(20);
    track.toolStart(MAIN_ACTOR, "b", "Bash");
    sink.at(50);
    track.toolEnd("a");
    // One tool back, one still running — the model is not generating yet.
    expect(sink.running.map((s) => s.state)).toEqual(["shell"]);
    sink.at(80);
    track.toolEnd("b");
    expect(sink.running.map((s) => s.state)).toEqual(["generating"]);

    sink.at(100);
    track.turnEnd();
    // 40 + 60 attributed against 70 of wall clock: the overlap is real and is
    // exactly what the union measure exists to reconcile.
    expect(sink.msByState()).toEqual({ generating: 30, shell: 100 });
  });

  it("puts a permission prompt between the model and the tool", () => {
    sink.at(0);
    track.turnStart();
    sink.at(10);
    track.blocked(MAIN_ACTOR, "perm-1", "waiting_human", "Bash");
    sink.at(1000);
    track.unblocked("perm-1");
    sink.at(1001);
    track.toolStart(MAIN_ACTOR, "t1", "Bash");
    sink.at(1500);
    track.toolEnd("t1");
    sink.at(1500);
    track.turnEnd();
    expect(sink.msByState()).toEqual({ generating: 11, waiting_human: 990, shell: 499 });
  });

  it("counts the queue wait, and ends it when the turn starts", () => {
    sink.at(0);
    track.queued();
    sink.at(0);
    track.queued(); // a re-publish of the same queued status is not a second wait
    sink.at(300);
    track.turnStart();
    sink.at(400);
    track.turnEnd();
    expect(sink.msByState()).toEqual({ queued: 300, generating: 100 });
  });

  it("keeps a usage-limit pause running ACROSS the turn that caused it", () => {
    // The pause is what happens because the turn ended, so `turnEnd` must not
    // close it — it closes when the next turn actually starts.
    sink.at(0);
    track.turnStart();
    sink.at(100);
    track.turnEnd({ limit: true });
    expect(sink.running.map((s) => s.state)).toEqual(["paused_limit"]);
    sink.at(5_000);
    track.turnStart();
    expect(sink.msByState()).toMatchObject({ paused_limit: 4_900 });
  });

  it("closes everything on dispose", () => {
    sink.at(0);
    track.turnStart();
    track.toolStart(MAIN_ACTOR, "t1", "Bash");
    sink.at(90);
    track.dispose();
    expect(sink.running).toEqual([]);
    expect(track.openCount).toBe(0);
  });
});

describe("ActivityTracker — subagents are their own actors", () => {
  it("runs a child's timeline beside the parent's wait", () => {
    sink.at(0);
    track.turnStart();
    sink.at(10);
    track.toolStart(MAIN_ACTOR, "task-1", "Task", { subagent_type: "Explore" });
    // The child is thinking from here, not from its first tool call.
    sink.at(20);
    track.toolStart("task-1", "c1", "Read", undefined, "Explore");
    sink.at(60);
    track.toolEnd("c1");
    sink.at(100);
    track.toolEnd("task-1");
    sink.at(100);
    track.turnEnd();

    const parent = sink.of(MAIN_ACTOR);
    expect(parent).toMatchObject([
      { state: "generating", startTs: 0, endTs: 10 },
      { state: "waiting_agent", identifier: "Task", startTs: 10, endTs: 100 },
      // The spawner came back and the turn ended in the same instant, so the
      // model's next stretch is zero long. Recorded rather than suppressed: it
      // is a real transition, it contributes nothing to any total, and a rule
      // that dropped it would have to guess which zero-length spans are real
      // (Codex emits genuine ones for same-tick tool calls).
      { state: "generating", startTs: 100, endTs: 100 },
    ]);
    const child = sink.of("task-1");
    expect(child).toMatchObject([
      // The lead-in: the child's reasoning before it reached for anything,
      // opening at 10 with the parent's wait rather than at 20. In production
      // this stretch was 3.3s of a 336.7s run and belonged to no actor at all.
      { state: "generating", subagent: "Explore", startTs: 10, endTs: 20 },
      { state: "tool", identifier: "Read", startTs: 20, endTs: 60 },
      { state: "generating", startTs: 60, endTs: 100 },
    ]);
    // 90 of parent wait CONCURRENT with 90 of child work. Both are real; the
    // parent's 90 is not the child's time and must not be netted against it.
    expect(sink.msByState()).toEqual({ generating: 60, waiting_agent: 90, tool: 40 });
  });

  it("starts the child's timeline in the same instant as the parent's wait", () => {
    // The tail was already exact — the child's last span ended where the
    // parent's wait ended. This is the other end of the same seam: a gap here
    // is a systematic under-count of subagent THINKING specifically.
    sink.at(0);
    track.turnStart();
    sink.at(1_000);
    track.toolStart(MAIN_ACTOR, "task-1", "Agent", { subagent_type: "Explore" });

    const wait = sink.of(MAIN_ACTOR).find((s) => s.state === "waiting_agent");
    const lead = sink.of("task-1")[0];
    expect(lead).toMatchObject({ state: "generating", subagent: "Explore" });
    expect(lead?.startTs).toBe(wait?.startTs);
  });

  it("invents no child for a wait that isn't a spawn", () => {
    // `wait_for_chat` classifies as `waiting_agent` too, but it blocks on a
    // PEER chat — its tool_use id is nobody's run id. A child pre-opened here
    // would be an actor that never ran, showing up in every chart grouped by
    // run and in the actor count on every summary.
    sink.at(0);
    track.turnStart();
    sink.at(10);
    track.toolStart(MAIN_ACTOR, "peer-1", "mcp__dispatch-chat__wait_for_chat", { chatId: "c9" });
    sink.at(40);
    track.toolEnd("peer-1");
    sink.at(40);
    track.turnEnd();

    expect(sink.of("peer-1")).toEqual([]);
    expect(sink.spans.every((s) => s.runId === MAIN_ACTOR)).toBe(true);
    expect(sink.msByState()).toEqual({ generating: 10, waiting_agent: 30 });
  });

  it("closes a spawn that produced nothing at all", () => {
    // A child that returns without reaching for anything now has a timeline
    // where it used to have none — so it needs an end as well as a start, or
    // pre-opening trades an under-count for a span left running forever.
    sink.at(0);
    track.turnStart();
    sink.at(10);
    track.toolStart(MAIN_ACTOR, "task-1", "Task");
    sink.at(70);
    track.toolEnd("task-1");

    // The spawner's result IS when a synchronous child finished, so its
    // lead-in ends there rather than being left open for the turn to sweep.
    expect(sink.of("task-1")).toMatchObject([
      { state: "generating", subagent: "general-purpose", startTs: 10, endTs: 70 },
    ]);
    sink.at(70);
    track.turnEnd();
    expect(sink.running).toEqual([]);
  });

  it("lets an async child revive after its spawner has already answered", () => {
    // A backgrounded Agent answers in milliseconds with a launch ack and keeps
    // working. Closing the child at the spawner's result would lose all of it.
    sink.at(0);
    track.turnStart();
    sink.at(10);
    track.toolStart(MAIN_ACTOR, "task-1", "Agent");
    sink.at(12);
    track.toolEnd("task-1"); // the launch ack
    sink.at(50);
    track.toolStart("task-1", "c1", "Read", undefined, "worker");
    sink.at(90);
    track.toolEnd("c1");
    sink.at(200);
    track.runEnd("task-1");
    sink.at(200);
    track.turnEnd();

    expect(sink.of("task-1")).toMatchObject([
      // The lead-in opens at the spawn like any other child's, but the ack is
      // indistinguishable from a finished run here, so quiescing truncates it
      // at 12. Two ms of real thinking, and the 12→50 hole is the same one an
      // async child has always had between its quiesce and its revival.
      { state: "generating", startTs: 10, endTs: 12 },
      { state: "tool", startTs: 50, endTs: 90 },
      { state: "generating", startTs: 90, endTs: 200 },
    ]);
    // The parent only waited for the ack; it wasn't blocked for the run.
    expect(sink.msByState().waiting_agent).toBe(2);
  });

  it("closes a child left running when the turn ends", () => {
    sink.at(0);
    track.turnStart();
    track.toolStart(MAIN_ACTOR, "task-1", "Task");
    sink.at(10);
    track.toolStart("task-1", "c1", "Bash");
    sink.at(999);
    track.turnEnd();
    expect(sink.running).toEqual([]);
    expect(sink.of("task-1")).toMatchObject([
      { state: "generating", startTs: 0, endTs: 10 },
      { state: "shell", startTs: 10, endTs: 999 },
    ]);
  });
});

describe("ActivityTracker — one human wait per actor", () => {
  it("counts a self-gated tool's wait once, under the tool's own name", () => {
    // `spawn_chat` is itself classified waiting_human AND raises the consent
    // card it is waiting for, so the card's permission wait opened nested
    // inside the tool call: production billed one human wait twice. The tool
    // span is the one that survives — it carries the fuller identifier.
    sink.at(0);
    track.turnStart();
    sink.at(10);
    track.toolStart(MAIN_ACTOR, "tu-1", "mcp__dispatch-chat__spawn_chat");
    sink.at(20);
    track.blocked(MAIN_ACTOR, "perm-1", "waiting_human", "spawn_chat");
    sink.at(900);
    track.unblocked("perm-1");
    sink.at(1000);
    track.toolEnd("tu-1");
    sink.at(1000);
    track.turnEnd();

    expect(sink.of()).toMatchObject([
      { state: "generating", startTs: 0, endTs: 10 },
      { state: "waiting_human", identifier: "mcp__dispatch-chat__spawn_chat", startTs: 10, endTs: 1000 },
      { state: "generating", startTs: 1000, endTs: 1000 },
    ]);
    expect(sink.msByState()).toEqual({ generating: 10, waiting_human: 990 });
    expect(sink.running).toEqual([]);
  });

  it("counts it once in the legacy order too, where the prompt lands first", () => {
    // The `canUseTool` gate registers the permission before the tool_use block
    // arrives, so the same pair nests the other way round. The wait the human
    // actually served is one wait either way, and the answer ends it.
    sink.at(0);
    track.turnStart();
    sink.at(10);
    track.blocked(MAIN_ACTOR, "perm-1", "waiting_human", "spawn_chat");
    sink.at(20);
    track.toolStart(MAIN_ACTOR, "tu-1", "mcp__dispatch-chat__spawn_chat");
    sink.at(900);
    track.unblocked("perm-1");
    sink.at(1000);
    track.toolEnd("tu-1"); // the suppressed span registered no id: a no-op
    sink.at(1000);
    track.turnEnd();

    expect(sink.of()).toMatchObject([
      { state: "generating", startTs: 0, endTs: 10 },
      { state: "waiting_human", identifier: "spawn_chat", startTs: 10, endTs: 900 },
      { state: "generating", startTs: 900, endTs: 1000 },
    ]);
    expect(sink.msByState()).toEqual({ generating: 110, waiting_human: 890 });
    expect(sink.running).toEqual([]);
  });

  it("leaves an ordinary prompt-then-tool sequence alone", () => {
    // What is suppressed is an OVERLAP, not the pairing: Bash's permission is
    // answered before Bash starts, so both spans are real and both stay.
    sink.at(0);
    track.turnStart();
    sink.at(10);
    track.blocked(MAIN_ACTOR, "perm-1", "waiting_human", "Bash");
    sink.at(100);
    track.unblocked("perm-1");
    sink.at(100);
    track.toolStart(MAIN_ACTOR, "tu-1", "Bash");
    sink.at(300);
    track.toolEnd("tu-1");
    sink.at(300);
    track.turnEnd();

    expect(sink.of().map((s) => [s.state, s.identifier])).toEqual([
      ["generating", "turn"],
      ["waiting_human", "Bash"],
      ["generating", "turn"],
      ["shell", "Bash"],
      ["generating", "turn"],
    ]);
    expect(sink.msByState()).toEqual({ generating: 10, waiting_human: 90, shell: 200 });
  });

  it("lets two actors wait on their own human at once", () => {
    // Suppression is per actor. A subagent's question and the main loop's are
    // two people being waited on, not one wait seen twice, and folding them
    // together would lose whichever arrived second entirely.
    sink.at(0);
    track.turnStart();
    sink.at(10);
    track.toolStart("task-1", "c1", "mcp__dispatch-confirm__ask_user", undefined, "worker");
    sink.at(20);
    track.blocked(MAIN_ACTOR, "perm-1", "waiting_human", "AskUserQuestion");
    expect(sink.running.map((s) => [s.runId, s.state])).toEqual([
      ["task-1", "waiting_human"],
      [MAIN_ACTOR, "waiting_human"],
    ]);

    sink.at(120);
    track.unblocked("perm-1");
    sink.at(200);
    track.toolEnd("c1");
    sink.at(250);
    track.turnEnd();

    expect(sink.of("task-1")).toMatchObject([
      { state: "waiting_human", identifier: "mcp__dispatch-confirm__ask_user", startTs: 10, endTs: 200 },
      { state: "generating", startTs: 200, endTs: 250 },
    ]);
    expect(sink.of(MAIN_ACTOR)).toMatchObject([
      { state: "generating", startTs: 0, endTs: 20 },
      { state: "waiting_human", identifier: "AskUserQuestion", startTs: 20, endTs: 120 },
      { state: "generating", startTs: 120, endTs: 250 },
    ]);
    expect(sink.msByState().waiting_human).toBe(290);
  });
});
