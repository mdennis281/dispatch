/**
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
 * `mcp__manager__terminal({ background: true })` + `terminal_output`, whose shell
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

/** Pass-through: the hook takes no position on this call. */
const ALLOW: HookJSONOutput = {};

/** The two harness shell tools that take `run_in_background`. */
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

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
    "Start long-running processes with `mcp__manager__terminal({ name: \"<own-name>\", " +
    "command: \"…\", background: true })` and read them with " +
    "`mcp__manager__terminal_output({ name: \"<own-name>\" })` — that shell is tracked " +
    "against this chat and torn down with it. For a declared sub-app, prefer " +
    "`mcp__manager__run_subapp`. For a command that DOES finish, just run it in the " +
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
