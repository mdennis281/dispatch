/**
 * THE BUNDLED BROWSER MCPs — how an agent gets eyes.
 *
 * `run_subapp` has always told the agent it can "actually SEE your change
 * running" and then handed back a URL string. Nothing turned that URL into
 * pixels, so agents fell back to "the code looks right and the tests pass" and
 * shipped UI they had never looked at. The receiving half of the loop has been
 * in the tree since 57e9ebd (`mcp-assets.ts` renders an image a tool returns);
 * this is the half that produces one.
 *
 * TWO SERVERS, DELIBERATELY. They answer different questions and neither
 * subsumes the other:
 *
 *   • playwright     — "is it RIGHT?" Its accessibility-tree snapshot answers
 *                      "is the button there, does it say the right thing" in a
 *                      fraction of the context a screenshot costs, and it drives
 *                      any of chromium/firefox/webkit.
 *   • chrome-devtools — "then WHY is it wrong?" Real Chrome over CDP, with the
 *                      console, the network waterfall and performance traces
 *                      that an a11y snapshot cannot show you.
 *
 * SPAWNED WITH `node`, NOT `npx`. Both are real dependencies of this package,
 * resolved off disk. `npx` would mean a multi-minute download landing in the
 * middle of a task (exactly the friction that stops an agent bothering), a
 * different version per machine, and on Windows an outright failure: `npx` is a
 * `.cmd` shim, and since the CVE-2024-27980 fix Node refuses to spawn one
 * without a shell. `process.execPath` is a real executable and needs none.
 *
 * NO PORT LEASE. Every other server that fronts a browser wants one (see
 * `references/per-worktree.md`), because two worktrees on one port means the
 * second drives the first one's browser and reports success against the wrong
 * code. These two escape that: each session spawns its own stdio process, and
 * `--isolated` gives each an ephemeral profile and a debugging port chosen by
 * the launcher. There is no fixed port to collide on.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  BROWSER_MCP_SERVERS,
  BrowserMcpConfigSchema,
  resolveMcpEnablement,
  type BrowserMcpConfig,
  type BrowserMcpServer,
  type McpEnablementLayers,
  type McpServerConfig,
  type SubApp,
} from "@dispatch/shared";

const requireFrom = createRequire(import.meta.url);

/**
 * Absolute path to a dependency's CLI entry point.
 *
 * Resolved via its `package.json` rather than the script directly because
 * `@playwright/mcp` publishes an `exports` map that does NOT list `./cli.js` —
 * asking for it by name throws ERR_PACKAGE_PATH_NOT_EXPORTED even though the
 * file is right there. `./package.json` is exported by both, so this one route
 * works for both and keeps working if either adds an exports map later.
 */
function cliEntry(pkg: string, rel: string): string | null {
  try {
    return join(dirname(requireFrom.resolve(`${pkg}/package.json`)), rel);
  } catch {
    return null;
  }
}

/** What it takes to launch one bundled server. */
interface BrowserServerSpec {
  pkg: string;
  /** Path of the CLI entry WITHIN the package (its `bin` value). */
  bin: string;
  /** Flags derived from the resolved config. */
  args: (cfg: BrowserMcpConfig, outDir: string) => string[];
  env?: Record<string, string>;
}

