/**
 * Tools that run WITHOUT a permission prompt — resolved across two layers.
 *
 * Why this exists: a global chat sweeping ~100 chats for loose ends raised 108
 * permission cards in seven minutes, every one of them a read (`chat_state`,
 * `chat_find`, `Read`). Under the SDK's `default` permission mode every MCP
 * tool asks — the SDK cannot know Dispatch's `chat_state` is read-only — and
 * the card's "Always allow" was never wired to anything, so clicking it a
 * hundred times changed nothing.
 *
 *   - APP  — `AppSettings.autoAllowTools`, in `config/`, never committed. Every
 *            chat, every project, every mode. Unset means
 *            {@link DEFAULT_AUTO_ALLOW_TOOLS}; "Always allow" appends here.
 *   - MODE — `autoAllowTools` on a mode, whether a store mode or a project's
 *            `.dispatch/modes/*.yaml`. ADDED to the app layer while the mode is
 *            selected, never a replacement — so a project's custom mode inherits
 *            everything the app allows instead of resetting it to nothing.
 *
 * A UNION and not an override, deliberately: the failure being fixed is "too
 * many prompts", and a mode that could silently drop the app list would bring
 * every one of them back the moment someone authored a mode for an unrelated
 * reason.
 *
 * This only ever skips a PROMPT. It is not a permission in the sense the mode
 * tool policy is: a mode's `disallowedTools` (and its `allowedTools`
 * restriction) is enforced by a PreToolUse guard that runs BEFORE the prompt
 * layer and cannot be overridden by anything here. That is why the global
 * chat's posture — no shell, no edits, no landing — holds even if someone puts
 * `Bash` on this list.
 *
 * NOT to be confused with a mode's `allowedTools`, which is a RESTRICTION
 * ("only these exist") — the name the SDK uses for this concept and the name
 * Dispatch's modes use for the opposite one collided, which is why this field
 * is called something else.
 */

/**
 * Prompt-free out of the box: Dispatch's own tools that only READ, plus the
 * built-in readers.
 *
 * `Read`/`Grep`/`Glob` are here because under `default` mode they prompt only
 * outside the cwd — and outside the cwd is exactly where the global chat, whose
 * cwd is an empty directory, does all of its reading.
 *
 * Every write, shell, PR-moving and config-writing tool is absent. The
 * self-carded tools (`ask_user`, `request_human_review`, …) are absent too, not
 * because they are dangerous but because the broker already never prompts for
 * them — listing them would suggest this list is what makes them quiet.
 */
export const DEFAULT_AUTO_ALLOW_TOOLS: readonly string[] = [
  "Read",
  "Grep",
  "Glob",
  "mcp__dispatch-chat__chat_find",
  "mcp__dispatch-chat__chat_read",
  "mcp__dispatch-chat__chat_state",
  "mcp__dispatch-chat__wait_for_chat",
  "mcp__dispatch-project__project_list",
  "mcp__dispatch-project__project_info",
  "mcp__dispatch-memory__recall",
  "mcp__dispatch-memory__memory_list",
  "mcp__dispatch-memory__memory_search",
  "mcp__dispatch-memory__memory_history",
  "mcp__dispatch-memory__memory_similar",
  "mcp__dispatch-config__config_list",
  "mcp__dispatch-config__config_read",
  "mcp__dispatch-config__mode_list",
  "mcp__dispatch-config__mode_read",
  "mcp__dispatch-mcp__mcp_list",
  "mcp__dispatch-session__wait",
  "mcp__dispatch-session__context_usage",
  "mcp__dispatch-workspace__terminal_output",
  "mcp__dispatch-github__watch_pr",
  "mcp__dispatch-issues__issue_list",
  "mcp__dispatch-issues__issue_read",
  "mcp__dispatch-secrets__secret_list",
];

/**
 * Tools no auto-allow entry may ever answer — not a remembered click, not a
 * hand-typed entry, not a `*`. Each rides the permission channel but is a
 * DECISION the card exists to put in front of a human, not a tool call:
 *
 *   - `AskUserQuestion` is a question: an auto-"allow" submits it with no
 *     answer, and the model carries on as though the human had replied.
 *   - `ExitPlanMode` is the plan review. Allowed automatically, the model
 *     approves its own plan and leaves plan mode unread — the one gate plan
 *     mode exists for. (Review caught this: the plan card's "Always approve"
 *     would have saved it app-wide in one click.)
 *   - `Permissions` is the Codex harness asking to WIDEN its sandbox — extra
 *     write roots, network. One remembered grant would silently approve every
 *     future escalation in every chat, the same "one becomes all" a shell is
 *     kept off this list for.
 */
