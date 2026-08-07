/**
 * Agent tasks — the one shape for "describe what you want, an agent does it".
 *
 * This started as the config-authoring box (a textarea + "Have Claude do it")
 * and got copied the moment a second feature wanted the same affordance. The
 * copy is the problem: each one grew its own endpoint, its own prompt
 * composition, its own idea of whether effort was even selectable, and its own
 * chat title convention — so the second one shipped WITHOUT an effort selector
 * and nobody noticed until a sweep ran at `medium` on a 40-file diff.
 *
 * So a task is data, not code:
 *
 *   - This catalog holds everything the UI needs to render the launcher
 *     (label, noun, blurb, placeholder, default effort, which extra toggles
 *     apply). One component reads it; adding a task is adding an entry.
 *   - The server holds the BRIEFING per task — the format rules, the house
 *     rules, the paths — because that's where the real layout is known. See
 *     `services/agent-tasks.ts`.
 *
 * The `id` doubles as the spawned chat's {@link ChatPurpose} `kind`, so the
 * sidebar can already recognize these chats and no mapping table has to stay in
 * sync. Ids are `<feature>:<thing>` and are PERSISTED on chats — renaming one
 * orphans the icon on old chats, so don't.
 */
import * as z from "zod";
import { EffortSchema, type Effort } from "./common.js";

/* -------------------------------------------------------------------- ids */

export const AGENT_TASK_IDS = [
  "config:instructions",
  "config:agents",
  "config:modes",
  "config:skills",
  "config:mcp",
  "config:subApps",
  "git:commit-sweep",
] as const;

export const AgentTaskIdSchema = z.enum(AGENT_TASK_IDS);
export type AgentTaskId = (typeof AGENT_TASK_IDS)[number];

/** Narrowing guard for a value that came off the wire or out of a chat record. */
export function isAgentTaskId(value: unknown): value is AgentTaskId {
  return typeof value === "string" && (AGENT_TASK_IDS as readonly string[]).includes(value);
}

/* ----------------------------------------------------------------- toggles */

/**
 * Extra booleans a task's launcher offers, beyond effort + instructions.
 *
 * Declared here rather than hardcoded in the launcher so a task's form is
 * fully described by its catalog entry. Each id is a key the server reads out
 * of `params`.
 */
export const AgentTaskToggleSchema = z.object({
  id: z.string(),
  label: z.string(),
  hint: z.string().optional(),
  default: z.boolean(),
});
export type AgentTaskToggle = z.infer<typeof AgentTaskToggleSchema>;

/* ----------------------------------------------------------------- catalog */

export interface AgentTaskMeta {
  id: AgentTaskId;
  /** Imperative button/heading text — "Add an agent", "Sweep into commits". */
  action: string;
  /** Human noun for empty states and titles ("agent", "commit sweep"). */
  noun: string;
  /**
   * Lucide icon NAME, resolved to a component by the client (see
   * `lib/taskIcons`). A name rather than the component itself because this
   * package is imported by the server and must stay free of React; an unknown
   * name degrades to a default icon rather than crashing a render.
   */
  icon: string;
  /**
   * The emphasized category at the head of the spawned chat's title —
   * `**MCP server**: testing creating an mcp chat`. Defaults to `noun` when
   * unset. Kept separate from `noun` because a title wants the shortest thing
   * that still identifies the job, which isn't always the sentence noun.
   */
  titlePrefix?: string;
  /**
   * Model this task launches on unless the human changes it. Unset (the usual
   * case) means "inherit" — the chat is born with no pinned model and tracks
   * the project/runtime default, which is what you want for work that isn't
   * unusually hard or unusually cheap.
   */
  defaultModel?: string;
  /** One line: what launching this actually does. */
  blurb: string;
  /** Placeholder for the custom-instructions box. Phrase it as an example. */
  placeholder: string;
  /**
   * Effort this task is launched at unless the human changes it. Reasoning
   * effort is the single biggest quality lever on these one-shot jobs, so the
   * defaults are per-task rather than a global `medium`: grouping a large diff
   * into coherent commits is genuinely harder than writing one config file.
   */
  defaultEffort: Effort;
  /** Extra per-task booleans, surfaced as checkboxes under the textarea. */
  toggles?: AgentTaskToggle[];
  /** True when instructions are required rather than optional refinement. */
  instructionsRequired?: boolean;
}