const SPECS: Record<BrowserMcpServer, BrowserServerSpec> = {
  playwright: {
    pkg: "@playwright/mcp",
    bin: "cli.js",
    args: (cfg, outDir) => [
      // `--isolated` keeps the profile in memory. Without it every chat shares
      // one on-disk profile dir, and two agents browsing at once corrupt it.
      "--isolated",
      // Named explicitly because the default is the BUNDLED chromium, which is
      // pinned to this `@playwright/mcp` release and absent until someone runs
      // `playwright install`. See the `engine` docblock in project-config.ts.
      "--browser",
      cfg.engine,
      "--viewport-size",
      cfg.viewport,
      // Traces and saved files land in temp, never in the user's tree — a
      // screenshot showing up as an untracked file would end up in someone's
      // commit, and `--output-dir` has no per-repo-safe default.
      "--output-dir",
      outDir,
      ...(cfg.headless ? ["--headless"] : []),
    ],
  },
  "chrome-devtools": {
    pkg: "chrome-devtools-mcp",
    bin: "build/src/bin/chrome-devtools-mcp.js",
    args: (cfg) => [
      "--isolated",
      "--viewport",
      cfg.viewport,
      ...(cfg.headless ? ["--headless"] : []),
    ],
    // Google collects usage statistics from this server BY DEFAULT. Dispatch
    // installs it on the user's behalf, so it is not Dispatch's call to make —
    // opt out, and let a project turn it back on by configuring the server
    // itself under `mcpServers` if it wants to.
    env: { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1" },
  },
};

/** True when the project has something a browser could usefully point at. */
export function hasWebSubApp(subApps: readonly SubApp[]): boolean {
  return subApps.some((s) => Boolean(s.url));
}

/**
 * What the `browser:` block alone says about one server, before any toggle.
 *
 * `auto` is gated on a sub-app with a `url` because these two cost 53 tools of
 * context between them (24 + 29, measured). A repo with nothing to point a
 * browser at should pay nothing for them; an explicit list means the author has
 * decided, so the gate is skipped.
 *
 * This is the DEFAULT layer, not the answer: an `mcpEnabled` pin at either scope
 * overrides it, which is how you get playwright in a repo that declares no
 * sub-app at all (`browser: auto` would never offer it).
 */
export function browserServerDefault(
  server: BrowserMcpServer,
  config: BrowserMcpConfig | undefined,
  subApps: readonly SubApp[],
): boolean {
  const cfg = config ?? BrowserMcpConfigSchema.parse({});
  if (cfg.servers === "off") return false;
  if (Array.isArray(cfg.servers)) return cfg.servers.includes(server);
  return hasWebSubApp(subApps);
}

/** Human-readable reason for {@link browserServerDefault}'s verdict. */
export function browserServerDefaultReason(
  config: BrowserMcpConfig | undefined,
  subApps: readonly SubApp[],
): string {
  const cfg = config ?? BrowserMcpConfigSchema.parse({});
  if (cfg.servers === "off") return "project.yaml sets browser: off";
  if (Array.isArray(cfg.servers)) return "project.yaml lists browser servers explicitly";
  return hasWebSubApp(subApps)
    ? "on automatically — this project has a sub-app with a url"
    : "off automatically — no sub-app declares a url to point a browser at";
}

/**
 * Which servers this project actually gets: the `browser:` default for each,
 * overridden by an app- or project-scoped `mcpEnabled` pin.
 */
export function selectBrowserServers(
  config: BrowserMcpConfig | undefined,
  subApps: readonly SubApp[],
  enablement?: McpEnablementLayers,
): BrowserMcpServer[] {
  return BROWSER_MCP_SERVERS.filter(
    (name) =>
      resolveMcpEnablement(name, enablement, browserServerDefault(name, config, subApps))
        .effective,
  );
}

/** Inputs for {@link buildBrowserMcpServers}. */
export interface BrowserMcpBuildOptions {
  config?: BrowserMcpConfig;
  subApps?: readonly SubApp[];
  /** App/project `mcpEnabled` pins, applied over the `browser:` default. */
  enablement?: McpEnablementLayers;
  /**
   * Build EXACTLY these, skipping selection entirely. The catalog passes the
   * full set because it has to describe a disabled server too — you can't offer
   * to switch on something the builder already filtered away.
   */
  servers?: readonly BrowserMcpServer[];
  /**
   * Namespaces the output dir. The broker always passes the session's chat id,
   * so in practice every chat writes somewhere of its own; it is optional only
   * because tests build configs without a session. Omitted → one shared
   * fallback dir, which is fine for a caller that never launches a browser and
   * wrong for anything that does.
   */
  chatId?: string;
  /** Called when a selected server isn't installed, so it can be surfaced. */
  onUnavailable?: (server: BrowserMcpServer, pkg: string) => void;
}

/**
 * Assemble the bundled browser servers as ordinary `mcpServers` entries.
 *
 * The result is merged UNDER a project's own `mcpServers`, so a project that
 * wants different flags just declares a server of the same name and wins.
 */
export function buildBrowserMcpServers(
  opts: BrowserMcpBuildOptions = {},
): Record<string, McpServerConfig> {
  const cfg = opts.config ?? BrowserMcpConfigSchema.parse({});
  const selected =
    opts.servers ?? selectBrowserServers(opts.config, opts.subApps ?? [], opts.enablement);
  const out: Record<string, McpServerConfig> = {};

  for (const name of selected) {
    const spec = SPECS[name];
    const entry = cliEntry(spec.pkg, spec.bin);
    if (!entry) {
      // Missing rather than broken: report it and carry on. Half a browser is
      // better than none, and a hard failure here would take down a session
      // whose task may have nothing to do with the UI.
      opts.onUnavailable?.(name, spec.pkg);
      continue;
    }
    // "no-chat" rather than "shared": it names what actually happened, so a
    // stray dir on disk says which caller omitted the id instead of implying
    // some deliberate sharing arrangement.
    const outDir = join(tmpdir(), "dispatch-browser-mcp", opts.chatId ?? "no-chat");
    out[name] = {
      type: "stdio",
      command: process.execPath,
      args: [entry, ...spec.args(cfg, outDir)],
      ...(spec.env ? { env: spec.env } : {}),
    };
  }
  return out;
}
