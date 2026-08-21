import { describe, it, expect } from "vitest";
import {
  AGENT_TASK_IDS,
  AGENT_TASKS,
  composeMessageText,
  projectToManifest,
  renderManifestYaml,
  taskTitlePrefix,
  type AgentTaskId,
  type Chat,
  type GitStatus,
  type ProjectConfig,
} from "@dispatch/shared";
import { buildTaskParts, launchAgentTask } from "./agent-tasks.js";
import { shardMemories } from "./memory-shard.js";
import type { MemoryInventoryEntry } from "./memory.js";
import type { Services } from "./container.js";

/** A loaded config with the DEFAULT dir names. */
function config(over: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    sourceDir: "/repo/.dispatch",
    name: "Repo",
    instructions: [],
    subApps: [],
    mcpServers: {},
    mcpEnabled: {},
    agents: [],
    modes: [],
    skills: [],
    memoryDir: "/repo/.dispatch/memory",
    agentsDir: "/repo/.dispatch/agents",
    modesDir: "/repo/.dispatch/modes",
    skillsDir: "/repo/.dispatch/skills",
    instructionsDir: "/repo/.dispatch/instructions",
    ...over,
  };
}

function status(over: Partial<GitStatus> = {}): GitStatus {
  return {
    repoPath: "/repo",
    branch: "main",
    detached: false,
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [{ path: "src/a.ts", status: "modified", staged: false }],
    untracked: [],
    conflicted: [],
    ...over,
  };
}

const parts = (
  taskId: AgentTaskId,
  over: Partial<Parameters<typeof buildTaskParts>[0]> = {},
) =>
  buildTaskParts({
    taskId,
    instructions: "audit our SQL migrations before they ship",
    params: {},
    config: config(),
    status: null,
    repoPath: "/repo",
    ...over,
  });

/** The full prompt text a task sends (what the model actually reads). */
const prompt = (taskId: AgentTaskId, over: Partial<Parameters<typeof buildTaskParts>[0]> = {}) =>
  composeMessageText(parts(taskId, over));

const briefOf = (taskId: AgentTaskId, over = {}) =>
  parts(taskId, over).find((p) => p.kind === "brief")!.text;

describe("buildTaskParts — authorship", () => {
  it("keeps the human's words in their own part, not folded into the brief", () => {
    const out = parts("config:agents");
    const instructions = out.find((p) => p.kind === "instructions");
    expect(instructions?.text).toBe("audit our SQL migrations before they ship");
    // The whole point: the briefing must not claim the human's voice.
    expect(briefOf("config:agents")).not.toContain("audit our SQL migrations");
  });

  it("still sends the request verbatim to the model", () => {
    expect(prompt("config:agents")).toContain("audit our SQL migrations before they ship");
  });

  it("omits the instructions part when there are none", () => {
    const out = parts("git:commit-sweep", { instructions: "" });
    expect(out.some((p) => p.kind === "instructions")).toBe(false);
  });

  it("composes the prompt from the parts, in order", () => {
    const out = parts("config:skills");
    expect(composeMessageText(out).startsWith(out[0]!.text)).toBe(true);
  });
});

