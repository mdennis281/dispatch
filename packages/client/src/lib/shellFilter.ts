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

/** Resolve chat → project → app; the app's absent value is every category on. */
export function useShellFilter(chatId: string): ResolvedShellFilter {
  const chat = useChats((s) => s.byId[chatId]);
  const project = useProjects((s) =>
    chat?.projectId ? s.projects.find((candidate) => candidate.id === chat.projectId) : undefined,
  );
  const app = useSettings((s) => s.shellFilter);
  const projectFilter = project?.shellFilter;
  const chatFilter = chat?.shellFilter;
  return {
    enabled: chatFilter ?? projectFilter ?? app ?? [...SHELL_TRANSCRIPT_CATEGORIES],
    app: app ?? [...SHELL_TRANSCRIPT_CATEGORIES],
    project: projectFilter,
    chat: chatFilter,
    source: chatFilter ? "chat" : projectFilter ? "project" : "app",
    projectId: chat?.projectId,
  };
}

export function normalizedShellFilter(value: readonly ShellTranscriptCategory[]): ShellTranscriptFilter {
  const selected = new Set(value);
  return SHELL_TRANSCRIPT_CATEGORIES.filter((category) => selected.has(category));
}
