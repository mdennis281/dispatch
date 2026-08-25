/**
 * Tests for the bundled browser MCP servers.
 *
 * These run against the REAL resolved packages rather than a stub, because the
 * thing most likely to break is exactly what a stub would fake: whether
 * `@playwright/mcp`'s `exports` map still lets us find `cli.js` off its
 * `package.json`, and whether either package moved its bin. A stubbed resolver
 * would keep passing while the feature was dead in the field.
 *
 * What is NOT covered here: actually launching a browser. That needs Chrome and
 * a few seconds per case, so it belongs in an e2e, not a unit suite.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import {
  BrowserMcpConfigSchema,
  ProjectManifestSchema,
  type Project,
  type SubApp,
} from "@dispatch/shared";
import { buildProjectMcpCatalog } from "./mcp-catalog.js";
import {
  buildBrowserMcpServers,
  browserServerDefault,
  effectiveSubApps,
  selectBrowserServers,
  hasWebSubApp,
} from "./browser-mcp.js";

const webApp = { id: "dev", name: "Dev", url: "http://localhost:4319" } as SubApp;
const cliApp = { id: "cli", name: "CLI" } as SubApp;
const cfg = (over: Record<string, unknown> = {}) => BrowserMcpConfigSchema.parse(over);

describe("selectBrowserServers", () => {
  it("auto injects both servers for a project with a web sub-app", () => {
    expect(selectBrowserServers(cfg(), [webApp])).toEqual(["playwright", "chrome-devtools"]);
  });

  it("auto injects NOTHING when no sub-app has a url", () => {
    // The gate that keeps 53 tools out of a backend-only repo's context.
    expect(selectBrowserServers(cfg(), [cliApp])).toEqual([]);
    expect(selectBrowserServers(cfg(), [])).toEqual([]);
  });

  it("an explicit list overrides the gate", () => {
    // The author said so; not our place to second-guess it because no sub-app
    // declares a url (a project may serve something Dispatch doesn't run).
    expect(selectBrowserServers(cfg({ servers: ["playwright"] }), [cliApp])).toEqual(["playwright"]);
  });

  it("off wins even with a web sub-app", () => {
    expect(selectBrowserServers(cfg({ servers: "off" }), [webApp])).toEqual([]);
  });

  it("dedupes a repeated entry", () => {
    expect(selectBrowserServers(cfg({ servers: ["playwright", "playwright"] }), [])).toEqual([
      "playwright",
    ]);
  });

  it("treats a missing config as auto, not off", () => {
    expect(selectBrowserServers(undefined, [webApp])).toHaveLength(2);
  });

  it("an mcpEnabled pin overrides the auto-gate in both directions", () => {
    // On in a repo the gate would exclude: no sub-app declares a url, but
    // somebody asked for a browser here anyway.
    expect(selectBrowserServers(cfg(), [cliApp], { project: { playwright: true } })).toEqual([
      "playwright",
    ]);
    // …and off in a repo the gate would include.
    expect(selectBrowserServers(cfg(), [webApp], { app: { playwright: false } })).toEqual([
      "chrome-devtools",
    ]);
  });

  it("a project pin beats an app pin", () => {
    expect(
      selectBrowserServers(cfg(), [webApp], {
        app: { "chrome-devtools": false },
        project: { "chrome-devtools": true },
      }),
    ).toEqual(["playwright", "chrome-devtools"]);
  });

  it("a pin overrides an explicit browser: list too", () => {
    // `browser:` is the DEFAULT layer, not the answer — otherwise a repo that
    // listed its servers could never be overridden per install.
    expect(
      selectBrowserServers(cfg({ servers: ["playwright"] }), [], {
        app: { playwright: false, "chrome-devtools": true },
      }),
    ).toEqual(["chrome-devtools"]);
  });
});

describe("browserServerDefault", () => {
  it("reports what `browser:` alone says, before any pin", () => {
    expect(browserServerDefault("playwright", cfg(), [webApp])).toBe(true);
    expect(browserServerDefault("playwright", cfg(), [cliApp])).toBe(false);
    expect(browserServerDefault("playwright", cfg({ servers: "off" }), [webApp])).toBe(false);
    expect(browserServerDefault("chrome-devtools", cfg({ servers: ["playwright"] }), [])).toBe(
      false,
    );
  });
});

describe("hasWebSubApp", () => {
  it("is true only when some sub-app declares a url", () => {
    expect(hasWebSubApp([cliApp, webApp])).toBe(true);
    expect(hasWebSubApp([cliApp])).toBe(false);
  });
});

describe("effectiveSubApps", () => {
  it("falls back to the store copy when the config answers EMPTY, not just undefined", () => {
    // The bug this exists for. `getSubApps` returns `[]` — never `undefined` —
    // for a project whose config isn't in the cache yet, so the obvious
    // `getSubApps(id) ?? project.subApps` never falls back and the browser
    // auto-gate concludes "no sub-app declares a url" for a project with three.
    expect(effectiveSubApps([], [webApp])).toEqual([webApp]);
    expect(effectiveSubApps(undefined, [webApp])).toEqual([webApp]);
  });

  it("still prefers the live config when it has anything to say", () => {
    // Config-first is the point: a manifest edit that ADDED a sub-app has to
    // win over the store copy that hasn't re-synced yet.
    expect(effectiveSubApps([webApp], [cliApp])).toEqual([webApp]);
    // …including when the live answer REMOVES the url — a non-empty config is
    // an answer, so the gate must close rather than reach for the stale copy.
    expect(effectiveSubApps([cliApp], [webApp])).toEqual([cliApp]);
  });

  it("is empty when neither side has anything", () => {
    expect(effectiveSubApps(undefined, undefined)).toEqual([]);
    expect(effectiveSubApps([], [])).toEqual([]);
  });

  it("gates the browser servers on correctly through a cold config cache", () => {
    // End to end through the thing that actually consumes it: a cold cache used
    // to take the browser tools away from a session that should have had them.
    const cold = effectiveSubApps([], [webApp]);
    expect(selectBrowserServers(cfg(), cold)).toEqual(["playwright", "chrome-devtools"]);
  });
});

describe("buildBrowserMcpServers", () => {
  it("resolves both CLIs to files that exist on disk", () => {
    // The regression this exists for: `@playwright/mcp` publishes an exports map
    // that does not list ./cli.js, so resolving the script by name throws. If
    // either package moves its bin, this fails here instead of at the agent's
    // first screenshot.
    // `eager`, so `args[0]` is the CLI itself. Through the lazy shim it would be
    // the SHIM's path — which always exists, so this assertion would pass
    // whatever happened to the package and stop guarding anything.
    const servers = buildBrowserMcpServers({ subApps: [webApp], eager: true });
    expect(Object.keys(servers)).toEqual(["playwright", "chrome-devtools"]);
    for (const [name, s] of Object.entries(servers)) {
      expect(s.command, name).toBe(process.execPath);
      expect(existsSync(s.args![0]), `${name} entry ${s.args![0]}`).toBe(true);
    }
  });

  it("fronts each server with an attributable lazy shim, and the shim exists", () => {
    const servers = buildBrowserMcpServers({ subApps: [webApp], chatId: "chat-owner" });
    for (const [name, s] of Object.entries(servers)) {
      const args = s.args!;
      expect(existsSync(args[0]!), `${name} shim ${args[0]}`).toBe(true);
      expect(args[0], name).toMatch(/lazy-browser-shim\.mjs$/);
      expect(args, name).toContain("--owner-dir");
      expect(args[args.indexOf("--owner-dir") + 1], name).toContain("chat-owner");
      expect(args, name).toContain("--manifest");
      // The real command follows `--`, and is still node + a CLI that exists.
      const sep = args.indexOf("--");
      expect(sep, name).toBeGreaterThan(0);
      expect(args[sep + 1], name).toBe(process.execPath);
      expect(existsSync(args[sep + 2]!), `${name} entry ${args[sep + 2]}`).toBe(true);
    }
  });

  it("keys the manifest to the argv, so a config change can't reuse a stale tool list", () => {
    const manifestOf = (s: { args?: string[] }) => s.args![s.args!.indexOf("--manifest") + 1];
    const a = buildBrowserMcpServers({ config: cfg({ viewport: "800x600" }), subApps: [webApp] });
    const b = buildBrowserMcpServers({ config: cfg({ viewport: "1280x720" }), subApps: [webApp] });
    expect(manifestOf(a.playwright)).not.toBe(manifestOf(b.playwright));
    // …and is stable for the same argv, or nothing would ever be cached at all.
    const again = buildBrowserMcpServers({ config: cfg({ viewport: "800x600" }), subApps: [webApp] });
    expect(manifestOf(again.playwright)).toBe(manifestOf(a.playwright));
  });

  it("shares one manifest across chats — the chat id must not reach the key", () => {
    // The bug this guards: the output dir is per-chat and rides in the same
    // argv, so hashing the argv verbatim gave every chat its own cache file and
    // therefore its own COLD start — the exact eager spawn the shim removes.
    const manifestOf = (s: { args?: string[] }) => s.args![s.args!.indexOf("--manifest") + 1];
    const a = buildBrowserMcpServers({ subApps: [webApp], chatId: "chat-a" });
    const b = buildBrowserMcpServers({ subApps: [webApp], chatId: "chat-b" });
    expect(manifestOf(a.playwright)).toBe(manifestOf(b.playwright));
    // The output dir itself still differs — that separation is a real one.
    expect(a.playwright.args!.join(" ")).not.toBe(b.playwright.args!.join(" "));
  });

  it("spawns node directly rather than an npx shim", () => {
    // On Windows `npx` is a .cmd and Node refuses to spawn one without a shell
    // (CVE-2024-27980). `process.execPath` is a real executable.
    const { playwright } = buildBrowserMcpServers({ subApps: [webApp] });
    expect(playwright.command).toBe(process.execPath);
    expect(playwright.args!.join(" ")).not.toMatch(/npx/);
  });

  it("passes headless, the engine and the viewport to both", () => {
    const servers = buildBrowserMcpServers({
      config: cfg({ viewport: "800x600", engine: "msedge" }),
      subApps: [webApp],
    });
    const pw = servers.playwright.args!;
    expect(pw).toContain("--headless");
    expect(pw).toContain("--isolated");
    expect(pw[pw.indexOf("--viewport-size") + 1]).toBe("800x600");
    expect(pw[pw.indexOf("--browser") + 1]).toBe("msedge");

    const cdt = servers["chrome-devtools"].args!;
    expect(cdt).toContain("--headless");
    expect(cdt).toContain("--isolated");
    expect(cdt[cdt.indexOf("--viewport") + 1]).toBe("800x600");
  });

  it("omits --headless when the project asked for a headed browser", () => {
    const servers = buildBrowserMcpServers({ config: cfg({ headless: false }), subApps: [webApp] });
    expect(servers.playwright.args).not.toContain("--headless");
    expect(servers["chrome-devtools"].args).not.toContain("--headless");
  });

  it("opts chrome-devtools out of Google's usage statistics", () => {
    // On by default in that package. Dispatch installed it on the user's
    // behalf, so it is not Dispatch's call to leave phoning home enabled.
    const servers = buildBrowserMcpServers({ subApps: [webApp] });
    expect(servers["chrome-devtools"].env).toMatchObject({
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
    });
  });

  it("gives each chat its own output dir, outside the repo", () => {
    const a = buildBrowserMcpServers({ subApps: [webApp], chatId: "chat-a" });
    const b = buildBrowserMcpServers({ subApps: [webApp], chatId: "chat-b" });
    const dir = (s: typeof a) => s.playwright.args![s.playwright.args!.indexOf("--output-dir") + 1];
    expect(dir(a)).not.toBe(dir(b));
    expect(dir(a)).toContain("chat-a");
    // Never the working tree: an untracked screenshot would land in a commit.
    expect(dir(a)).not.toContain("packages");
  });

  it("returns nothing at all when the project is gated out", () => {
    expect(buildBrowserMcpServers({ subApps: [cliApp] })).toEqual({});
  });

  it("skips a server an mcpEnabled pin switched off", () => {
    const servers = buildBrowserMcpServers({
      subApps: [webApp],
      enablement: { project: { "chrome-devtools": false } },
    });
    expect(Object.keys(servers)).toEqual(["playwright"]);
  });

  it("an explicit `servers` list bypasses selection entirely", () => {
    // How the catalog gets a config for a server it must still DESCRIBE (and
    // offer a switch for) after a toggle turned it off.
    const servers = buildBrowserMcpServers({
      subApps: [cliApp],
      enablement: { app: { playwright: false } },
      servers: ["playwright"],
    });
    expect(Object.keys(servers)).toEqual(["playwright"]);
  });
});

describe("manifest browser block", () => {
  const parse = (browser: unknown) =>
    ProjectManifestSchema.parse({ name: "p", browser }).browser;

  it("accepts the bare-list shorthand", () => {
    expect(parse(["playwright"])).toMatchObject({ servers: ["playwright"] });
  });

  it("reads YAML's boolean false as off", () => {
    // `browser: off` is resolved to boolean false by YAML 1.1 before any schema
    // sees it, so the most natural spelling has to keep working.
    expect(parse(false)).toMatchObject({ servers: "off" });
    expect(parse("off")).toMatchObject({ servers: "off" });
    expect(parse(true)).toMatchObject({ servers: "auto" });
  });

  it("defaults to auto/headless/chrome when only some fields are given", () => {
    expect(parse({ viewport: "1920x1080" })).toMatchObject({
      servers: "auto",
      headless: true,
      engine: "chrome",
      viewport: "1920x1080",
    });
  });

  it("rejects a malformed viewport and an unknown server", () => {
    expect(() => parse({ viewport: "big" })).toThrow(/1280x800/);
    expect(() => parse(["safari"])).toThrow();
  });
});

/**
 * The catalog's external-probe path against a REAL server.
 *
 * Until Dispatch bundled these, every project had zero external `mcpServers`,
 * so `buildProjectMcpCatalog`'s external branch — spawn a stdio child, run
 * `tools/list`, flatten each schema, tear the transport down — had never once
 * run against a real server outside its own scripted tests. Shipping two by
 * default makes that path live for every user, so it gets exercised for real
 * here rather than trusted.
 *
 * Only `tools/list` is involved: no browser is launched, so this stays a
 * sub-second unit test and needs no Chrome on the runner.
 */
