/**
 * Per-SESSION resolution of a project's MCP servers.
 *
 * `project-config.ts` expands `${VAR}` once, at config load, from the manager's
 * own environment — so everything it produces is shared by every chat in the
 * project. That is correct for an API key and exactly wrong for a port: a
 * project that wrote `${SIM_PORT:-5273}` got a LITERAL 5273 in every chat, and
 * three worktrees running the same server fought over one port.
 *
 * Worse than the clash: a stdio MCP that fronts a dev server will happily adopt
 * an already-healthy server on "its" port. Two worktrees on one port means the
 * second one screenshots the FIRST one's code and reports success. A wrong
 * answer beats a crash for how long it survives unnoticed.
 *
 * So this module owns the second pass — the one that runs per session, once the
 * chat's directory is known:
 *
 *   • `cwd` is stamped to the chat's own directory, so a relative
 *     `./tools/sim-mcp/index.mjs` resolves inside the worktree and any server
 *     that derives identity from its own location works per-worktree for free.
 *   • `{mcpPort}` / `{worktree}` / … placeholders are substituted in
 *     `env`, `args` and `url`.
 *   • Dispatch-only keys are STRIPPED, so they never reach a harness SDK.
 */
import { createServer } from "node:net";
import { basename, resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";
import {
  DEFAULT_MCP_PORT_RANGE,
  MCP_DISPATCH_ONLY_KEYS,
  type McpPortLease,
  type McpServerConfig,
} from "@dispatch/shared";

/** The store surface this needs — narrowed so tests can hand it a fake. */
export interface McpPortStore {
  updateMcpPortLeases<T>(
    fn: (leases: McpPortLease[]) => { leases: McpPortLease[]; result: T } | Promise<{ leases: McpPortLease[]; result: T }>,
  ): Promise<T>;
  listMcpPortLeases(): Promise<McpPortLease[]>;
}

/**
 * The string that identifies a checkout. Case is folded ONLY where the
 * filesystem folds it: Windows and macOS hand the same tree back with different
 * casing depending on who launched it, and two spellings of one checkout must
 * not become two leases (two ports, two dev servers, for one tree). On Linux,
 * where paths are case-sensitive, `/srv/A` and `/srv/a` really are different
 * checkouts and folding them together would collide two trees onto one port —
 * the precise failure this whole module exists to prevent.
 */
export function checkoutKey(root: string, platform: NodeJS.Platform = process.platform): string {
  const slashed = String(root).replace(/\\/g, "/");
  // Strip trailing slashes so `/srv/a` and `/srv/a/` are one key — but not past
  // a filesystem ROOT, where the slash is the path. Without the guard `"/"`
  // collapses to `""` and `"C:/"` to `"C:"`: two keys that no longer name a
  // directory, so the stale-lease reclaim (which tests the key with existsSync)
  // would treat every such lease as dead and hand its port out twice.
  const trimmed = slashed.replace(/\/+$/, "");
  const norm = trimmed === "" ? "/" : /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}/` : trimmed;
  return platform === "win32" || platform === "darwin" ? norm.toLowerCase() : norm;
}

/** Everything the per-session pass needs to know about where it is running. */
export interface McpSessionContext {
  projectId: string;
  /** The chat's directory: its worktree when it has one, else the repo root. */
  cwd: string;
  repoRoot: string;
  chatId?: string;
  /** Branch name when known; falls back to the directory's own name. */
  branch?: string;
}

/**
 * Substitute `{token}` placeholders. Deliberately the same shape as
 * `substitutePorts` in `runner.ts` — an unknown or out-of-range placeholder is
 * left ALONE rather than blanked, so a typo shows up in the config as itself
 * instead of silently becoming an empty string that a server reads as "unset".
 */
export function substituteMcpTokens(
  input: string,
  ctx: McpSessionContext,
  ports: number[] = [],
): string {
  return input.replace(/\{(mcpPort\d*|worktree|worktreeName|repoRoot|chatId)\}/g, (m, token: string) => {
    if (token.startsWith("mcpPort")) {
      const n = token.slice("mcpPort".length);
      const idx = n === "" ? 0 : Number(n) - 1;
      const p = ports[idx];
      return p !== undefined ? String(p) : m;
    }
    switch (token) {
      case "worktree":
        return ctx.cwd;
      case "worktreeName":
        return ctx.branch ?? basename(ctx.cwd);
      case "repoRoot":
        return ctx.repoRoot;
      case "chatId":
        return ctx.chatId ?? m;
      default:
        return m;
    }
  });
}

/** True when nothing is listening on `port` and we may bind it. */
export async function isPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((res) => {
    const srv = createServer();
    srv.once("error", () => res(false));
    srv.once("listening", () => srv.close(() => res(true)));
    try {
      srv.listen(port, host);
    } catch {
      res(false);
    }
  });
}

const sameLease = (l: McpPortLease, projectId: string, server: string, checkout: string): boolean =>
  l.projectId === projectId && l.server === server && l.checkout === checkout;

/**
 * Leases ports per (project, server, checkout). Stable across restarts, which a
 * server that ADOPTS a healthy dev server on its port depends on — a port that
 * moved every boot would strand the previous one holding its socket.
 */
export class McpPortLeaseService {
  constructor(
    private readonly store: McpPortStore,
    private readonly probe: (port: number) => Promise<boolean> = isPortFree,
    /** Injected so tests don't depend on the real filesystem. */
    private readonly checkoutExists: (path: string) => boolean = existsSync,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Ports for one server in one checkout — the SAME ports on every call, unless
   * the requested count changed. Never returns a port another live lease holds.
   */
  async lease(
    projectId: string,
    server: string,
    checkoutPath: string,
    count: number,
    range: readonly [number, number] = DEFAULT_MCP_PORT_RANGE,
  ): Promise<number[]> {
    const checkout = checkoutKey(checkoutPath);
    return this.store.updateMcpPortLeases(async (leases) => {
      // Reclaim first: a lease whose checkout is gone from disk is a deleted
      // worktree that never got an explicit release (a crash, a manual `git
      // worktree remove`). Without this the band silently fills up over weeks.
      const live = leases.filter(
        (l) => sameLease(l, projectId, server, checkout) || this.checkoutExists(l.checkout),
      );

      const existing = live.find((l) => sameLease(l, projectId, server, checkout));
      if (existing && existing.ports.length === count) {
        return { leases: live, result: existing.ports };
      }

      const taken = new Set(
        live.filter((l) => !sameLease(l, projectId, server, checkout)).flatMap((l) => l.ports),
      );
      const [min, max] = range;
      const picked: number[] = [];
      for (let p = min; p <= max && picked.length < count; p++) {
        if (taken.has(p)) continue;
        if (!(await this.probe(p))) continue;
        picked.push(p);
      }
      if (picked.length < count) {
        // Every slot in the band is leased or occupied. Throw rather than
        // silently hand back a colliding port: `resolveMcpServers` catches this
        // and starts the server WITHOUT substitution, so the failure surfaces as
        // an unexpanded `{mcpPort}` the server itself will complain about —
        // loud, and traceable to this message.
        throw new Error(
          `no free port for MCP server "${server}" in ${min}-${max} ` +
            `(${taken.size} leased). Widen its portRange, or prune stale worktrees.`,
        );
      }

      const next: McpPortLease = {
        projectId,
        server,
        checkout,
        ports: picked,
        leasedAt: this.now(),
      };
      return {
        leases: [...live.filter((l) => !sameLease(l, projectId, server, checkout)), next],
        result: picked,
      };
    });
  }

  /** Drop every lease for a checkout — called when its worktree is removed. */
  async releaseCheckout(checkoutPath: string): Promise<void> {
    const checkout = checkoutKey(checkoutPath);
    await this.store.updateMcpPortLeases((leases) => ({
      leases: leases.filter((l) => l.checkout !== checkout),
      result: undefined,
    }));
  }
}

