/**
 * The config section registry — one entry per thing a `.dispatch/` can hold.
 *
 * This file exists because the old config view showed COUNTS. "Modes: 2" tells
 * you nothing about what a mode is, whether you want one, or why yours is
 * empty. Every section here carries a one-line `blurb` (what it is) and a longer
 * `explainer` (when you'd reach for it, and how it differs from its neighbours) —
 * the questions people actually have when they open this page.
 *
 * Sections are also the vocabulary of the authoring flow: `authorable` sections
 * accept a plain-English description and hand it to an agent, and their `id`
 * matches the shared `ConfigSection` the server briefs against. `purposeIcon`
 * maps a spawned chat's `purpose.kind` back to the same icon, so a chat that's
 * off writing skills is recognizable in the sidebar.
 */
import {
  Blocks,
  Bot,
  Boxes,
  Brain,
  FileCog,
  GitPullRequest,
  ScrollText,
  ShieldCheck,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import { configPurposeKind, type ConfigSection } from "@dispatch/shared";

export interface SectionDef {
  id: ConfigSection;
  icon: LucideIcon;
  label: string;
  /** One line, shown under the heading and in the rail tooltip. */
  blurb: string;
  /** The "should I want one of these?" paragraph, shown in the detail pane. */
  explainer: string;
  /** Placeholder for the describe-it box; null when the section isn't authorable. */
  authorPlaceholder: string | null;
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
    authorPlaceholder: null,
    noun: "workflow",
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
    authorPlaceholder:
      "e.g. always run `pnpm check` before claiming a task is done, and never edit files under packages/*/dist",
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
    authorPlaceholder:
      "e.g. a reviewer that audits our SQL migrations for missing indexes and unsafe defaults, read-only",
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
    authorPlaceholder:
      "e.g. how to cut a release: version bump, changelog, tag, and the two manual checks that always get missed",
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
    authorPlaceholder:
      "e.g. a read-only investigation mode: no writes, no shell, and tell the agent to report findings instead of fixing",
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
    authorPlaceholder:
      "e.g. connect our Linear workspace so agents can read and comment on issues",
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
    authorPlaceholder:
      "e.g. the web app in apps/web — pnpm dev on port 5173, needs API_URL pointing at the api sub-app",
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
    authorPlaceholder: null,
    noun: "memory",
  },
];

export const SECTION_BY_ID = new Map(SECTIONS.map((s) => [s.id, s]));

/**
 * The icon for a spawned chat's `purpose.kind`, or null when the kind is one this
 * build doesn't know. Unknown kinds fall back to the normal status dot rather
 * than rendering a placeholder — a future spawner can ship before its icon does.
 */
export function purposeIcon(kind: string | undefined): LucideIcon | null {
  if (!kind) return null;
  for (const s of SECTIONS) {
    if (configPurposeKind(s.id) === kind) return s.icon;
  }
  return kind.startsWith("config:") ? FileCog : null;
}
