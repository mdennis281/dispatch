/**
 * The ranking rules behind the Resources table.
 *
 * Worth a test rather than a glance because the page's ONE job is answering
 * "which chat is hurting me", and it shipped getting that wrong: it always
 * sorted by memory, so a chat pinning ten cores sat wherever its memory
 * happened to put it — second row, by coincidence — and the only ordering cue
 * on the page pointed away from the answer. These are the rules that fix it,
 * and a rule expressed as a sort comparator inside a component can only be
 * checked by rendering it.
 */
import { describe, expect, it } from "vitest";
import type { ChatResources } from "@dispatch/shared";
import { nextAutoSort, sortChats } from "./ResourceMetrics.js";

function chat(id: string, over: Partial<ChatResources> = {}): ChatResources {
  const zero = { procs: 0, rssBytes: 0, cpuPct: null };
  return {
    chatId: id,
    procs: 1,
    rssBytes: 0,
    cpuPct: null,
    session: { ...zero },
    shells: { ...zero },
    hottest: null,
    ...over,
  };
}

describe("nextAutoSort", () => {
  it("ranks by memory when nothing is running hot", () => {
    expect(nextAutoSort("mem", [chat("a", { cpuPct: 20 }), chat("b", { cpuPct: 5 })])).toBe("mem");
  });

  it("switches to CPU once a chat passes a full core", () => {
    // The screenshot that prompted this: one chat at 1040% (10.4 cores) while
    // the machine read 100%, ranked second because its memory was ordinary.
    expect(nextAutoSort("mem", [chat("a", { rssBytes: 9e9 }), chat("b", { cpuPct: 1040 })])).toBe(
      "cpu",
    );
  });

  it("does not switch on a machine that is merely busy overall", () => {
    // Nine chats at a third of a core each is a memory story, not a "one row
    // is the answer" story — the automatic switch is for a single culprit.
    const many = Array.from({ length: 9 }, (_, i) => chat(`c${i}`, { cpuPct: 33 }));
    expect(nextAutoSort("mem", many)).toBe("mem");
  });

  it("HOLDS on CPU through the gap between the two thresholds", () => {
    // The flap this exists to stop, caught live: a chat sitting right on one
    // core had the choice recomputed every 5 s poll, so the table re-sorted
    // itself between memory and CPU on alternate refreshes.
    expect(nextAutoSort("cpu", [chat("a", { cpuPct: 99 })])).toBe("cpu");
    expect(nextAutoSort("cpu", [chat("a", { cpuPct: 60 })])).toBe("cpu");
  });

  it("returns to memory only once things are properly quiet", () => {
    expect(nextAutoSort("cpu", [chat("a", { cpuPct: 49 })])).toBe("mem");
  });

  it("never overrides a procs choice, which can only come from a click", () => {
    expect(nextAutoSort("procs", [chat("a", { cpuPct: 5 })])).toBe("procs");
  });

  it("treats an unmeasured chat as cold rather than crashing", () => {
    expect(nextAutoSort("mem", [chat("a"), chat("b")])).toBe("mem");
  });

  it("is stable on an empty table", () => {
    expect(nextAutoSort("mem", [])).toBe("mem");
    expect(nextAutoSort("cpu", [])).toBe("mem");
  });
});

describe("sortChats", () => {
  const rows = [
    chat("a", { rssBytes: 100, cpuPct: 900, procs: 2 }),
    chat("b", { rssBytes: 900, cpuPct: 10, procs: 1 }),
    chat("c", { rssBytes: 500, cpuPct: null, procs: 9 }),
  ];

  it("ranks by each column, biggest first", () => {
    expect(sortChats(rows, "mem").map((c) => c.chatId)).toEqual(["b", "c", "a"]);
    expect(sortChats(rows, "cpu").map((c) => c.chatId)).toEqual(["a", "b", "c"]);
    expect(sortChats(rows, "procs").map((c) => c.chatId)).toEqual(["c", "a", "b"]);
  });

  it("sorts an unmeasured CPU below a measured zero", () => {
    // `null` is "we don't know", and parking it under a chat we KNOW is idle
    // is the honest order — it must not outrank a real reading.
    const order = sortChats([chat("known", { cpuPct: 0 }), chat("unknown")], "cpu");
    expect(order.map((c) => c.chatId)).toEqual(["known", "unknown"]);
  });

  it("breaks ties stably so the table doesn't shuffle between polls", () => {
    // Re-sorted every 5 s from a fresh array. Without a deterministic tiebreak
    // equal rows can swap, which reads as the table churning on its own.
    const tied = [chat("z", { rssBytes: 10 }), chat("y", { rssBytes: 10 })];
    expect(sortChats(tied, "mem").map((c) => c.chatId)).toEqual(["y", "z"]);
    expect(sortChats([...tied].reverse(), "mem").map((c) => c.chatId)).toEqual(["y", "z"]);
  });

  it("does not mutate the array it was given", () => {
    const original = [...rows];
    sortChats(rows, "cpu");
    expect(rows).toEqual(original);
  });
});