describe("buildTaskParts — config briefings", () => {
  it("tells the agent where the file goes, per task", () => {
    expect(prompt("config:agents")).toContain(".dispatch/agents/<id>.md");
    expect(prompt("config:skills")).toContain(".dispatch/skills/<name>/SKILL.md");
    expect(prompt("config:modes")).toContain(".dispatch/modes/<id>.yaml");
    expect(prompt("config:instructions")).toContain(".dispatch/instructions/<name>.md");
    expect(prompt("config:mcp")).toContain("project.yaml");
    expect(prompt("config:subApps")).toContain("project.yaml");
  });

  it("honours manifest dir overrides instead of hardcoding defaults", () => {
    // A repo that renamed its dirs must not be told to write to `agents/`.
    const custom = config({
      sourceDir: "/repo/.claude-manager",
      agentsDir: "/repo/.claude-manager/subagents",
    });
    const out = prompt("config:agents", { config: custom });
    expect(out).toContain(".claude-manager/subagents/<id>.md");
    expect(out).not.toContain(".dispatch/agents");
  });

  it("falls back to the default layout when nothing is loaded yet", () => {
    expect(prompt("config:agents", { config: null })).toContain(".dispatch/agents/<id>.md");
  });

  it("routes MCP work through the tool + skill rather than hand-editing", () => {
    // The recurring failure: an agent writes `.mcp.json`, which nothing reads.
    const out = prompt("config:mcp");
    expect(out).toContain("mcp__manager__mcp_add");
    expect(out).toContain("mcp-setup");
    expect(out).toMatch(/do not hand-edit/i);
    expect(out).toContain("${VAR}");
  });

  it("tells skill authors the description is a trigger, not a summary", () => {
    expect(prompt("config:skills")).toMatch(/trigger conditions/i);
  });

  it("reminds instruction authors to register the file in the manifest", () => {
    // A file that isn't listed under `instructions:` is silently never loaded.
    const out = prompt("config:instructions");
    expect(out).toContain("instructions:");
    expect(out).toMatch(/NOT loaded/);
  });

  it("gives every config task a non-trivial briefing", () => {
    for (const id of AGENT_TASK_IDS.filter((i) => i.startsWith("config:"))) {
      const out = prompt(id);
      expect(out.length, id).toBeGreaterThan(400);
      expect(out, id).toContain("**How this config works**");
      // Grounding beats boilerplate — every section says so.
      expect(out, id).toContain("match its conventions");
    }
  });
});

describe("buildTaskParts — commit sweep", () => {
  const sweep = (over: Partial<Parameters<typeof buildTaskParts>[0]> = {}) =>
    prompt("git:commit-sweep", { instructions: "", status: status(), ...over });

  it("names the repo and branch it is sweeping", () => {
    // A sweep usually runs in a worktree, not the checkout — saying which is the
    // difference between committing your work and committing someone else's.
    const out = sweep({ repoPath: "/repo/wt/feature", status: status({ branch: "feature" }) });
    expect(out).toContain("/repo/wt/feature");
    expect(out).toContain("feature");
  });

  it("bans the add-all shortcuts that defeat grouping", () => {
    const out = sweep();
    expect(out).toContain("git add -- <path>");
    expect(out).toMatch(/Do NOT use `git add -A`/);
    expect(out).toContain("git commit -a");
  });

  it("forbids history rewriting outright", () => {
    const out = sweep();
    for (const verb of ["amend", "reset", "rebase", "force-push"]) {
      expect(out, verb).toContain(verb);
    }
    expect(out).toMatch(/Never/);
  });

  it("respects an existing staged grouping as deliberate", () => {
    const withStaged = status({
      staged: [{ path: "src/b.ts", status: "modified", staged: true }],
    });
    expect(sweep({ status: withStaged })).toMatch(/ALREADY STAGED/);
    expect(sweep()).not.toMatch(/ALREADY STAGED/);
  });

  it("pushes only when asked, and says so either way", () => {
    expect(sweep({ params: { push: true } })).toMatch(/push the branch/);
    expect(sweep({ params: { push: false } })).toMatch(/do NOT push/i);
  });

  it("scopes untracked files out when the toggle is off", () => {
    expect(sweep({ params: { includeUntracked: false } })).toMatch(/Untracked files are OUT/);
    expect(sweep({ params: { includeUntracked: true } })).not.toMatch(/Untracked files are OUT/);
  });

  it("attaches the working tree as collapsed context, not as the brief", () => {
    const out = parts("git:commit-sweep", {
      instructions: "",
      status: status({
        untracked: [{ path: "notes.md", status: "untracked", staged: false }],
      }),
    });
    const ctx = out.find((p) => p.kind === "context");
    expect(ctx?.text).toContain("src/a.ts");
    expect(ctx?.text).toContain("notes.md");
    expect(ctx?.label).toContain("2 paths");
  });

  it("attaches no context for a clean tree", () => {
    const clean = status({ unstaged: [] });
    const out = parts("git:commit-sweep", { instructions: "", status: clean });
    expect(out.some((p) => p.kind === "context")).toBe(false);
  });

  it("bounds the inventory instead of pasting a thousand paths", () => {
    const many = status({
      unstaged: Array.from({ length: 200 }, (_, i) => ({
        path: `src/f${i}.ts`,
        status: "modified" as const,
        staged: false,
      })),
    });
    const ctx = parts("git:commit-sweep", { instructions: "", status: many }).find(
      (p) => p.kind === "context",
    );
    expect(ctx?.text).toContain("and 140 more");
    expect(ctx!.text.length).toBeLessThan(6_000);
  });
});

