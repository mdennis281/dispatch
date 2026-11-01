/**
 * `nextShellName` — the naming rule behind the Terminals panel's "New shell".
 *
 * Shells are keyed `${chatId}::${name}`, so a repeated name is a REUSE, not a
 * new shell; two clicks that both produced "shell" would look like a no-op.
 */
import { describe, it, expect } from "vitest";
import type { TerminalBackendInfo, TerminalInfo } from "@dispatch/shared";
import {
  backendHint,
  isActiveTerminal,
  isLiveChatTerminal,
  missingBackendHint,
  nextShellName,
  sortBackendsForPicker,
} from "./terminals.js";

const terminal = (over: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id: "chat-1::qa",
  chatId: "chat-1",
  name: "qa",
  cwd: "C:\\repo",
  status: "live",
  createdAt: 1,
  ...over,
});

describe("pickers group backends by plugin (E12)", () => {
  const b = (id: string, label: string, pluginId?: string): TerminalBackendInfo => ({
    id,
    label,
    shell: "bash",
    fallback: "local",
    ...(pluginId ? { pluginId } : {}),
  });

  it("keeps each plugin's backends together, plugins and names in order", () => {
    const sorted = sortBackendsForPicker([
      b("remote-host/mini", "mini", "remote-host"),
      b("proxmox", "Proxmox container", "proxmox-terminal"),
      b("remote-host/cvx-mac", "cvx-mac", "remote-host"),
    ]);
    expect(sorted.map((x) => x.id)).toEqual(["proxmox", "remote-host/cvx-mac", "remote-host/mini"]);
  });

  it("leaves the plugin to the heading: a row's hint is only its status", () => {
    expect(backendHint(b("proxmox", "Proxmox", "proxmox-terminal"))).toBeUndefined();
    expect(backendHint({ ...b("remote-host/cvx-mac", "cvx-mac", "remote-host"), status: { state: "offline", detail: "asleep", since: 1 } })).toBe(
      "offline · asleep",
    );
  });
});

describe("missingBackendHint", () => {
  it("says an id this version cannot read needs a newer Dispatch, not a plugin install", () => {
    expect(missingBackendHint("box")).toBe("not installed");
    expect(missingBackendHint("future:box")).toBe("needs a newer Dispatch");
  });
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

describe("isActiveTerminal", () => {
  it("counts a shell that is running a command or hosting a server", () => {
    expect(isActiveTerminal(terminal({ busy: true }))).toBe(true);
    expect(
      isActiveTerminal(terminal({ background: { command: "pnpm dev", since: 1 } })),
    ).toBe(true);
  });

  it("does NOT count an idle prompt — the whole point of the badge", () => {
    // Live, finished, exit 0 sitting there: nothing to act on.
    expect(isActiveTerminal(terminal({ lastExitCode: 0 }))).toBe(false);
  });

  it("does not count a dead shell, however busy it looked", () => {
    expect(isActiveTerminal(terminal({ status: "exited", busy: true }))).toBe(false);
    expect(isActiveTerminal(undefined)).toBe(false);
  });
});
