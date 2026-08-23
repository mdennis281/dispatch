/**
 * The shell guards: background processes, and worktree creation.
 *
 * Both refuse a command that would put something long-lived OUTSIDE Dispatch's
 * records, and both name the tracked tool that does the same job. See
 * {@link backgroundShellRefusal} and {@link worktreeCommandRefusal}.
 *
 * ---
 *
 * The background-shell guard.
 *
 * `Bash`/`PowerShell` with `run_in_background: true` is the single biggest
 * source of orphaned processes on this machine. The harness spawns that shell as
 * a grandchild of the `claude` subprocess, so Dispatch holds NO record of it: it
 * is absent from `runners.json`, absent from the Terminals tab, and the Ports &
 * processes panel can only see it if it happens to land on a port the project
 * declared. When the session goes away the process does not — it sits on its
 * port until someone hunts it down by hand.
 *
 * The measured case: one chat on `the-salesman` started Vite and an npc-sim on
 * 47820/47823, 47830/47833, 47840/47843 across four worktrees this way, then
 * hand-rolled its own reaper out of `Get-NetTCPConnection | Stop-Process` —
 * which kills the listening leaf and leaves the rest of the tree.
 *
 * So the guard refuses that flag and names the tracked path instead:
 * `mcp__dispatch-workspace__terminal({ background: true })` + `terminal_output`, whose shell
 * has a pid Dispatch owns, is attributable to the chat, and is tree-killed with
 * it. A foreground command with a `timeout` is the other honest answer, and the
 * message says so.
 *
 * PreToolUse rather than `canUseTool`, for the same reason as the trunk guard:
 * `canUseTool` is skipped entirely under `bypassPermissions`, which is exactly
 * the posture a long autonomous run uses — i.e. the guard would be missing
 * precisely when it matters most.
 */
import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { looksLikeWorktreeCreate } from "./worktree-detector.js";

/** Pass-through: the hook takes no position on this call. */
const ALLOW: HookJSONOutput = {};

/** The two harness shell tools that take `run_in_background`. */
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/**
 * Every tool that can put a command on a shell. `mcp__dispatch-workspace__terminal` is
 * included deliberately: it is Dispatch's OWN tool, and leaving it out would
 * make the worktree guard trivially bypassable by the one path every agent is
 * already told to prefer.
 */
const COMMAND_TOOLS = new Set(["Bash", "PowerShell", "mcp__dispatch-workspace__terminal"]);

export interface BackgroundShellGuardDeps {
  /** False disables the guard (no TerminalService = no path to redirect to). */
  enabled: () => boolean;
  /** Called on every refusal, for the chat's notice stream. */
  onBlocked?: (command: string) => void;
}

/** Human-readable refusal, shared with the tests so the wording stays checked. */
export function backgroundShellRefusal(): string {
  return (
    "`run_in_background` is not available in Dispatch: the harness spawns that " +
    "shell outside the server's process tree, so it is invisible to the Ports & " +
    "processes panel and is left running when this chat ends. " +
    "Start long-running processes with `mcp__dispatch-workspace__terminal({ name: \"<own-name>\", " +
    "command: \"…\", background: true })` and read them with " +
    "`mcp__dispatch-workspace__terminal_output({ name: \"<own-name>\" })` — that shell is tracked " +
    "against this chat and torn down with it. For a declared sub-app, prefer " +
    "`mcp__dispatch-workspace__run_subapp`. For a command that DOES finish, just run it in the " +
    "foreground with a `timeout`."
  );
}

/**
 * Deny `run_in_background` on the harness shell tools.
 *
 * Deliberately unconditional on the command's content: "is this a server?" is
 * not decidable from a command line (`npm test -- --watch` is one, `npm run
 * build` is not), and the tracked path is strictly better for both.
 */
export function createBackgroundShellGuardHook(
  deps: BackgroundShellGuardDeps,
): HookCallback {
  return async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return ALLOW;
    if (!SHELL_TOOLS.has(input.tool_name)) return ALLOW;
    if (!deps.enabled()) return ALLOW;

    const toolInput = input.tool_input as
      | { run_in_background?: unknown; command?: unknown }
      | null;
    if (toolInput?.run_in_background !== true) return ALLOW;

    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    deps.onBlocked?.(command);

    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: backgroundShellRefusal(),
      },
    };
  };
}

/* ------------------------------------------------------------- worktrees */

/**
 * The worktree guard.
 *
 * A worktree cut by a raw `git worktree add` announces itself to nobody. The
 * WorktreeDetector then has to work out whose it was after the fact, by parsing
 * shell commands out of transcripts and racing a 4s poll — and when the evidence
 * was thin it guessed, or gave up and left the tree attached to nothing. That is
 * the mechanism behind every worktree in the list that no chat will admit to.
 *
 * `mcp__dispatch-workspace__worktree({ action: "create", branch })` runs the same git
 * command and writes the owning chat down in the same breath, so there is
 * nothing left to infer. So the raw command is refused and the message names the
 * tool — the same trade the trunk guard makes with `gh pr create`.
 *
 * Only CREATION is refused: `git worktree list` / `remove` / `prune` are how an
 * agent inspects and tidies, and blocking those would buy nothing.
 */
export function worktreeCommandRefusal(): string {
  return (
    "Creating a worktree from a shell is not available in Dispatch: a tree cut " +
    "that way carries no record of which chat owns it, so it shows up in the " +
    "Workspace view unattributed and the manager has to guess at it afterwards. " +
    "Use `mcp__dispatch-workspace__worktree({ action: \"create\", branch: \"<branch>\" })` — " +
    "it runs the same git command, records this chat as the owner, and returns " +
    "the path. `worktree({ action: \"list\" })` and `({ action: \"remove\", path })` " +
    "are there too. Inspecting worktrees from a shell (`git worktree list`, " +
    "`prune`) is unaffected."
  );
}

export interface WorktreeGuardDeps {
  /** False disables the guard (no worktree binding = nowhere to redirect to). */
  enabled: () => boolean;
  /** Called on every refusal, for the chat's notice stream. */
  onBlocked?: (command: string) => void;
}

/** Deny worktree-CREATING commands on any tool that can run a shell command. */
export function createWorktreeGuardHook(deps: WorktreeGuardDeps): HookCallback {
  return async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return ALLOW;
    if (!COMMAND_TOOLS.has(input.tool_name)) return ALLOW;
    if (!deps.enabled()) return ALLOW;

    const command = (input.tool_input as { command?: unknown } | null)?.command;
    if (typeof command !== "string" || !looksLikeWorktreeCreate(command)) return ALLOW;

    deps.onBlocked?.(command);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: worktreeCommandRefusal(),
      },
    };
  };
}
