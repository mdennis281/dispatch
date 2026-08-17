/**
 * Runs an MCP server's `prewarm` command in a freshly created worktree.
 *
 * A stdio MCP is spawned lazily, by the harness, on the first tool call — and a
 * server that fronts a dev server pays that server's whole boot cost there. With
 * one checkout that was a one-off; with a worktree per task it is a cold boot
 * every time, on the call the agent is waiting for.
 *
 * `prewarm` moves that cost to worktree-creation time, where nobody is blocked.
 * It runs with the SAME resolved env the session will get — including the port
 * leased for this checkout — so what it boots is the thing the session then
 * adopts rather than a second server on a different port.
 *
 * Best-effort by construction: a prewarm that fails must never fail the worktree
 * (you would lose a good checkout because a dev server didn't start), so every
 * failure is reported as a notice and swallowed.
 */
import { execa } from "execa";
import type { McpServerConfig, Project } from "@dispatch/shared";
import { resolveMcpServers, type McpPortLeaseService } from "./mcp-session.js";
import { scrubManagerEnv } from "./runner.js";
import { basename } from "node:path";

export interface PrewarmOutcome {
  server: string;
  command: string;
  ok: boolean;
  error?: string;
}

/** Spawn surface, injectable so tests never start a real process. */
export type PrewarmSpawn = (
  command: string,
  opts: { cwd: string; env: Record<string, string> },
) => Promise<{ exitCode: number | undefined; stderr: string }>;

const defaultSpawn: PrewarmSpawn = async (command, opts) => {
  const r = await execa(command, {
    // A prewarm command is authored in the committed project.yaml, the same
    // trust level as a subApp's `dev`. `shell: true` because it's a command
    // STRING, and because pnpm/npm are .cmd shims on Windows that Node has
    // refused to spawn without a shell since the CVE-2024-27980 fix.
    shell: true,
    cwd: opts.cwd,
    env: opts.env,
    // The env is already complete and scrubbed; execa's default would re-merge
    // process.env over the top and hand back every manager var we just removed.
    extendEnv: false,
    reject: false,
    // Never inherit an open stdin: Vite/esbuild block on startup when stdin is
    // an open pipe that never EOFs (see the runner's note).
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: PREWARM_TIMEOUT_MS,
  });
  return { exitCode: r.exitCode, stderr: String(r.stderr ?? "") };
};

/**
 * A prewarm is a convenience, not a milestone — so it gets a hard ceiling rather
 * than being allowed to hold a worktree-creation notice open indefinitely. A
 * command that means to leave a server RUNNING should background it itself.
 */
export const PREWARM_TIMEOUT_MS = 120_000;

export class McpPrewarmService {
  constructor(
    private readonly deps: {
      /** Config-sourced servers, layered over the `.data` record by the caller. */
      getMcpServers: (projectId: string) => Record<string, McpServerConfig>;
      leases?: McpPortLeaseService;
      spawn?: PrewarmSpawn;
    },
  ) {}

  /**
   * Prewarm every server in `project` that declares a command. Resolves against
   * `worktreePath`, so each checkout warms its OWN port.
   */
  async prewarm(project: Project, worktreePath: string): Promise<PrewarmOutcome[]> {
    const configured = {
      ...(project.mcpServers ?? {}),
      ...this.deps.getMcpServers(project.id),
    };
    // Only pay for resolution (and a port lease) when something asked to warm.
    const wanted = Object.entries(configured).filter(([, c]) => c.prewarm);
    if (!wanted.length) return [];

    const resolved = await resolveMcpServers(
      Object.fromEntries(wanted),
      {
        projectId: project.id,
        cwd: worktreePath,
        repoRoot: project.repoPath,
        branch: basename(worktreePath),
      },
      this.deps.leases,
    );

    const spawn = this.deps.spawn ?? defaultSpawn;
    const env = scrubManagerEnv(process.env);
    const out: PrewarmOutcome[] = [];
    for (const [name, config] of wanted) {
      // The resolved entry carries the substituted env; `prewarm` itself is only
      // on the UNresolved config, since resolution strips Dispatch-only keys.
      const command = config.prewarm!;
      try {
        const r = await spawn(command, {
          cwd: worktreePath,
          env: { ...env, ...(resolved[name]?.env ?? {}) },
        });
        out.push(
          r.exitCode === 0
            ? { server: name, command, ok: true }
            : {
                server: name,
                command,
                ok: false,
                error: r.stderr.trim().slice(0, 400) || `exit ${r.exitCode}`,
              },
        );
      } catch (err) {
        out.push({
          server: name,
          command,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }
}
