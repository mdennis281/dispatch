import { describe, it, expect } from "vitest";
import { BrowserMcpConfigSchema, resolveMcpPlacement, type McpServerConfig } from "@dispatch/shared";
import { buildBrowserMcpServers } from "./browser-mcp.js";
import type { PlacedServerSpec } from "./placement.js";
import { RELAY_TOKEN_ENV } from "./placement.js";
import { placeSessionMcpServers, placedMcpNote, type PlaceSessionMcpInput } from "./placement-session.js";

const MAC = "remote-host/cvx-mac";

function input(over: Partial<PlaceSessionMcpInput> = {}) {
  const bundled = buildBrowserMcpServers({ servers: ["playwright", "chrome-devtools"], chatId: "c1" });
  const servers: Record<string, McpServerConfig> = {
    ...bundled,
    sim: { type: "stdio", command: "node", args: ["./tools/sim.mjs"], env: { A: "1" }, cwd: "C:/work/repo" },
    web: { type: "http", url: "http://localhost:9000/mcp" },
  };
  const placed: Array<{ backendId: string; spec: PlacedServerSpec }> = [];
  const base: PlaceSessionMcpInput = {
    chatId: "c1",
    projectId: "p1",
    cwd: "C:/work/repo",
    servers,
    declared: servers,
    bundled: new Set(Object.keys(bundled)),
    browserConfig: BrowserMcpConfigSchema.parse({}),
    terminalDefault: MAC,
    canHostProcesses: (id) => id === MAC,
    place: (backendId, spec) => {
      placed.push({ backendId, spec });
      return { token: `tok-${spec.name}` };
    },
    socketPath: "\\\\.\\pipe\\test",
    labelOf: (id) => (id === MAC ? "CVX Mac" : undefined),
    ...over,
  };
  return { base, placed };
}

describe("resolveMcpPlacement", () => {
  it("chat override beats configured beats default, and `terminal` means the chat's terminal location", () => {
    const r = (o: Partial<Parameters<typeof resolveMcpPlacement>[0]>) =>
      resolveMcpPlacement({ server: "playwright", defaultLocation: "terminal", terminalDefault: MAC, ...o });
    expect(r({})).toEqual({ location: MAC, followsTerminal: true });
    expect(r({ configured: "local" })).toEqual({ location: "local", followsTerminal: false });
    expect(r({ configured: "local", chatOverrides: { playwright: "terminal" } })).toEqual({ location: MAC, followsTerminal: true });
    expect(r({ chatOverrides: { playwright: "remote-host/other" } })).toEqual({ location: "remote-host/other", followsTerminal: false });
    expect(r({ terminalDefault: "local" })).toEqual({ location: "local", followsTerminal: true });
  });
});

