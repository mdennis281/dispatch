/**
 * First-boot seed. Populates a fresh dataDir with the default modes/agents and
 * the Hivebreak project so the live app is immediately useful (and matches the
 * 2a mock shell). Idempotent + gated on an empty store, so it only runs once and
 * never clobbers a user's config. Called from the real entrypoint (index.ts) —
 * NOT from buildApp, so tests keep booting on a truly empty store.
 */
import type { Store } from "./store/index.js";
import type { Project, ModeConfig, AgentConfig } from "@cm/shared";

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
      scope: "global",
      createdAt: now,
    },
    {
      id: "reviewer",
      name: "Reviewer",
      instructions: "Adversarial code reviewer. Roast, then suggest fixes.",
      permissionMode: "plan",
      allowedTools: ["Read", "Grep", "Glob", "Bash"],
      scope: "global",
      createdAt: now,
    },
    {
      id: "sprite",
      name: "Sprite Artist",
      instructions: "Generate + iterate top-down sprites via the PIL pipeline.",
      permissionMode: "default",
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
        path: "apps/client",
        dev: "pnpm dev",
        build: "pnpm build",
        ports: [5173],
        url: "http://localhost:{port}",
      },
      {
        id: "metrics-server",
        name: "metrics-server",
        path: "services/metrics-server",
        dev: "docker compose up",
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
