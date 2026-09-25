/**
 * Tests for the layered MCP enablement resolver.
 *
 * The behaviours worth pinning are the ones a disabled-LIST design would get
 * wrong: a project re-enabling what the app switched off, an absent key meaning
 * "inherit" rather than "off", and `manager` ignoring both layers.
 */
import { describe, it, expect } from "vitest";
import {
  applyMcpEnablement,
  harnessEnablementLayers,
  isAlwaysOnMcpServer,
  mcpEnablementKeys,
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

  it("lets a model pin drop a server the project asked for", () => {
    // The ordering choice this design turns on: a project pin says "this repo
    // does not use that", a model pin says "this model cannot afford it". When
    // both are set the second decides, because it is about whether the session
    // can function at all — and it is never committed, so it cannot impose one
    // person's setup on a checkout.
    const out = applyMcpEnablement(servers, {
      project: { sentry: true },
      model: { sentry: false },
    });
    expect(Object.keys(out)).toEqual(["ripgrep"]);
  });

  it("lets a model pin re-enable what the provider switched off", () => {
    const out = applyMcpEnablement(servers, {
      harness: { sentry: false },
      model: { sentry: true },
    });
    expect(Object.keys(out).sort()).toEqual(["ripgrep", "sentry"]);
  });

  it("still drops nothing when only runtime layers are present and empty", () => {
    expect(applyMcpEnablement(servers, { harness: {}, model: {} })).not.toBe(servers);
    expect(Object.keys(applyMcpEnablement(servers, { harness: {}, model: {} })).sort()).toEqual(
      ["ripgrep", "sentry"],
    );
  });

  it("never drops a Dispatch server for a model either", () => {
    const withManager = Object.fromEntries(
      MANAGER_SERVER_NAMES.map((n) => [n, { command: "n/a" }]),
    );
    const off = Object.fromEntries(MANAGER_SERVER_NAMES.map((n) => [n, false]));
    const out = applyMcpEnablement({ ...servers, ...withManager }, { model: off });
    for (const name of MANAGER_SERVER_NAMES) expect(out).toHaveProperty(name);
  });
});

describe("runtime enablement keys", () => {
  it("answers to the provider and to provider/model, least specific first", () => {
    expect(mcpEnablementKeys("goose", "qwen3-coder:30b")).toEqual([
      "goose",
      "goose/qwen3-coder:30b",
    ]);
  });

  it("has no model key when the session has no model yet", () => {
    expect(mcpEnablementKeys("goose")).toEqual(["goose"]);
  });

  it("reports which layer decided, so the UI can say why", () => {
    const r = resolveMcpEnablement("sentry", {
      app: { sentry: true },
      harness: { sentry: false },
    });
    expect(r).toMatchObject({ effective: false, source: "harness", app: true, harness: false });
  });

  describe("harnessEnablementLayers", () => {
    const byKey = {
      goose: { playwright: false },
      "goose/qwen3-coder:30b": { sentry: false },
      claude: { playwright: true },
    };

    it("picks up both the provider and the model record", () => {
      expect(harnessEnablementLayers(byKey, "goose", "qwen3-coder:30b")).toEqual({
        harness: { playwright: false },
        model: { sentry: false },
      });
    });

    it("omits a layer with nothing pinned, so absent still means inherit", () => {
      // An empty object here would read as a layer that exists and pins
      // nothing, which is the same answer — but it would also make
      // applyMcpEnablement rebuild the record for no reason.
      expect(harnessEnablementLayers(byKey, "goose", "some-other-model")).toEqual({
        harness: { playwright: false },
      });
      expect(harnessEnablementLayers(byKey, "codex", "gpt-6")).toEqual({});
      expect(harnessEnablementLayers(undefined, "goose", "m")).toEqual({});
    });

    it("does not leak one provider's pins onto another", () => {
      expect(harnessEnablementLayers(byKey, "claude", "opus")).toEqual({
        harness: { playwright: true },
      });
    });
  });
});
