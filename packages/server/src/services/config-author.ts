/**
 * config-author — turn "I want an agent that audits our SQL migrations" into a
 * chat that actually writes `.dispatch/agents/sql-auditor.md`.
 *
 * The config formats here are small but exacting: frontmatter keys, a manifest
 * that must stay schema-valid, a skills layout with two legal shapes. Asking a
 * human to learn all of that before they can add one agent is the reason the
 * config view was read-only in practice. Asking an AGENT to do it only works if
 * it's told the rules — a bare "add an agent for X" prompt produces a file in
 * the wrong directory with invented frontmatter.
 *
 * So each section carries a BRIEFING: where the file goes, what shape it takes,
 * and the house rules for that kind. The briefing is composed here, server-side,
 * because this is where the real directory layout is known (the manifest can
 * override every dir name) — the client only sends the section and the sentence
 * the human typed.
 *
 * The result is an ordinary chat. It's tagged with a {@link ChatPurpose} so the
 * sidebar can show what it's off doing, but it has the project's normal tools,
 * modes and workflow profile: config authoring is a repo edit like any other,
 * and on a `review` project it correctly goes through a worktree and a PR.
 */
import { basename } from "node:path";
import {
  CONFIG_DIR_NAME,
  DEFAULT_AGENTS_DIR,
  DEFAULT_INSTRUCTIONS_DIR,
  DEFAULT_MODES_DIR,
  DEFAULT_SKILLS_DIR,
  MANIFEST_FILE,
  configPurposeKind,
  type AuthorableSection,
  type Chat,
  type ProjectConfig,
} from "@dispatch/shared";
import type { Services } from "./container.js";
import { createChat, ensureSession } from "../routes/dispatch.js";

/** Per-section metadata: the chat title, and the briefing the agent works from. */
interface SectionBrief {
  /** Human noun for titles/labels ("agent", "skill"). */
  noun: string;
  /** Where the artifact lives, given the project's resolved dirs. */
  location: (dirs: ConfigDirs) => string;
  /** The format + house rules. Rendered as markdown bullets. */
  rules: (dirs: ConfigDirs) => string[];
}

/** The config dir names actually in force for a project (manifest-overridable). */
interface ConfigDirs {
  configDir: string;
  instructions: string;
  agents: string;
  modes: string;
  skills: string;
  manifest: string;
}

function dirsFor(config: ProjectConfig | null): ConfigDirs {
  // Names, not absolute paths: the prompt reads better as repo-relative, and the
  // agent resolves them from the repo root it's already working in.
  const configDir = config?.sourceDir ? basename(config.sourceDir) : CONFIG_DIR_NAME;
  const rel = (abs: string | undefined, fallback: string) =>
    abs ? basename(abs) : fallback;
  return {
    configDir,
    instructions: rel(config?.instructionsDir, DEFAULT_INSTRUCTIONS_DIR),
    agents: rel(config?.agentsDir, DEFAULT_AGENTS_DIR),
    modes: rel(config?.modesDir, DEFAULT_MODES_DIR),
    skills: rel(config?.skillsDir, DEFAULT_SKILLS_DIR),
    manifest: MANIFEST_FILE,
  };
}

