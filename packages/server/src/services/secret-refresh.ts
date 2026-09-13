/**
 * What a secret change REFRESHES — the half of `secret_request` that makes a new
 * value actually used, rather than sitting in the store until someone restarts
 * the right thing by hand.
 *
 * A key is only ever read where it was expanded, and expansion happened at
 * three different moments: config load (MCP definitions), session start (the
 * servers a live chat is holding) and process launch (a sub-app's env). So a
 * change has to be pushed through all three, in that order — reload the config
 * first, or the chats and sub-apps would be refreshed onto the OLD expansion.
 *
 * Only consumers that reference the secret are touched. A global secret nobody
 * uses refreshes nothing; a project with twelve MCP servers reconnects one.
 */
import { EMPTY_REFRESH_REPORT, type SecretRefreshReport } from "@dispatch/shared";
import type { ProjectConfigService } from "./project-config.js";
import type { RunnerService } from "./runner.js";
import type { SecretKey } from "./secrets.js";

export interface SecretRefresherDeps {
  projectConfig: Pick<
    ProjectConfigService,
    "reload" | "secretConsumers" | "projectsReferencingSecret" | "getSubApps"
  >;
  broker: { refreshMcpServers(projectId: string, names: string[]): Promise<{ refreshed: string[]; nextSession: string[] }> };
  runner: Pick<RunnerService, "runningFor" | "restart">;
}

export class SecretRefresher {
  /**
   * The last report per secret. The card saves through `PUT /api/secrets`, which
   * refreshes and answers the CLIENT — the `secret_request` call waiting on that
   * card reads what happened from here.
   */
  private readonly last = new Map<string, SecretRefreshReport>();

  constructor(private readonly deps: SecretRefresherDeps) {}

  lastReport(key: SecretKey): SecretRefreshReport | undefined {
    return this.last.get(reportKey(key));
  }

  async refresh(changed: SecretKey[]): Promise<SecretRefreshReport> {
    const { projectConfig, broker, runner } = this.deps;
    const report: SecretRefreshReport = structuredClone(EMPTY_REFRESH_REPORT);

    // projectId → names that changed for it.
    const byProject = new Map<string, Set<string>>();
    for (const key of changed) {
      const projects =
        key.scope === "project"
          ? projectConfig.projectsReferencingSecret(key.name).filter((p) => p === key.projectId)
          : projectConfig.projectsReferencingSecret(key.name);
      for (const p of projects) {
        const names = byProject.get(p) ?? new Set<string>();
        names.add(key.name);
        byProject.set(p, names);
      }
    }

    for (const [projectId, names] of byProject) {
      await projectConfig.reload(projectId);
      report.projects.push(projectId);
      const consumers = new Set([...names].flatMap((n) => projectConfig.secretConsumers(projectId, n)));
      const mcp = [...consumers].filter((c) => c.startsWith("mcp:")).map((c) => c.slice(4));
      const subApps = [...consumers].filter((c) => c.startsWith("subapp:")).map((c) => c.slice(7));

      report.mcpServers.push(...mcp.map((m) => `${projectId}/${m}`));
      if (mcp.length) {
        const live = await broker.refreshMcpServers(projectId, mcp);
        report.chatsRefreshed.push(...live.refreshed);
        report.chatsOnNextSession.push(...live.nextSession);
      }

      const fresh = projectConfig.getSubApps(projectId);
      for (const id of subApps) {
        for (const instance of runner.runningFor(projectId, id)) {
          const restarted = await runner
            .restart(instance, fresh.find((s) => s.id === id))
            .catch((err) => {
              console.warn(
                `[Dispatch] could not restart sub-app ${id} after a secret change: ` +
                  (err instanceof Error ? err.message : String(err)),
              );
              return null;
            });
          if (restarted) report.subAppsRestarted.push(`${projectId}/${id}`);
        }
      }
    }
    for (const key of changed) this.last.set(reportKey(key), report);
    return report;
  }
}

function reportKey(k: SecretKey): string {
  return `${k.scope}|${k.scope === "project" ? (k.projectId ?? "") : ""}|${k.name}`;
}
