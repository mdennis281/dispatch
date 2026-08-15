import {
  SHELL_TRANSCRIPT_CATEGORIES,
  type ShellTranscriptCategory,
  type ShellTranscriptFilter,
} from "@dispatch/shared";
import { useChats } from "../stores/chats.js";
import { useProjects } from "../stores/projects.js";
import { useSettings } from "../stores/settings.js";
import type { ToolPresentation } from "./toolPresentations.js";

export const SHELL_FILTER_OPTIONS: ReadonlyArray<{
  id: ShellTranscriptCategory;
  label: string;
  description: string;
}> = [
  { id: "shell", label: "Shell commands", description: "Bash, PowerShell, and managed terminals" },
  { id: "memory", label: "Memory", description: "Recall, remember, forget, and memory search" },
  { id: "pr", label: "Pull requests", description: "Review, watch, resolve, approve, and merge" },
  { id: "wait", label: "Waits", description: "Sleep countdowns and chat waits" },
  { id: "preview", label: "App previews", description: "Starting and inspecting project apps" },
  { id: "chat", label: "Chat context", description: "Context usage, compaction, and chat operations" },
  { id: "dispatch", label: "Other Dispatch tools", description: "Worktrees and newly added manager tools" },
];

export function presentationFilterCategory(presentation: ToolPresentation): ShellTranscriptCategory {
  if (presentation.kind === "shell") return "shell";
  switch (presentation.category) {
    case "memory": return "memory";
    case "pr": return "pr";
    case "wait": return "wait";
    case "preview": return "preview";
    case "chat": return "chat";
    case "terminal": return "shell";
    default: return "dispatch";
  }
}

export interface ResolvedShellFilter {
  enabled: ShellTranscriptFilter;
  app: ShellTranscriptFilter;
  project?: ShellTranscriptFilter;
  chat?: ShellTranscriptFilter;
  source: "chat" | "project" | "app";
  projectId?: string;
}

/**
 * Every category, as ONE array. Rebuilding `[...CATEGORIES]` per render would
 * hand a fresh identity to the `useMemo` in every `ShellRunGroup`, so the default
 * (nobody has filtered anything) would be the one case that never memoizes.
 *
 * Frozen because that shared identity is the whole point: this instance is handed
 * out to every caller, so an in-place `sort`/`push` by any one of them would
 * silently change the default filter for every chat in the app.
 */
const ALL_CATEGORIES = Object.freeze([...SHELL_TRANSCRIPT_CATEGORIES]) as ShellTranscriptFilter;

/** Resolve chat → project → app; the app's absent value is every category on. */
export function useShellFilter(chatId: string): ResolvedShellFilter {
  // Select the two FIELDS, not the chat. A `ShellRunGroup` calls this per group,
  // so subscribing to the whole chat object re-rendered every shell group in the
  // transcript on every token/activity tick of a running chat — and each of those
  // re-runs Prism over its commands. These two fields change when someone edits a
  // filter, which is approximately never.
  const chatFilter = useChats((s) => s.byId[chatId]?.shellFilter);
  const projectId = useChats((s) => s.byId[chatId]?.projectId);
  const project = useProjects((s) =>
    projectId ? s.projects.find((candidate) => candidate.id === projectId) : undefined,
  );
  const app = useSettings((s) => s.shellFilter);
  const projectFilter = project?.shellFilter;
  return {
    enabled: chatFilter ?? projectFilter ?? app ?? ALL_CATEGORIES,
    app: app ?? ALL_CATEGORIES,
    project: projectFilter,
    chat: chatFilter,
    source: chatFilter ? "chat" : projectFilter ? "project" : "app",
    projectId,
  };
}

export function normalizedShellFilter(value: readonly ShellTranscriptCategory[]): ShellTranscriptFilter {
  const selected = new Set(value);
  return SHELL_TRANSCRIPT_CATEGORIES.filter((category) => selected.has(category));
}
