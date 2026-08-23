/**
 * Tests for the two-layer MCP enablement resolver.
 *
 * The behaviours worth pinning are the ones a disabled-LIST design would get
 * wrong: a project re-enabling what the app switched off, an absent key meaning
 * "inherit" rather than "off", and `manager` ignoring both layers.
 */
import { describe, it, expect } from "vitest";
import {
  applyMcpEnablement,
  isAlwaysOnMcpServer,
  resolveMcpEnablement,
  MCP_ALWAYS_ON,
} from "./mcp-enablement.js";
import { MANAGER_SERVER_NAMES } from "./manager-tools.js";

describe("resolveMcpEnablement", () => {
  it("falls through to the caller's default when neither layer pins it", () => {
    expect(resolveMcpEnablement("ripgrep", {}, true)).toMatchObject({
      effective: true,
      source: "default",
      byDefault: true,
    });
    // The browser auto-gate's "no sub-app with a url" verdict arrives this way.
    expect(resolveMcpEnablement("playwright", {}, false)).toMatchObject({
      effective: false,
      source: "default",
    });
  });

  it("an app pin beats the default, and a project pin beats the app", () => {
    const layers = { app: { pw: false }, project: { pw: true } };
    expect(resolveMcpEnablement("pw", { app: layers.app }, true)).toMatchObject({
      effective: false,
      source: "app",
    });
    expect(resolveMcpEnablement("pw", layers, true)).toMatchObject({
      effective: true,
      source: "project",
    });
  });

  it("lets a project turn ON what the app turned off", () => {
    // The case a disabled-list design cannot express, and the reason both
    // layers are tri-state maps rather than lists of names.
    const r = resolveMcpEnablement("chrome-devtools", {
      app: { "chrome-devtools": false },
      project: { "chrome-devtools": true },
    }, false);
    expect(r.effective).toBe(true);
    expect(r.source).toBe("project");
  });

  it("treats an absent key as inherit, not as off", () => {
    const r = resolveMcpEnablement("ripgrep", { app: { other: false } }, true);
    expect(r.effective).toBe(true);
    expect(r.source).toBe("default");
    expect(r.app).toBeUndefined();
  });

  it("keeps every layer's value visible so a UI can show what decided", () => {
    const r = resolveMcpEnablement("pw", { app: { pw: true }, project: { pw: false } }, true);
    expect(r).toMatchObject({ app: true, project: false, byDefault: true, effective: false });
  });

  it("holds every Dispatch server on however either layer is pinned", () => {
    // Disabling one would remove the tools that write this very setting — and
    // the always-on set is DERIVED from the registry, so a category added later
    // is protected the moment it exists rather than once somebody remembers.
    for (const name of MANAGER_SERVER_NAMES) {
      const r = resolveMcpEnablement(name, { app: { [name]: false }, project: { [name]: false } }, true);
      expect(r.effective, name).toBe(true);
      expect(r.alwaysOn, name).toBe(true);
      expect(isAlwaysOnMcpServer(name)).toBe(true);
      expect(MCP_ALWAYS_ON).toContain(name);
    }
    // The retired single server is NOT protected: nothing is served under it.
    expect(isAlwaysOnMcpServer("manager")).toBe(false);
  });

  it("marks an ordinary server as not always-on", () => {
    expect(resolveMcpEnablement("ripgrep", {}, true).alwaysOn).toBe(false);
  });
});

describe("applyMcpEnablement", () => {
  const servers = { ripgrep: { command: "rg" }, sentry: { url: "https://x" } };

  it("drops only the servers a layer switched off", () => {
    expect(applyMcpEnablement(servers, { app: { sentry: false } })).toEqual({
      ripgrep: { command: "rg" },
    });
  });

  it("returns the input untouched when nothing is pinned", () => {
    expect(applyMcpEnablement(servers, {})).toBe(servers);
    expect(applyMcpEnablement(servers, undefined)).toBe(servers);
  });

  it("keeps a server the project re-enabled over an app pin", () => {
    const out = applyMcpEnablement(servers, {
      app: { sentry: false },
      project: { sentry: true },
    });
    expect(Object.keys(out).sort()).toEqual(["ripgrep", "sentry"]);
  });

  it("never drops a Dispatch server, even asked to", () => {
    const withManager = Object.fromEntries(
      MANAGER_SERVER_NAMES.map((n) => [n, { command: "n/a" }]),
    );
    const off = Object.fromEntries(MANAGER_SERVER_NAMES.map((n) => [n, false]));
    const out = applyMcpEnablement({ ...servers, ...withManager }, { project: off });
    for (const name of MANAGER_SERVER_NAMES) expect(out).toHaveProperty(name);
  });
});