export const NEVER_AUTO_ALLOW: readonly string[] = ["AskUserQuestion", "ExitPlanMode", "Permissions"];

/**
 * Tools that are only prompt-free OUTSIDE plan mode.
 *
 * Plan mode's whole contract is "look, don't touch". An auto-allow entry for
 * `Edit` is a statement about building, and must not become the thing that
 * lets a planning session write files the moment it asks.
 */
export const PLAN_MODE_WRITE_TOOLS: readonly string[] = [
  "Bash",
  "PowerShell",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "mcp__dispatch-workspace__terminal",
];

/**
 * Does one entry cover this tool?
 *
 * Three spellings, all already familiar from Claude Code's own permission
 * rules: an exact name; a trailing `*` prefix (`mcp__dispatch-chat__*`); and a
 * bare MCP server (`mcp__dispatch-chat`), meaning every tool it serves. The
 * bare-server form is matched on `__` so `mcp__dispatch-chat` cannot also
 * swallow a server called `dispatch-chatter`.
 */
export function autoAllowEntryMatches(entry: string, tool: string): boolean {
  const rule = entry.trim();
  if (!rule) return false;
  if (rule === tool) return true;
  if (rule.endsWith("*")) return tool.startsWith(rule.slice(0, -1));
  if (rule.startsWith("mcp__") && !rule.slice("mcp__".length).includes("__")) {
    return tool.startsWith(`${rule}__`);
  }
  return false;
}

/** The app layer as it applies: the stored list, or the defaults when unset. */
export function appAutoAllowTools(stored: readonly string[] | undefined): readonly string[] {
  return stored ?? DEFAULT_AUTO_ALLOW_TOOLS;
}

export interface AutoAllowLayers {
  /** `AppSettings.autoAllowTools` — `undefined` means the defaults. */
  app?: readonly string[];
  /** The selected mode's `autoAllowTools`, added on top. */
  mode?: readonly string[];
  /** The session is in plan mode: {@link PLAN_MODE_WRITE_TOOLS} keep asking. */
  planning?: boolean;
}

/** May this tool run without a prompt? */
export function isAutoAllowed(tool: string, layers: AutoAllowLayers): boolean {
  if (NEVER_AUTO_ALLOW.includes(tool)) return false;
  if (layers.planning && PLAN_MODE_WRITE_TOOLS.includes(tool)) return false;
  const entries = [...appAutoAllowTools(layers.app), ...(layers.mode ?? [])];
  return entries.some((entry) => autoAllowEntryMatches(entry, tool));
}

/**
 * Tools "Always allow" will not remember from a single card.
 *
 * The card is about ONE command; the list entry would be EVERY command, in
 * every chat, in every project, forever. For a reader that gap is harmless, and
 * for `Edit` it is what `acceptEdits` already means — but for a shell it turns
 * approving `pnpm test` once into approving `rm -rf` everywhere. Typing `Bash`
 * into Settings stays possible; it just has to be done on purpose.
 */
export const SHELL_TOOLS: readonly string[] = [
  "Bash",
  "PowerShell",
  "mcp__dispatch-workspace__terminal",
];

/** Should a permission card for this tool offer "Always allow"? */
export function canRememberAutoAllow(tool: string): boolean {
  return !NEVER_AUTO_ALLOW.includes(tool) && !SHELL_TOOLS.includes(tool);
}

/**
 * The app list after "Always allow" on `tool`, or `null` when nothing changes.
 *
 * Seeds from the DEFAULTS when the stored list is unset — appending to `[]`
 * instead would make the first "Always allow" anyone ever clicked silently
 * revoke every default, which is the opposite of what the button says.
 */
export function withAutoAllowed(
  stored: readonly string[] | undefined,
  tool: string,
): string[] | null {
  if (!canRememberAutoAllow(tool)) return null;
  const current = appAutoAllowTools(stored);
  if (current.some((entry) => autoAllowEntryMatches(entry, tool))) return null;
  return [...current, tool];
}
