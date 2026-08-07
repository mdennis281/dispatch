import { describe, it, expect } from "vitest";
import {
  AGENT_TASK_IDS,
  AGENT_TASKS,
  composeMessageText,
  taskTitlePrefix,
  type AgentTaskId,
  type Chat,
  type GitStatus,
  type ProjectConfig,
} from "@dispatch/shared";
import { buildTaskParts, launchAgentTask } from "./agent-tasks.js";
import type { Services } from "./container.js";

/** A loaded config with the DEFAULT dir names. */
function config(over: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    sourceDir: "/repo/.dispatch",
    name: "Repo",
    instructions: [],
    subApps: [],
    mcpServers: {},
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

/* ------------------------------------------------------------------ launch */

/** Minimal Services double: enough for createChat + ensureSession + send. */
function services(over: { status?: GitStatus | null } = {}) {
  const saved: Chat[] = [];
  const sent: { chatId: string; text: string; parts?: unknown }[] = [];
  const store = {
    getProject: async () => ({ id: "p1", repoPath: "/repo" }),
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
});