export const AGENT_TASKS: Record<AgentTaskId, AgentTaskMeta> = {
  "config:instructions": {
    id: "config:instructions",
    action: "Add an instruction",
    noun: "instruction",
    icon: "ScrollText",
    blurb: "Writes a house-rules file and registers it in the manifest.",
    placeholder:
      "e.g. always run `pnpm check` before claiming a task is done, and never edit files under packages/*/dist",
    defaultEffort: "medium",
    instructionsRequired: true,
  },
  "config:agents": {
    id: "config:agents",
    action: "Add an agent",
    noun: "agent",
    icon: "Bot",
    blurb: "Writes an agent definition — prompt, tools, permission mode.",
    placeholder:
      "e.g. a reviewer that audits our SQL migrations for missing indexes and unsafe defaults, read-only",
    defaultEffort: "medium",
    instructionsRequired: true,
  },
  "config:modes": {
    id: "config:modes",
    action: "Add a mode",
    noun: "mode",
    icon: "ShieldCheck",
    blurb: "Writes a permission posture you can pick per chat.",
    placeholder:
      "e.g. a read-only investigation mode: no writes, no shell, and tell the agent to report findings instead of fixing",
    defaultEffort: "medium",
    instructionsRequired: true,
  },
  "config:skills": {
    id: "config:skills",
    action: "Add a skill",
    noun: "skill",
    icon: "Wand2",
    blurb: "Writes a procedure the model loads on demand, when it applies.",
    placeholder:
      "e.g. how to cut a release: version bump, changelog, tag, and the two manual checks that always get missed",
    defaultEffort: "medium",
    instructionsRequired: true,
  },
  "config:mcp": {
    id: "config:mcp",
    action: "Add an MCP server",
    noun: "MCP server",
    icon: "Blocks",
    blurb: "Wires up an external tool server and verifies it connects.",
    placeholder: "e.g. connect our Linear workspace so agents can read and comment on issues",
    defaultEffort: "medium",
    instructionsRequired: true,
  },
  "config:subApps": {
    id: "config:subApps",
    action: "Add a sub-app",
    noun: "sub-app",
    icon: "Boxes",
    blurb: "Declares a runnable app in this repo, with its commands and ports.",
    placeholder:
      "e.g. the web app in apps/web — pnpm dev on port 5173, needs API_URL pointing at the api sub-app",
    defaultEffort: "medium",
    instructionsRequired: true,
  },
  "git:commit-sweep": {
    id: "git:commit-sweep",
    action: "Sweep into commits",
    noun: "commit sweep",
    icon: "GitCommitVertical",
    // "commit sweep: 12 files on main" reads as a title; the prefix wants the
    // shorter half of that, because the interesting part is what came after it.
    titlePrefix: "sweep",
    blurb:
      "Reads the whole working tree, groups it by feature, and lands one commit per group.",
    placeholder:
      "optional — e.g. keep the favicon and icon changes in one commit, and don't commit anything under docs/",
    // A sweep decides what belongs together across an entire dirty tree, and a
    // wrong grouping is work to unpick. It gets the deeper default.
    defaultEffort: "high",
    toggles: [
      {
        id: "push",
        label: "Push when done",
        hint: "pushes the branch after the last commit",
        default: false,
      },
      {
        id: "includeUntracked",
        label: "Include untracked files",
        hint: "off = only files git already tracks",
        default: true,
      },
    ],
  },
};

/** Catalog entries in a stable display order. */
export const AGENT_TASK_LIST: AgentTaskMeta[] = AGENT_TASK_IDS.map((id) => AGENT_TASKS[id]);

/** The emphasized category for a task's chat title (`titlePrefix`, else `noun`). */
export function taskTitlePrefix(taskId: AgentTaskId): string {
  const meta = AGENT_TASKS[taskId];
  return meta.titlePrefix ?? meta.noun;
}

/**
 * The task that writes a given config section, or undefined for the sections
 * that have no authoring flow (`workflow` has its own editor; `memory` is
 * written by agents through the memory tools). This IS the old
 * `AUTHORABLE_SECTIONS` membership test — a section is authorable iff a task
 * exists for it.
 */
export function configTaskId(section: string): AgentTaskId | undefined {
  const id = `config:${section}`;
  return isAgentTaskId(id) ? id : undefined;
}

/* ------------------------------------------------------------------ launch */

/** What the client sends to launch a task. `params` is per-task (see toggles). */
export const LaunchAgentTaskInputSchema = z.object({
  taskId: AgentTaskIdSchema,
  /** The human's own words. Optional for tasks that can run with no steer. */
  instructions: z.string().optional(),
  /** Overrides the task's `defaultEffort`. */
  effort: EffortSchema.optional(),
  /**
   * Model to pin on the spawned chat. Omitted means "inherit" — the chat is
   * born unpinned and follows the project/runtime default, which is a different
   * outcome from pinning today's default and freezing it.
   */
  model: z.string().optional(),
  /** Task-specific extras: toggle values, a target repo path, etc. */
  params: z.record(z.string(), z.unknown()).optional(),
});
export type LaunchAgentTaskInput = z.infer<typeof LaunchAgentTaskInputSchema>;
