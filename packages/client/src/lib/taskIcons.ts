/**
 * Lucide icon NAME → component, for icons chosen by data rather than by code.
 *
 * The agent-task catalog lives in `@dispatch/shared`, which the server imports
 * and which therefore can't hold React components. So a task declares its icon
 * as a string (`icon: "Blocks"`) and this is where the string becomes something
 * renderable — the launcher header, the sidebar row for a chat that task
 * spawned, anywhere a task identifies itself.
 *
 * An explicit map rather than `import * as lucide`: the star import pulls the
 * whole icon set into the bundle, and a typo'd name should be a visible fallback
 * (a wand) rather than a crashed render. Adding a task with a new icon means
 * adding one line here — the one place where "what icons exist" is a build-time
 * fact.
 */
import {
  Blocks,
  Bot,
  Boxes,
  Brain,
  FileCog,
  FolderGit2,
  GitCommitVertical,
  GitPullRequest,
  MessagesSquare,
  ScanEye,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Wand2,
  type LucideIcon,
} from "lucide-react";

/** Every icon a catalog entry (or a persisted `purpose.kind`) may name. */
export const TASK_ICONS: Record<string, LucideIcon> = {
  Blocks,
  Bot,
  Boxes,
  Brain,
  FileCog,
  FolderGit2,
  GitCommitVertical,
  GitPullRequest,
  MessagesSquare,
  ScanEye,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Wand2,
};

/** The icon a name refers to, or `Sparkles` when this build doesn't have it. */
export function taskIcon(name: string | undefined): LucideIcon {
  return (name && TASK_ICONS[name]) || Sparkles;
}

/** The icon a name refers to, or null — for callers that render nothing instead. */
export function taskIconOrNull(name: string | undefined): LucideIcon | null {
  return (name && TASK_ICONS[name]) || null;
}
