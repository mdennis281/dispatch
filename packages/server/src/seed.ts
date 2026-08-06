/**
 * First-boot seed. Populates a fresh dataDir with the default modes/agents and
 * the Hivebreak project so the live app is immediately useful (and matches the
 * 2a mock shell). Idempotent + gated on an empty store, so it only runs once and
 * never clobbers a user's config. Called from the real entrypoint (index.ts) —
 * NOT from buildApp, so tests keep booting on a truly empty store.
 */
import type { Store } from "./store/index.js";
import type { Project, ModeConfig, AgentConfig } from "@dispatch/shared";

const DEFAULT_MODES: ModeConfig[] = [
  { id: "plan", name: "Plan", permissionMode: "plan", scope: "global" },
  { id: "auto", name: "Auto", permissionMode: "acceptEdits", scope: "global" },
  { id: "edit", name: "Edit", permissionMode: "default", scope: "global" },
];

function defaultAgents(now: number): AgentConfig[] {
  return [
    {
      id: "build",
      name: "Builder",
      instructions: "Principal engineer. Small, tested, conventional commits.",
      permissionMode: "default",
      effort: undefined,
      scope: "global",
      createdAt: now,
    },
    {
      id: "reviewer",
      name: "Reviewer",
      instructions: "Adversarial code reviewer. Roast, then suggest fixes.",
      permissionMode: "plan",
      allowedTools: ["Read", "Grep", "Glob", "Bash"],
      effort: undefined,
      scope: "global",
      createdAt: now,
    },
    {
      id: "sprite",
      name: "Sprite Artist",
      instructions: "Generate + iterate top-down sprites via the PIL pipeline.",
      permissionMode: "default",
      effort: undefined,
      scope: "project",
      projectId: "hivebreak",
      createdAt: now,
    },
  ];
}

function hivebreakProject(now: number): Project {
  return {
    id: "hivebreak",
    name: "Hivebreak",
    repoPath: "C:/Users/Michael/projects/zombie",
    worktreeRoot: "C:/Users/Michael/projects/zombie-worktrees",
    worktreeCmd: "pnpm worktree",
    shipCmd: "pnpm ship",
    defaultBranch: "main",
    createdAt: now,
    subApps: [
      {
        id: "game",
        name: "game",
        // Root dev orchestrator (scripts/dev.mjs) starts BOTH client + server and
        // scans each from its allocated base (passed as CLIENT_PORT/SERVER_PORT),
        // so parallel worktrees never collide. Not bare `apps/client` vite.
        path: ".",
        dev: "pnpm dev",
        build: "pnpm --filter @zombie/client build",
        ports: [5173, 2567],
        env: { CLIENT_PORT: "{port}", SERVER_PORT: "{port2}" },
        url: "http://localhost:{port}",
      },
      {
        // Pure docker stack: `dockerCompose` alone (no `dev`) → one compose up,
        // not the double-start the old `dev: docker compose up` caused.
        id: "metrics-server",
        name: "metrics-server",
        path: "services/metrics-server",
        dockerCompose: "docker-compose.yml",
        ports: [8080, 5432],
        url: "http://localhost:{port}",
      },
      {
        id: "studio-director",
        name: "studio-director",
        path: "tools/studio-director",
        dev: "node server.mjs",
        ports: [7777],
        url: "http://localhost:{port}",
      },
    ],
  };
}

/**
 * Seed the default config into an empty store. Returns true when it seeded,
 * false when the store already had projects or modes (no-op).
 */
export async function seedDefaultsIfEmpty(store: Store): Promise<boolean> {
  const [projects, modes] = await Promise.all([
    store.listProjects(),
    store.listModes(),
  ]);
  if (projects.length > 0 || modes.length > 0) return false;

  const now = Date.now();
  await Promise.all([
    ...DEFAULT_MODES.map((m) => store.saveMode(m)),
    ...defaultAgents(now).map((a) => store.saveAgent(a)),
    store.saveProject(hivebreakProject(now)),
  ]);
  return true;
}
