/**
 * Project → manifest: the inverse of the `.dispatch/` loader's mapping.
 *
 * This lives in shared, not on the server, because two very different callers
 * need the SAME answer:
 *
 *   - the server writes `.dispatch/project.yaml` with it (scaffold + export), and
 *   - the client PREVIEWS that file live while you fill in the new-project form.
 *
 * A preview rendered by a second implementation is a preview that eventually
 * lies — off by a quoted key, a pruned field, a different header. So the render
 * is one function and both ends call it: what the form shows is byte-for-byte
 * what lands on disk.
 *
 * `yaml` is a dependency here for exactly that reason. It's the same emitter the
 * server already used, and it round-trips through the loader's `parseYaml`.
 */
import { stringify as stringifyYaml } from "yaml";
import { CONFIG_DIR_NAME } from "./project-config.js";
import type {
  ManifestMcpServer,
  ManifestMcpTransport,
  ManifestSubApp,
  ProjectManifest,
} from "./project-config.js";
import type { McpServerConfig } from "./common.js";
import type { Project } from "./domain.js";

/** Un-flatten a stored {@link McpServerConfig} back into a manifest transport. */
export function mcpConfigToTransport(cfg: McpServerConfig): ManifestMcpTransport {
  if (cfg.type === "stdio") {
    return {
      type: "stdio",
      command: cfg.command ?? "",
      ...(cfg.args ? { args: cfg.args } : {}),
      ...(cfg.env ? { env: cfg.env } : {}),
    };
  }
  return {
    type: cfg.type === "sse" ? "sse" : "http",
    url: cfg.url ?? "",
    ...(cfg.headers ? { headers: cfg.headers } : {}),
  };
}

/** Drop `undefined` values so the emitted YAML stays clean (no `key: null`). */
function pruneUndefined<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined) delete obj[k];
  }
  return obj;
}

/**
 * The minimal project shape a manifest can be derived from. A stored
 * {@link Project} satisfies it; so does the DRAFT the new-project form holds,
 * which has no id and no createdAt yet — and shouldn't have to invent them just
 * to render a preview.
 */
export type ManifestSource = Pick<Project, "name"> &
  Partial<Omit<Project, "name" | "subApps">> & { subApps?: Project["subApps"] };

/**
 * Derive a `.dispatch/` manifest from a project record. Identity/runtime fields
 * (id, repoPath, createdAt, defaultBranch) are intentionally omitted: they
 * belong to `.data`, not the committable authored config.
 */
export function projectToManifest(project: ManifestSource): ProjectManifest {
  const subApps: ManifestSubApp[] | undefined = project.subApps?.length
    ? project.subApps.map((s) =>
        pruneUndefined<ManifestSubApp>({
          id: s.id,
          name: s.name,
          cwd: s.path,
          install: s.install,
          dev: s.dev,
          build: s.build,
          test: s.test,
          ports: s.ports,
          url: s.url,
          docker: s.dockerCompose,
        }),
      )
    : undefined;

  const mcpEntries = Object.entries(project.mcpServers ?? {});
  const mcpServers: ManifestMcpServer[] | undefined = mcpEntries.length
    ? mcpEntries.map(([name, cfg]) => ({ name, transport: mcpConfigToTransport(cfg) }))
    : undefined;

  return pruneUndefined<ProjectManifest>({
    name: project.name,
    worktreeRoot: project.worktreeRoot || undefined,
    worktree: project.worktreeCmd,
    ship: project.shipCmd,
    // The workflow rung is the single most consequential thing in this file —
    // it decides what the agent is told, what the guard refuses, and whether
    // memory gets committed. Scaffolding without it used to silently drop the
    // choice, since an absent `workflow:` block re-infers the rung from `ship`.
    workflow: project.workflow,
    subApps,
    mcpServers,
  });
}

/** Render a manifest to `project.yaml` text with a self-describing header. */
export function renderManifestYaml(manifest: ProjectManifest): string {
  const header = [
    `# ${CONFIG_DIR_NAME}/ — self-contained, committable Dispatch config for this repo.`,
    "# Discovered + loaded by Dispatch as the SOURCE OF TRUTH for authored config;",
    "# .data keeps only runtime state (chats, sessions, checkpoints). Safe to commit.",
    "",
  ].join("\n");
  return header + stringifyYaml(manifest);
}
