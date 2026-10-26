import { describe, expect, it } from "vitest";
import type { HarnessEvent, HarnessSessionSpec } from "../types.js";
import { ClaudeSession } from "./session.js";

const SPEC: HarnessSessionSpec = {
  permissionMode: "bypassPermissions",
  effort: "low",
  systemPromptAppends: [],
  mcpServers: {},
  skills: [],
};

describe("ClaudeSession workflow guard", () => {
  it("reports a native PreToolUse denial as an in-place continuation", async () => {
    const session = new ClaudeSession({
      spec: {
        ...SPEC,
        toolGuard: (_name, input) =>
          input.command === "git push origin main" ? "use create_pr" : null,
      },
      genId: () => "id-1",
    });
    const hook = (
      session as unknown as {
        guardHook(): (input: unknown) => Promise<Record<string, unknown>>;
      }
    ).guardHook();

    const output = await hook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push origin main" },
      cwd: "/repo",
    });
    const event = await session.events[Symbol.asyncIterator]().next();

    expect(output).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: "use create_pr",
      },
    });
    expect(event.value as HarnessEvent).toEqual({
      type: "guard-blocked",
      toolName: "Bash",
      input: { command: "git push origin main", cwd: "/repo" },
      reason: "use create_pr",
      continuation: "in-place",
    });
    await session.dispose();
  });
});

describe("ClaudeSession compaction window", () => {
  const settingsFor = (spec: Partial<HarnessSessionSpec>) =>
    (
      new ClaudeSession({ spec: { ...SPEC, ...spec }, genId: () => "id" }) as unknown as {
        buildOptions(): { settings?: Record<string, unknown> };
      }
    ).buildOptions().settings;

  it("derives the CLI's window from the neutral limit so its own trigger lands on it", () => {
    expect(settingsFor({ contextTokenLimit: 100_000 })).toMatchObject({ autoCompactWindow: 133_000 });
  });

  it("leaves the window to the CLI with no limit, and ignores a value it would drop", () => {
    expect(settingsFor({})?.autoCompactWindow).toBeUndefined();
    expect(settingsFor({ autoCompactWindow: 20_000 })?.autoCompactWindow).toBeUndefined();
    expect(settingsFor({ autoCompactWindow: 400_000 })).toMatchObject({ autoCompactWindow: 400_000 });
  });
});