describe("placeSessionMcpServers", () => {
  it("by default sends the bundled browsers to the chat's terminal machine and leaves configured servers local", () => {
    const { base, placed } = input();
    const out = placeSessionMcpServers(base);
    expect(out.placed.map((p) => p.name).sort()).toEqual(["chrome-devtools", "playwright"]);
    expect(out.placed[0]).toMatchObject({ backendId: MAC, label: "CVX Mac" });
    expect(out.servers.sim).toBe(base.servers.sim);
    expect(out.servers.web).toBe(base.servers.web);

    const pw = out.servers.playwright!;
    expect(pw.args).toContain("--relay");
    expect(pw.args).not.toContain("--"); // no local command to run
    expect(pw.env).toEqual({ [RELAY_TOKEN_ENV]: "tok-playwright" });
    expect(pw.cwd).toBe("C:/work/repo");
    const spec = placed.find((p) => p.spec.name === "playwright")!.spec;
    expect(spec.bundled).toMatchObject({ server: "playwright", package: "@playwright/mcp", bin: "cli.js" });
    expect(spec.bundled!.version).toMatch(/^\d+\.\d+\.\d+/);
    // Portable: no Dispatch-host output dir in the flags.
    expect(spec.bundled!.args).not.toContain("--output-dir");
    expect(spec.bundled!.args.join(" ")).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(spec.bundled!.args).toEqual(expect.arrayContaining(["--isolated", "--headless"]));
  });

  it("keeps a browser that FOLLOWS the terminal local when that backend cannot host processes", () => {
    const { base, placed } = input({ canHostProcesses: () => false });
    const out = placeSessionMcpServers(base);
    expect(out.placed).toEqual([]);
    expect(placed).toEqual([]);
    expect(out.servers.playwright).toBe(base.servers.playwright);
  });

  it("relays a server that NAMES a backend even when that backend cannot host now, so each call says why", () => {
    const { base } = input({
      canHostProcesses: () => false,
      chatOverrides: { playwright: "remote-host/asleep" },
    });
    const out = placeSessionMcpServers(base);
    expect(out.placed).toEqual([{ name: "playwright", backendId: "remote-host/asleep", label: "remote-host/asleep" }]);
  });

  it("honours browser.location: local, and a chat override per server", () => {
    const { base } = input({
      browserConfig: BrowserMcpConfigSchema.parse({ location: "local" }),
      chatOverrides: { "chrome-devtools": "terminal" },
    });
    expect(placeSessionMcpServers(base).placed.map((p) => p.name)).toEqual(["chrome-devtools"]);
  });

  it("places a configured stdio server by its own `location`, run there exactly as written minus this host's cwd", () => {
    const { base, placed } = input({
      browserConfig: BrowserMcpConfigSchema.parse({ location: "local" }),
      declared: { sim: { command: "node", location: MAC } },
    });
    const out = placeSessionMcpServers(base);
    expect(out.placed.map((p) => p.name)).toEqual(["sim"]);
    expect(placed[0]!.spec).toEqual({
      chatId: "c1",
      projectId: "p1",
      name: "sim",
      cwd: "C:/work/repo",
      command: "node",
      args: ["./tools/sim.mjs"],
      env: { A: "1" },
    });
    // No manifest for a server Dispatch did not bundle: it starts on initialize.
    expect(out.servers.sim!.args).not.toContain("--manifest");
  });

  it("treats a project's own `playwright` as a configured server, not the bundled one", () => {
    const { base } = input({ bundled: new Set(["chrome-devtools"]) });
    // `browser.location` (terminal) no longer applies to it; its own default is local.
    expect(placeSessionMcpServers(base).placed.map((p) => p.name)).toEqual(["chrome-devtools"]);
  });

  it("never places a URL server", () => {
    const { base } = input({
      browserConfig: BrowserMcpConfigSchema.parse({ location: "local" }),
      chatOverrides: { web: MAC },
    });
    expect(placeSessionMcpServers(base).placed).toEqual([]);
  });

  it("keys a placed browser's manifest by the machine, apart from the local one", () => {
    const { base } = input();
    const placedArgs = placeSessionMcpServers(base).servers.playwright!.args!;
    const localArgs = base.servers.playwright!.args!;
    const manifestOf = (a: string[]) => a[a.indexOf("--manifest") + 1];
    expect(manifestOf(placedArgs)).toBeTruthy();
    expect(manifestOf(placedArgs)).not.toBe(manifestOf(localArgs));
  });
});

describe("placedMcpNote", () => {
  it("says nothing when nothing is placed, and names the machine and the localhost rule when something is", () => {
    expect(placedMcpNote([])).toBeUndefined();
    const note = placedMcpNote([
      { name: "playwright", backendId: MAC, label: "CVX Mac" },
      { name: "chrome-devtools", backendId: MAC, label: "CVX Mac" },
    ])!;
    expect(note).toContain("`playwright`, `chrome-devtools` run on CVX Mac (`remote-host/cvx-mac`)");
    expect(note).toMatch(/`localhost` is its own/);
  });
});