describe("buildTaskParts — project setup", () => {
  const project = {
    id: "p1",
    name: "Acme",
    repoPath: "/repo",
    worktreeRoot: ".worktrees",
    defaultBranch: "trunk",
    subApps: [],
    createdAt: 1,
  };
  const setup = (over: Partial<Parameters<typeof buildTaskParts>[0]> = {}) =>
    prompt("project:setup", { instructions: "", project, ...over });

  it("names the repo and the trunk the form chose", () => {
    const out = setup();
    expect(out).toContain("/repo");
    expect(out).toContain("trunk `trunk`");
  });

  it("treats an empty directory as a build, not an audit", () => {
    const out = setup({ fresh: true });
    expect(out).toMatch(/directory is empty/i);
    expect(out).toMatch(/Scaffold the project/);
    // The one thing it must not do quietly: pick the stack for you.
    expect(out).toMatch(/TELL me what you picked/);
  });

  it("treats an existing repo as an audit, and forbids the rewrite", () => {
    const out = setup({ fresh: false });
    expect(out).toMatch(/already has code/i);
    expect(out).toMatch(/Do NOT restructure/);
    expect(out).not.toMatch(/directory is empty/i);
  });

  it("tells it what makes the Runner work, in the manifest's own vocabulary", () => {
    const out = setup();
    for (const key of ["subApps:", "cwd", "install", "dev", "build", "test", "ports"]) {
      expect(out, key).toContain(key);
    }
  });

  it("leaves the human's workflow choice to the human", () => {
    expect(setup()).toMatch(/Leave `workflow:` alone/);
  });

  it("guards against a confidently invented config", () => {
    expect(setup()).toMatch(/An empty config beats a confident wrong one/);
  });

  it("only asks it to run things when the toggle is on", () => {
    expect(setup({ params: { runInstall: true } })).toMatch(/Verify before you claim done/);
    expect(setup({ params: { runInstall: false } })).toMatch(/Don't run anything/);
  });

  it("honours manifest dir overrides like the config tasks do", () => {
    const out = setup({
      config: config({ sourceDir: "/repo/.claude-manager" }),
    });
    expect(out).toContain(".claude-manager/project.yaml");
    expect(out).not.toContain(".dispatch/project.yaml");
  });

  it("attaches the saved manifest as context, so turn one is already grounded", () => {
    const synthesized = renderManifestYaml(projectToManifest(project));
    const out = parts("project:setup", {
      instructions: "",
      project,
      savedManifest: { text: synthesized, adopted: false },
    });
    const ctx = out.find((p) => p.kind === "context");
    expect(ctx?.label).toContain("project.yaml");
    expect(ctx?.label).toContain("as saved");
    expect(ctx?.text).toContain("name: Acme");
    expect(ctx?.text).toContain("worktreeRoot: .worktrees");
  });

  it("attaches an ADOPTED manifest verbatim, and says whose it is", () => {
    // The failure this guards: re-deriving the manifest from the stored record
    // drops `instructions:`, the dir overrides and every comment — and handing
    // the agent that, labelled "as saved", reads as permission to delete them.
    const authored = "# hand-authored\nname: Adopted\ninstructions:\n  - file: house.md\n";
    const out = parts("project:setup", {
      instructions: "",
      project,
      savedManifest: { text: authored, adopted: true },
    });
    const ctx = out.find((p) => p.kind === "context");
    expect(ctx?.text).toBe(authored);
    expect(ctx?.label).toContain("already in this repo");

    const brief = out.find((p) => p.kind === "brief")!.text;
    expect(brief).toMatch(/ALREADY CARRIES/);
    expect(brief).toMatch(/keep every key and comment/);
    expect(brief).not.toMatch(/exactly what I typed/);
  });

  it("says the manifest is its own when the form scaffolded it", () => {
    const brief = briefOf("project:setup", {
      project,
      savedManifest: { text: "name: Acme\n", adopted: false },
    });
    expect(brief).toMatch(/holds exactly what I typed and nothing more/);
    expect(brief).not.toMatch(/ALREADY CARRIES/);
  });

  it("keeps the human's brief in its own part", () => {
    const out = parts("project:setup", { instructions: "a Vite app and a Fastify api", project });
    expect(out.find((p) => p.kind === "instructions")?.text).toBe("a Vite app and a Fastify api");
    expect(briefOf("project:setup", { project })).not.toContain("Vite");
  });
});

/* ----------------------------------------------------------------- catalog */

describe("the catalog is complete enough to render a launcher", () => {
  it("gives every task an icon the client can resolve", () => {
    // The icon is a NAME (shared can't hold React); a missing one silently
    // degrades every surface that identifies the task to a generic sparkle.
    for (const id of AGENT_TASK_IDS) {
      expect(AGENT_TASKS[id].icon, id).toMatch(/^[A-Z][A-Za-z0-9]+$/);
    }
  });

  it("has a title prefix for every task, explicit or from the noun", () => {
    for (const id of AGENT_TASK_IDS) {
      expect(taskTitlePrefix(id), id).toBeTruthy();
    }
    expect(taskTitlePrefix("git:commit-sweep")).toBe("sweep");
    expect(taskTitlePrefix("config:mcp")).toBe("MCP server");
  });
});

/* ------------------------------------------------------ memory consolidation */

/** An inventory row with the shape the consolidation briefing reads. */
function row(
  name: string,
  over: Partial<MemoryInventoryEntry> = {},
): MemoryInventoryEntry {
  return {
    projectId: "p1",
    name,
    description: `what ${name} is about`,
    type: "project",
    body: `the body of ${name}`,
    file: `${name}.md`,
    chars: 20,
    surfaced: 0,
    recalled: 0,
    links: [],
    backlinks: [],
    ...over,
  };
}

/** A store big enough to shard, with one obvious duplicate pair inside it. */
function memoryStore(): MemoryInventoryEntry[] {
  const filler = Array.from({ length: 40 }, (_, i) =>
    row(`topic${i}-fact`, { description: `zeta${i} kappa${i} omicron${i} lambda${i}` }),
  );
  return [
    ...filler,
    row("pfsense-wan-flap", {
      description: "pfSense WAN speed duplex autoselect causes link flap",
    }),
    row("pfsense-wan-autoselect-flap", {
      description: "pfSense WAN autoselect duplex speed causes a link flap",
    }),
  ];
}

const memoryParts = (
  over: Partial<Parameters<typeof buildTaskParts>[0]> = {},
  memoryOver: Partial<NonNullable<Parameters<typeof buildTaskParts>[0]["memory"]>> = {},
) => {
  const rows = memoryOver.rows ?? memoryStore();
  return parts("memory:consolidate", {
    instructions: "",
    memory: {
      rows,
      shards: shardMemories(rows),
      ruleCount: 0,
      committed: true,
      ...memoryOver,
    },
    ...over,
  });
};

const memoryBrief = (
  over: Partial<Parameters<typeof buildTaskParts>[0]> = {},
  memoryOver: Partial<NonNullable<Parameters<typeof buildTaskParts>[0]["memory"]>> = {},
) => memoryParts(over, memoryOver).find((p) => p.kind === "brief")!.text;

describe("buildTaskParts — memory consolidation", () => {
  it("names every memory exactly once across the shards it hands out", () => {
    const rows = memoryStore();
    const brief = memoryBrief({}, { rows, shards: shardMemories(rows) });
    for (const m of rows) {
      // An agent that is never given a name never audits it, and nothing in the
      // run reports the omission — so coverage is asserted here, not assumed.
      expect(brief.split(m.name).length - 1, m.name).toBeGreaterThanOrEqual(1);
    }
  });

  it("flags the suspected duplicate pair and puts both in the same shard", () => {
    const brief = memoryBrief();
    expect(brief).toContain("likely the same fact");
    expect(brief).toMatch(/pfsense-wan-(autoselect-)?flap ≈ pfsense-wan-(autoselect-)?flap/);
  });

  it("tells the orchestrator to fan out read-only subagents and apply centrally", () => {
    const brief = memoryBrief();
    expect(brief).toContain("Spawn one subagent per shard");
    expect(brief).toMatch(/READ-ONLY/);
    expect(brief).toMatch(/must not call `remember` or `forget`/);
    expect(brief).toContain("cross-shard pass");
  });

  it("guards the failure that costs the most — deleting what's merely unused", () => {
    const brief = memoryBrief();
    expect(brief).toMatch(/"Never retrieved" means look harder, not delete/);
    expect(brief).toMatch(/backlinks before you delete or rename/);
  });

  it("switches to report-only when the human turned off apply", () => {
    const applied = memoryBrief({ params: { apply: true } });
    expect(applied).toContain("**Applying**");
    expect(applied).toMatch(/Write the survivor FIRST/);

    const dry = memoryBrief({ params: { apply: false } });
    expect(dry).toContain("**Report only**");
    expect(dry).toMatch(/Do not call `remember` or `forget`/);
    expect(dry).not.toContain("**Applying**");
  });

  it("drops the repo-verification instruction when verification is off", () => {
    expect(memoryBrief({ params: { verify: true } })).toMatch(/VERIFY each claim against the repo/);
    const off = memoryBrief({ params: { verify: false } });
    expect(off).toMatch(/Do NOT go verify claims against the repo/);
    expect(off).not.toMatch(/VERIFY each claim/);
  });

  it("says standing rules are out of scope when they were excluded", () => {
    const excluded = memoryBrief({ params: { includeRules: false } }, { ruleCount: 4 });
    expect(excluded).toMatch(/4 standing rules .* are OUT of scope/s);

    const included = memoryBrief({ params: { includeRules: true } }, { ruleCount: 4 });
    expect(included).toMatch(/Be conservative with the 4 standing rules/);
  });

  it("doesn't send the agent after git history a project can't have", () => {
    expect(memoryBrief({}, { committed: true })).toMatch(/`memory_history` \(git history/);
    const uncommitted = memoryBrief({}, { committed: false });
    expect(uncommitted).toMatch(/probably unavailable here/);
    expect(uncommitted).toMatch(/writes land on disk\s+only/);
  });

  it("attaches the pre-pass inventory as context, with each row's curation signals", () => {
    const rows = [
      row("stale-fact", { updatedAt: Date.UTC(2026, 0, 15), chars: 900 }),
      row("used-fact", { recalled: 3, surfaced: 7, links: ["stale-fact"] }),
    ];
    const context = memoryParts({}, { rows, shards: shardMemories(rows) }).find(
      (p) => p.kind === "context",
    );
    expect(context?.label).toContain("2 facts in scope");
    expect(context?.text).toContain("2026-01-15");
    expect(context?.text).toContain("never retrieved");
    expect(context?.text).toContain("3r/7s");
  });

  it("degrades to a coherent brief when the store is empty", () => {
    // A launch against an unreadable/empty store must still open a usable chat.
    const out = memoryParts({}, { rows: [], shards: [] });
    expect(out.some((p) => p.kind === "context")).toBe(false);
    const brief = out.find((p) => p.kind === "brief")!.text;
    expect(brief).toContain("0 recorded facts in scope");
    expect(brief).toContain("**Fan out — 0 shards**");
  });
});

/* ------------------------------------------------------------------ launch */

/** Minimal Services double: enough for createChat + ensureSession + send. */
function services(
  over: {
    status?: GitStatus | null;
    project?: Record<string, unknown>;
    memory?: MemoryInventoryEntry[];
  } = {},
) {
  const saved: Chat[] = [];
  const sent: { chatId: string; text: string; parts?: unknown }[] = [];
  const store = {
    getProject: async () => over.project ?? { id: "p1", repoPath: "/repo" },
    getSettings: async () => ({ theme: "dark" }),
    saveChat: async (c: Chat) => {
      saved.push(c);
      return c;
    },
    getChat: async () => saved[saved.length - 1] ?? null,
  };
  const svc = {
    store,
    bus: { publish: () => {} },
    projectConfig: { get: () => ({ config: config() }), reload: async () => null },
    git: { status: async () => over.status ?? null },
    memory: { inventory: async () => over.memory ?? [] },
    broker: {
      has: () => true,
      sendMessage: async (chatId: string, text: string, opts?: { parts?: unknown }) => {
        sent.push({ chatId, text, parts: opts?.parts });
      },
    },
  };
  return { svc: svc as unknown as Services, saved, sent };
}

describe("launchAgentTask", () => {
  it("titles the chat `**category**: the ask`", async () => {
    const { svc, saved } = services();
    const out = await launchAgentTask(svc, {
      projectId: "p1",
      taskId: "config:mcp",
      instructions: "connect our Linear workspace",
    });
    expect(out?.chat.title).toBe("**MCP server**: connect our Linear workspace");
    expect(saved[0]!.title).toBe(out!.chat.title);
  });

  it("falls back to the working tree when there are no instructions", async () => {
    const { svc } = services({ status: status({ branch: "feat/x" }) });
    const out = await launchAgentTask(svc, { projectId: "p1", taskId: "git:commit-sweep" });
    expect(out?.chat.title).toBe("**sweep**: 1 file on feat/x");
  });

  it("leaves a title as just its category when there's nothing concrete to add", async () => {
    const { svc } = services({ status: null });
    const out = await launchAgentTask(svc, { projectId: "p1", taskId: "git:commit-sweep" });
    expect(out?.chat.title).toBe("**sweep**");
  });

  it("pins the requested model, and leaves the chat unpinned without one", async () => {
    const { svc: a } = services();
    const pinned = await launchAgentTask(a, {
      projectId: "p1",
      taskId: "config:agents",
      instructions: "a reviewer",
      model: "opus",
    });
    expect(pinned?.chat.model).toBe("opus");

    const { svc: b } = services();
    const inherited = await launchAgentTask(b, {
      projectId: "p1",
      taskId: "config:agents",
      instructions: "a reviewer",
    });
    // Unpinned is NOT the same as pinning today's default — it keeps tracking
    // whatever the project recommends.
    expect(inherited?.chat.model).toBeUndefined();
  });

  it("launches at the requested effort, else the task's own default", async () => {
    const { svc: a } = services({ status: status() });
    const at = await launchAgentTask(a, {
      projectId: "p1",
      taskId: "git:commit-sweep",
      effort: "low",
    });
    expect(at?.chat.effort).toBe("low");

    const { svc: b } = services({ status: status() });
    const dflt = await launchAgentTask(b, { projectId: "p1", taskId: "git:commit-sweep" });
    expect(dflt?.chat.effort).toBe(AGENT_TASKS["git:commit-sweep"].defaultEffort);
  });

  it("titles a setup chat after the project when there's no brief to summarize", async () => {
    const { svc } = services({
      project: { id: "p1", name: "Acme", repoPath: "/repo", subApps: [], createdAt: 1 },
    });
    const out = await launchAgentTask(svc, { projectId: "p1", taskId: "project:setup" });
    expect(out?.chat.title).toBe("**setup**: Acme");
    expect(out?.chat.purpose?.label).toBe("Setting up Acme");
  });

  it("sends the composed prompt with its parts attached", async () => {
    const { svc, sent } = services();
    const out = await launchAgentTask(svc, {
      projectId: "p1",
      taskId: "config:skills",
      instructions: "how to cut a release",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe(out!.prompt);
    expect(sent[0]!.parts).toEqual(out!.parts);
    // The chat's purpose IS the task id — that's what the sidebar icon reads.
    expect(out!.chat.purpose?.kind).toBe("config:skills");
  });

  it("titles a consolidation by the scale of the store it's chewing on", async () => {
    const { svc } = services({ memory: memoryStore() });
    const out = await launchAgentTask(svc, { projectId: "p1", taskId: "memory:consolidate" });
    expect(out?.chat.title).toMatch(/^\*\*memory\*\*: 42 facts, \d+ shards$/);
    expect(out?.chat.purpose?.label).toMatch(/^Consolidating 42 durable facts across \d+ agents$/);
  });

  it("excludes standing rules from the shards when the toggle is off", async () => {
    const store = [
      ...memoryStore(),
      row("prefers-terse-replies", { type: "user" }),
      row("always-run-check-first", { type: "feedback" }),
    ];
    const { svc } = services({ memory: store });

    const scoped = await launchAgentTask(svc, {
      projectId: "p1",
      taskId: "memory:consolidate",
      params: { includeRules: false },
    });
    // Scoping happens BEFORE the briefing is composed, so an excluded rule is
    // never named at all — a much stronger guarantee than asking nicely.
    expect(scoped!.prompt).not.toContain("prefers-terse-replies");
    expect(scoped!.prompt).toContain("2 standing rules");

    const full = await launchAgentTask(svc, {
      projectId: "p1",
      taskId: "memory:consolidate",
      params: { includeRules: true },
    });
    expect(full!.prompt).toContain("prefers-terse-replies");
  });

  it("still opens a usable chat when the project has no memory at all", async () => {
    const { svc } = services({ memory: [] });
    const out = await launchAgentTask(svc, { projectId: "p1", taskId: "memory:consolidate" });
    expect(out?.chat.title).toBe("**memory**");
    expect(out?.chat.purpose?.label).toBe("Consolidating this project's durable memory");
  });
});

describe("buildTaskParts — pr:review", () => {
  const PR = {
    repo: "octo/repo",
    number: 97,
    url: "https://github.com/octo/repo/pull/97",
    title: "feat: a file explorer",
    branch: "feat/files",
    baseBranch: "main",
    author: "octocat",
    headRefOid: "abcdef1234",
    additions: 120,
    deletions: 8,
    changedFiles: 6,
    diff: { text: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n", truncated: false },
    openThreads: [],
    round: 1,
    maxRounds: 4,
    repoPath: "/repo",
  };

  it("attaches the diff as its own part — the reviewer should not have to fetch it", () => {
    const out = parts("pr:review", { params: {}, pr: PR });
    const diff = out.find((p) => p.label?.startsWith("Diff of PR"));
    expect(diff?.kind).toBe("context");
    expect(diff?.text).toContain("+++ b/src/a.ts");
  });

  it("names the PR, and where to read the files at its head", () => {
    const brief = briefOf("pr:review", { params: {}, pr: PR });
    expect(brief).toContain("#97");
    expect(brief).toContain("feat/files");
    expect(brief).toContain("git fetch origin pull/97/head");
    // The bar, not just the request — an under-briefed reviewer produces a page
    // of restated diff and three style nits.
    expect(brief).toContain("An empty review is a real outcome");
    expect(brief).toContain("post_review");
  });

  it("says to post nothing when the launch asked for a dry run", () => {
    const brief = briefOf("pr:review", { params: { post: false }, pr: PR });
    expect(brief).toContain("Post nothing");
    expect(brief).not.toContain("post_review");
  });

  it("drops the blocking verdict when the reviewer may not request changes", () => {
    const brief = briefOf("pr:review", { params: { blocking: false }, pr: PR });
    expect(brief).toContain("always `comment`");
    expect(brief).not.toContain("`request_changes` only for");
  });

  it("warns when the diff was truncated, rather than reviewing half a PR quietly", () => {
    const brief = briefOf("pr:review", {
      params: {},
      pr: { ...PR, diff: { text: "x", truncated: true } },
    });
    expect(brief).toContain("TRUNCATED");
    expect(brief).toContain("gh pr diff 97");
  });

  it("hands over what an earlier round already raised, and says not to repeat it", () => {
    const out = parts("pr:review", {
      params: { round: 2 },
      pr: {
        ...PR,
        round: 2,
        openThreads: [
          { id: "T1", isResolved: false, path: "src/a.ts", line: 4, author: "octocat", body: "unawaited" },
        ],
      },
    });
    const brief = out.find((p) => p.kind === "brief")!.text;
    expect(brief).toContain("round 2 of at most 4");
    expect(brief).toContain("Do NOT raise them again");
    expect(out.find((p) => p.label?.startsWith("Already raised"))?.text).toContain("src/a.ts:4");
  });

  it("refuses to invent a change when the PR could not be read", () => {
    const brief = briefOf("pr:review", { params: {}, pr: null });
    expect(brief).toContain("could not be read");
    expect(brief).toContain("do not guess");
  });
});
