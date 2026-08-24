/**
 * First-boot seed. Populates a fresh dataDir with the default modes and agents.
 * Idempotent + gated on an empty store, so it only runs once and never clobbers
 * a user's config. Called from the real entrypoint (index.ts) — NOT from
 * buildApp, so tests keep booting on a truly empty store.
 *
 * It deliberately seeds NO PROJECT. It used to seed one ("Hivebreak") pointing
 * at `C:/Users/Michael/projects/zombie` — a path that exists on exactly one
 * machine — so every new install opened onto a project it could not read, whose
 * sub-apps could not start, and which the person who just installed Dispatch had
 * never heard of. A first project is something the setup wizard walks you
 * through creating against a directory you actually have (see routes/setup.ts
 * and the client's SetupWizard); it is not something to invent on your behalf.
 *
 * Modes and agents stay: they are generic, they name no path, and a chat needs
 * a mode to start in.
 */
import type { Store } from "./store/index.js";
import type { ModeConfig, AgentConfig } from "@dispatch/shared";

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
  ];
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
  ]);
  return true;
}