describe("catalog probe against a real bundled server", () => {
  it("enumerates playwright's tools with flattened params", async () => {
    const servers = buildBrowserMcpServers({ subApps: [webApp] });
    const catalog = await buildProjectMcpCatalog(
      { id: "p", name: "p", repoPath: process.cwd() } as Project,
      { mcpServers: { playwright: servers.playwright }, timeoutMs: 30_000 },
    );

    const entry = catalog.servers.find((s) => s.name === "playwright");
    expect(entry, "playwright missing from catalog").toBeDefined();
    expect(entry!.status, `probe failed: ${entry!.error ?? ""}`).toBe("ok");
    expect(entry!.kind).toBe("external");
    expect(entry!.transport?.type).toBe("stdio");

    const nav = entry!.tools.find((t) => t.name === "browser_navigate");
    expect(nav, "browser_navigate missing").toBeDefined();
    expect(nav!.qualifiedName).toBe("mcp__playwright__browser_navigate");
    // The flattening is the part with real logic in it — a tool whose schema
    // didn't survive would show up as a tool with no parameters at all.
    expect(nav!.params.map((p) => p.name)).toContain("url");
    expect(nav!.params.find((p) => p.name === "url")).toMatchObject({
      type: "string",
      required: true,
    });
  }, 60_000);
});
