/**
 * `nextShellName` — the naming rule behind the Terminals panel's "New shell".
 *
 * Shells are keyed `${chatId}::${name}`, so a repeated name is a REUSE, not a
 * new shell; two clicks that both produced "shell" would look like a no-op.
 */
import { describe, it, expect } from "vitest";
import type { TerminalInfo } from "@dispatch/shared";
import { isLiveChatTerminal, nextShellName } from "./terminals.js";

const terminal = (over: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id: "chat-1::qa",
  chatId: "chat-1",
  name: "qa",
  cwd: "C:\\repo",
  status: "live",
  createdAt: 1,
  ...over,
});

describe("nextShellName", () => {
  it("starts at the bare base", () => {
    expect(nextShellName([])).toBe("shell");
  });

  it("counts up past taken names", () => {
    expect(nextShellName(["shell"])).toBe("shell 2");
    expect(nextShellName(["shell", "shell 2"])).toBe("shell 3");
  });

  it("fills a gap rather than tracking a high-water mark", () => {
    // "shell 2" was closed; reusing it is correct — nothing holds the name.
    expect(nextShellName(["shell", "shell 3"])).toBe("shell 2");
  });

  it("ignores the agent's own names (build/server) when picking", () => {
    expect(nextShellName(["build", "server"])).toBe("shell");
  });
});

describe("isLiveChatTerminal", () => {
  it("keeps only running terminals belonging to the chat", () => {
    expect(isLiveChatTerminal(terminal(), "chat-1")).toBe(true);
    expect(isLiveChatTerminal(terminal({ status: "exited" }), "chat-1")).toBe(false);
    expect(isLiveChatTerminal(terminal({ chatId: "chat-2" }), "chat-1")).toBe(false);
  });
});
