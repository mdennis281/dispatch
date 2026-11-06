/**
 * `ctx.terminals.runs` / `onRun` in the fake: `t.terminals.startRun/endRun`
 * play core's side, with the host's rule that a run elsewhere is counted but
 * its command hidden.
 */
import { describe, it, expect } from "vitest";
import { createTestContext } from "./testing.js";

describe("createTestContext terminal runs", () => {
  it("reports runs anywhere, hides commands off this plugin's backends, and fires onRun", () => {
    const t = createTestContext({ id: "remote-host" });
    t.ctx.terminals!.registerBackend({
      id: "remote-host/cvx-mac",
      label: "CVX Mac",
      shell: "bash",
      spawn: async () => {
        throw new Error("unused");
      },
    });
    const seen: string[] = [];
    const off = t.ctx.terminals!.onRun!((e) => seen.push(`${e.kind}:${e.run.runId}:${e.run.command ?? "-"}`));

    const local = t.terminals.startRun({ chatId: "c1", command: "pnpm install", startedAt: 1 });
    const mine = t.terminals.startRun({ chatId: "c1", backend: "remote-host/cvx-mac", command: "xcodebuild", startedAt: 2 });
    expect(t.ctx.terminals!.runs!().map((r) => [r.runId, r.command])).toEqual([
      [local.runId, undefined],
      [mine.runId, "xcodebuild"],
    ]);
    expect(t.ctx.terminals!.runs!({ backend: "local" })).toHaveLength(1);

    expect(t.terminals.endRun(local.runId)).toBe(true);
    expect(t.terminals.endRun(local.runId)).toBe(false);
    expect(seen).toEqual([`started:${local.runId}:-`, `started:${mine.runId}:xcodebuild`, `ended:${local.runId}:-`]);
    off();
    t.terminals.endRun(mine.runId);
    expect(seen).toHaveLength(3);
    expect(t.ctx.terminals!.runs!()).toEqual([]);
  });
});
