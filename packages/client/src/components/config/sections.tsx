/**
 * The config section registry — one entry per thing a `.dispatch/` can hold.
 *
 * This file exists because the old config view showed COUNTS. "Modes: 2" tells
 * you nothing about what a mode is, whether you want one, or why yours is
 * empty. Every section here carries a one-line `blurb` (what it is) and a longer
 * `explainer` (when you'd reach for it, and how it differs from its neighbours) —
 * the questions people actually have when they open this page.
 *
 * A section that an agent can WRITE is one with an agent task behind it
 * (`configTaskId(section.id)`), and the launcher's copy — placeholder, default
 * effort, button verb — comes from that task's catalog entry rather than being
 * duplicated here. `purposeIcon` maps a spawned chat's `purpose.kind` (which IS
 * the task id) back to an icon, so a chat that's off writing skills is
 * recognizable in the sidebar.
 */
import {
  Blocks,
  Bot,
  Boxes,
  Brain,
  FileCog,
  GitPullRequest,
  ScanEye,
  ScrollText,
  ShieldCheck,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import { configTaskId, isAgentTaskId, AGENT_TASKS, type ConfigSection } from "@dispatch/shared";
import { taskIconOrNull } from "../../lib/taskIcons.js";

export interface SectionDef {
  id: ConfigSection;
  icon: LucideIcon;
  label: string;
  /** One line, shown under the heading and in the rail tooltip. */
  blurb: string;
  /** The "should I want one of these?" paragraph, shown in the detail pane. */
  explainer: string;
  /** Noun for empty states and buttons ("agent", "skill"). */
  noun: string;
  /**
   * True when this section's items live INSIDE `project.yaml` rather than in
   * files of their own. It decides whether "add one by hand" has an honest
   * target: for these, opening the manifest is exactly right; for file-backed
   * sections it would drop you in the wrong file, so the option isn't offered.
   */
  manifestBacked?: boolean;
  /** False for sections whose contents aren't a countable list (workflow). */
  countable?: boolean;
}

export const SECTIONS: SectionDef[] = [
  {
    id: "workflow",
    icon: GitPullRequest,
    label: "Workflow",
    blurb: "How change ships in this repo",
    explainer:
      "The one setting here that changes what agents DO. It decides whether work lands as " +
      "loose edits, as commits on the trunk, or as a reviewed PR from its own worktree — and " +
      "it's enforced, not just suggested: the same profile drives the injected rules and the " +
      "guard that refuses a push to the trunk.",
    noun: "workflow",
    countable: false,
  },
  {
    id: "reviewer",
    icon: ScanEye,
    label: "Reviewer",
    blurb: "Who reviews the PRs agents open here",
    explainer:
      "The review loop only turns because something reviews. When the configured reviewer " +
      "stops answering — a quota runs out, a bot is uninstalled, a repo never had one — every " +
      "chat stalls in the same place, waiting for a review that will never arrive. This is " +
      "where you point that job at a Dispatch agent instead, and decide whose name the review " +
      "goes out under: yours, or a machine account with its own.",
    noun: "reviewer",
    manifestBacked: true,
    countable: false,
  },
  {
    id: "instructions",
    icon: ScrollText,
    label: "Instructions",
    blurb: "House rules appended to every session",
    explainer:
      "Prose that rides on every turn of every chat in this project. Use it for the things " +
      "an agent keeps getting wrong here — the test command that isn't the obvious one, the " +
      "directory that's generated, the convention a newcomer would violate. Keep it short: " +
      "it competes for attention with everything else in the window, and a long one gets skimmed.",
    noun: "instruction",
  },
  {
    id: "agents",
    icon: Bot,
    label: "Agents",
    blurb: "Named sub-agents with their own prompt and tools",
    explainer:
      "A job description plus a tool allowlist. Chats spawn them for scoped work — a reviewer " +
      "that can only read, a migrator that only touches one directory. An agent is a WHO " +
      "(this is your task, these are your tools); a mode is a how-much-freedom. If you're " +
      "describing work, you want an agent.",
    noun: "agent",
  },
  {
    id: "skills",
    icon: Wand2,
    label: "Skills",
    blurb: "Procedures loaded on demand, when they're relevant",
    explainer:
      "A skill is a procedure the model pulls in only when it applies — the deploy steps, the " +
      "release checklist, how to regenerate the API client. Unlike instructions (always " +
      "loaded, so they must stay short) a skill can be long, because it costs nothing until " +
      "it fires. Its description is the trigger, so write it as \"use when…\".",
    noun: "skill",
  },
  {
    id: "modes",
    icon: ShieldCheck,
    label: "Modes",
    blurb: "Permission postures you pick per chat",
    explainer:
      "How much the agent may do without asking — ask every time, accept edits, or full " +
      "bypass — optionally with an instruction overlay. You choose one when you start a chat. " +
      "Most projects never need a custom mode; reach for one when a recurring KIND of session " +
      "wants a different leash than the default.",
    noun: "mode",
  },
  {
    id: "mcp",
    icon: Blocks,
    label: "MCP servers",
    blurb: "External tools every session in this project gets",
    explainer:
      "Model Context Protocol servers hand agents tools this app doesn't ship — your issue " +
      "tracker, a database, a browser. Declared here, they're passed to every session in the " +
      "project and committed with the repo, so a teammate gets the same tools without any " +
      "setup. Secrets belong in as ${VAR} placeholders, never literals.",
    noun: "MCP server",
    manifestBacked: true,
  },
  {
    id: "subApps",
    icon: Boxes,
    label: "Sub-apps",
    blurb: "Runnable apps in this repo, with ports",
    explainer:
      "The things in this repo you can actually launch. Declaring one lets an agent start it " +
      "on a worktree branch and hand you a live localhost URL — so a change gets SEEN " +
      "running, not just described. Ports are allocated per worktree, so several branches can " +
      "run side by side.",
    noun: "sub-app",
    manifestBacked: true,
  },
  {
    id: "memory",
    icon: Brain,
    label: "Memory",
    blurb: "Durable facts carried between chats",
    explainer:
      "What agents have learned about this project and recorded for the next session — the " +
      "kind of fact you'd otherwise re-explain every chat. Agents write it themselves through " +
      "the remember/recall tools as they work; it's project-scoped, lives in the primary " +
      "checkout, and (on the commit and review profiles) gets committed for you.",
    noun: "memory",
  },
];

export const SECTION_BY_ID = new Map(SECTIONS.map((s) => [s.id, s]));

/**
 * The icon for a spawned chat's `purpose.kind` — which is the agent-task id that
 * spawned it — or null when the kind is one this build doesn't know. Unknown
 * kinds fall back to the normal status dot rather than rendering a placeholder,
 * so a future spawner can ship before its icon does.
 *
 * The catalog entry is the source of truth (a task declares its own icon by
 * name), which is what keeps the launcher's header icon and this row icon the
 * same picture. The SECTIONS lookup below is the fallback for a kind that no
 * longer has a catalog entry — a purpose persisted by an older build.
 */
export function purposeIcon(kind: string | undefined): LucideIcon | null {
  if (!kind) return null;
  if (isAgentTaskId(kind)) {
    const fromCatalog = taskIconOrNull(AGENT_TASKS[kind].icon);
    if (fromCatalog) return fromCatalog;
  }
  for (const s of SECTIONS) {
    if (configTaskId(s.id) === kind) return s.icon;
  }
  return kind.startsWith("config:") ? FileCog : null;
}