/**
 * Resolve one configured server for one session: strip Dispatch-only keys,
 * stamp `cwd`, and substitute placeholders.
 *
 * `ports` is passed in rather than leased here so the caller can lease once and
 * reuse the same numbers for both the session and the prewarm command.
 */
export function resolveMcpServer(
  config: McpServerConfig,
  ctx: McpSessionContext,
  ports: number[] = [],
): McpServerConfig {
  const sub = (v: string): string => substituteMcpTokens(v, ctx, ports);
  const out: Record<string, unknown> = { ...config };
  for (const key of MCP_DISPATCH_ONLY_KEYS) delete out[key];

  if (config.args) out.args = config.args.map(sub);
  if (config.env) {
    out.env = Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, sub(v)]));
  }
  if (config.url) out.url = sub(config.url);
  if (config.headers) {
    out.headers = Object.fromEntries(Object.entries(config.headers).map(([k, v]) => [k, sub(v)]));
  }

  // Only a stdio server has a working directory. An explicit `cwd` in config is
  // honored (and substituted) — that's the documented opt-out from per-worktree
  // isolation. Otherwise the chat's own directory, which IS the isolation.
  if (config.command) {
    out.cwd = config.cwd ? resolvePath(ctx.cwd, sub(config.cwd)) : ctx.cwd;
  }
  return out as McpServerConfig;
}

/**
 * Resolve a whole `mcpServers` record for a session, leasing ports for any
 * server that asked for them.
 *
 * A server whose lease fails is returned UNRESOLVED-but-stripped rather than
 * dropped: losing one server's port isolation is bad, but silently removing its
 * tools mid-session looks to the agent like the tools never existed.
 */
export async function resolveMcpServers(
  servers: Record<string, McpServerConfig>,
  ctx: McpSessionContext,
  leases?: McpPortLeaseService,
  onError?: (server: string, err: unknown) => void,
): Promise<Record<string, McpServerConfig>> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    let ports: number[] = [];
    if (config.ports && leases) {
      try {
        ports = await leases.lease(
          ctx.projectId,
          name,
          ctx.cwd,
          config.ports,
          config.portRange ?? DEFAULT_MCP_PORT_RANGE,
        );
      } catch (err) {
        onError?.(name, err);
      }
    }
    out[name] = resolveMcpServer(config, ctx, ports);
  }
  return out;
}