const BRIEFS: Record<AuthorableSection, SectionBrief> = {
  instructions: {
    noun: "instruction",
    location: (d) => `${d.configDir}/${d.instructions}/<name>.md`,
    rules: (d) => [
      `Write the prose to \`${d.configDir}/${d.instructions}/<name>.md\`, then register it ` +
        `in \`${d.configDir}/${d.manifest}\` under \`instructions:\` as ` +
        `\`- file: <name>.md\` (paths there are relative to the instructions dir). ` +
        `A file that isn't listed in the manifest is NOT loaded.`,
      `Instructions are appended to the system prompt of EVERY session in this project, ` +
        `on every turn. Keep it short and imperative; this is not documentation.`,
      `Say what the agent must do differently here. Don't restate general good practice, ` +
        `and don't duplicate what CLAUDE.md or the workflow profile already covers.`,
    ],
  },
  agents: {
    noun: "agent",
    location: (d) => `${d.configDir}/${d.agents}/<id>.md`,
    rules: (d) => [
      `One markdown file per agent at \`${d.configDir}/${d.agents}/<id>.md\`, with YAML ` +
        `frontmatter and the agent's system prompt as the body. Read a sibling file first ` +
        `if one exists and match it exactly.`,
      "Frontmatter keys: `name` (required), `description`, `permissionMode` " +
        "(`default` | `acceptEdits` | `bypassPermissions` | `plan`), `model`, " +
        "`allowedTools` / `disallowedTools` (lists of tool names).",
      "Scope the tool allowlist to what the job needs — a reviewer that can't write files " +
        "is a better reviewer. Prefer `plan` permission mode for anything read-only.",
      "The body IS the agent's prompt. Write it as instructions to that agent, in the " +
        "second person, not as a description of it.",
    ],
  },
  modes: {
    noun: "mode",
    location: (d) => `${d.configDir}/${d.modes}/<id>.yaml`,
    rules: (d) => [
      `One YAML file per mode at \`${d.configDir}/${d.modes}/<id>.yaml\`.`,
      "Keys: `name` (required), `description`, `permissionMode` (required: `default` | " +
        "`acceptEdits` | `bypassPermissions` | `plan`), optional `allowedTools` / " +
        "`disallowedTools`, and an optional `instructions` overlay.",
      "A mode is a POSTURE a human picks per chat (how much the agent may do without " +
        "asking) — not a job description. If you're writing a job, it's an agent instead.",
    ],
  },
  skills: {
    noun: "skill",
    location: (d) => `${d.configDir}/${d.skills}/<name>/SKILL.md`,
    rules: (d) => [
      `Either a directory \`${d.configDir}/${d.skills}/<name>/SKILL.md\` (plus any ` +
        `supporting files it references) or a single flat \`${d.configDir}/${d.skills}/<name>.md\`. ` +
        `Use a directory whenever the skill ships scripts, templates or reference docs.`,
      "Frontmatter needs `name` and `description`. The description is what makes the skill " +
        "FIRE — write it as trigger conditions (\"use when the user asks to …\"), not as a " +
        "summary, or the model will never load it.",
      "The body is the procedure: the steps, the gotchas, the commands that actually work " +
        "in this repo. Skills are materialized into each session's `.claude/skills/`.",
    ],
  },
  mcp: {
    noun: "MCP server",
    location: (d) => `${d.configDir}/${d.manifest}`,
    rules: () => [
      "**Use the `mcp__manager__mcp_add` tool** — do not hand-edit the manifest, and do not " +
        "write `.mcp.json`, `~/.claude.json` or `.claude/settings.json`; this harness reads " +
        "none of those.",
      "Load the `mcp-setup` skill before you start: it has the real procedure and the " +
        "defaults you'd otherwise guess wrong.",
      "Secrets go in as `${VAR}` placeholders, never literal keys — this file is committed.",
      "Verify the server actually connects before reporting done.",
    ],
  },
  subApps: {
    noun: "sub-app",
    location: (d) => `${d.configDir}/${d.manifest}`,
    rules: (d) => [
      `Add an entry under \`subApps:\` in \`${d.configDir}/${d.manifest}\`.`,
      "Keys: `id`, `name`, `cwd` (relative to the repo root), and the commands `install` / " +
        "`dev` / `build` / `test`. Optional: `ports`, `env` (with `{port}` / `{portN}` " +
        "placeholders substituted from the allocated ports), `url`, `docker` (a " +
        "docker-compose file).",
      "Read the actual package.json / compose file to get the commands right — a sub-app " +
        "whose `dev` command is a guess fails the first time someone launches it.",
      "Preserve the file's existing comments and key order.",
    ],
  },
};

/** The composed briefing for one section, as the chat's opening message. */
export function buildAuthorPrompt(input: {
  section: AuthorableSection;
  description: string;
  config: ProjectConfig | null;
  projectName: string;
}): string {
  const brief = BRIEFS[input.section];
  const dirs = dirsFor(input.config);
  const lines = [
    `Add a ${brief.noun} to this project's Dispatch config.`,
    "",
    "**What I want**",
    "",
    input.description.trim(),
    "",
    `**Where it goes** — \`${brief.location(dirs)}\``,
    "",
    "**How this config works**",
    "",
    ...brief.rules(dirs).map((r) => `- ${r}`),
    "",
    "**Before you write anything**",
    "",
    `- Look at what's already in \`${dirs.configDir}/\` and match its conventions — ` +
      "naming, tone, frontmatter style. Consistency with the existing config beats " +
      "your own preferences.",
    "- Ground it in THIS repo: read the code, scripts and docs the request touches so " +
      "the result is specific rather than generic boilerplate.",
    "- If the request is ambiguous in a way that changes the result, ask me before writing.",
    "",
    "When you're done, tell me what you created and what it changes about how agents " +
      "behave here.",
  ];
  return lines.join("\n");
}

/** A spawned authoring chat, returned to the client so it can focus it. */
export interface AuthorConfigResult {
  chat: Chat;
  /** The composed opening message (also sent to the chat). */
  prompt: string;
}

/**
 * Spawn a config-authoring chat: create it with a purpose tag, then send the
 * composed briefing as its first message. Returns the chat so the caller can
 * jump straight into it and watch the work happen.
 */
export async function authorConfig(
  services: Services,
  input: {
    projectId: string;
    section: AuthorableSection;
    description: string;
  },
): Promise<AuthorConfigResult | null> {
  const project = await services.store.getProject(input.projectId).catch(() => null);
  if (!project) return null;

  const config =
    services.projectConfig.get(input.projectId)?.config ??
    (await services.projectConfig.reload(input.projectId).catch(() => null))?.config ??
    null;

  const prompt = buildAuthorPrompt({
    section: input.section,
    description: input.description,
    config,
    projectName: project.name,
  });
  const noun = BRIEFS[input.section].noun;
  const chat = await createChat(services, {
    projectId: input.projectId,
    // The title carries the ASK, not the category — that's what makes the row
    // scannable a week later.
    title: `${noun}: ${summarize(input.description)}`,
    purpose: {
      kind: configPurposeKind(input.section),
      label: `Writing a ${noun} for this project's config`,
    },
  });

  await ensureSession(services, chat.id);
  await services.broker.sendMessage(chat.id, prompt);
  return { chat, prompt };
}

/** First clause of the request, bounded — the chat title, not the whole brief. */
function summarize(description: string, max = 48): string {
  const line = description.trim().split("\n").find((l) => l.trim())?.trim() ?? "config";
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
