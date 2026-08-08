/**
 * `belongsToChat` — which runners the right panel's Apps tab is responsible for.
 *
 * The bug it exists for: the Sidebar launches project-level (no chatId), the
 * panel filtered on `chatId === chat.id`, and the result appeared in no panel at
 * all — no logs, no URL, no Stop.
 */
import { describe, it, expect } from "vitest";
import type { RunnerInstance } from "@dispatch/shared";
import { belongsToChat } from "./runners.js";

const runner = (over: Partial<RunnerInstance>): RunnerInstance => ({
  id: "r1",
  worktreePath: "C:/repo",
  subAppId: "game",
  kind: "process",
  status: "running",
  ...over,
});

describe("belongsToChat", () => {
  it("keeps the chat's own runners", () => {
    expect(belongsToChat(runner({ chatId: "c1", projectId: "p1" }), "c1", "p1")).toBe(true);
  });

  it("keeps a project-level (sidebar-launched) runner — the regression", () => {
    expect(belongsToChat(runner({ projectId: "p1" }), "c1", "p1")).toBe(true);
  });

  it("drops a project-level runner from ANOTHER project", () => {
    expect(belongsToChat(runner({ projectId: "p2" }), "c1", "p1")).toBe(false);
  });

  it("drops another chat's runner — it has a panel of its own", () => {
    expect(belongsToChat(runner({ chatId: "c2", projectId: "p1" }), "c1", "p1")).toBe(false);
  });

  it("drops an unattributable runner (no chat, no project) rather than guessing", () => {
    expect(belongsToChat(runner({}), "c1", "p1")).toBe(false);
    expect(belongsToChat(runner({ projectId: "p1" }), "c1", undefined)).toBe(false);
  });
});
