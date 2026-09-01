import { describe, expect, it } from "vitest";
import { mergeRunnerLogs } from "./RunnerTranscript.js";

describe("mergeRunnerLogs", () => {
  it("deduplicates REST/websocket overlap without dropping identical sibling lines", () => {
    const same = { stream: "stderr" as const, line: "boom", ts: 10 };
    const snapshot = [same, same];
    const live = [same, same, { stream: "stderr" as const, line: "exit 1", ts: 10 }];

    expect(mergeRunnerLogs(snapshot, live)).toEqual([
      same,
      same,
      { stream: "stderr", line: "exit 1", ts: 10 },
    ]);
  });
});
