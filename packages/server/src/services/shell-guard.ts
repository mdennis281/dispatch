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
 * A veto before the call rather than `canUseTool`, for the same reason as the
 * trunk guard: `canUseTool` is skipped entirely under `bypassPermissions`,
 * which is exactly the posture a long autonomous run uses — i.e. the guard
 * would be missing precisely when it matters most.
 *
 * Every guard here is a plain {@link HarnessToolGuard}: no runtime's hook types,
 * a refusal string or null. The broker composes them into the one guard every
 * provider is handed, so a Codex or goose chat gets the same refusals a Claude
 * chat does — before #424 they got only the mode policy and the workflow guard.
 */
import type { HarnessToolGuard } from "@dispatch/shared";
import { looksLikeWorktreeCreate } from "./worktree-detector.js";
import { deniedToolRefusal, isToolAllowed } from "@dispatch/shared";

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
export function createBackgroundShellGuard(deps: BackgroundShellGuardDeps): HarnessToolGuard {
  return async (toolName, input) => {
    if (!SHELL_TOOLS.has(toolName)) return null;
    if (!deps.enabled()) return null;
    if (input.run_in_background !== true) return null;

    deps.onBlocked?.(typeof input.command === "string" ? input.command : "");
    return backgroundShellRefusal();
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
export function createWorktreeGuard(deps: WorktreeGuardDeps): HarnessToolGuard {
  return async (toolName, input) => {
    if (!COMMAND_TOOLS.has(toolName)) return null;
    if (!deps.enabled()) return null;

    const command = input.command;
    if (typeof command !== "string" || !looksLikeWorktreeCreate(command)) return null;

    deps.onBlocked?.(command);
    return worktreeCommandRefusal();
  };
}

/* ---------------------------------------------------------------- issues */

/**
 * The issue-filing guard.
 *
 * On a project whose issue watcher is on, a new issue is not inert: the next
 * poll admits it and starts a chat for it. A chat filing issues for work it (or
 * its own children) is about to do does not know that, and `gh issue create`
 * gives it no way to find out — the plugin-layer PO chat filed #373–#379 and
 * two of them were claimed into an unmanaged third chat. `issue_create` labels
 * the issue `dispatch:manual` at creation, so the raw command is refused there
 * and only there; on a project with no watcher it changes nothing and is let be.
 */
export function issueCreateRefusal(): string {
  return (
    "This project's issue watcher is on: every new issue it admits gets its own " +
    "auto-started chat, so an issue filed with `gh issue create` will be picked up " +
    "by a chat you do not control. Use `mcp__dispatch-issues__issue_create` — it " +
    "labels the issue `dispatch:manual` as it is created, which the watcher never " +
    "takes. Pass `autoHandle: true` if you DO want the watcher to work it."
  );
}

/** `gh issue create` / `gh issue new`, global flags (`-R owner/repo`) and `.exe` allowed. */
export function looksLikeGhIssueCreate(command: string): boolean {
  return GH_ISSUE_CREATE.test(command);
}

const GH_ISSUE_CREATE =
  /(?:^|[\s;&|(`'"])gh(?:\.exe)?\s+(?:-{1,2}[\w-]+(?:[=\s]+[^\s-][^\s]*)?\s+)*issue\s+(?:create|new)\b/i;

/**
 * The `owner/repo` a `gh issue create` names with `-R`/`--repo`, lowercased, or
 * null when it names none (gh then files into the cwd's repo). `HOST/OWNER/REPO`
 * and URLs reduce to their last two segments. Only the gh invocation itself is
 * searched, so a `-R` belonging to a later command in a chain is not misread.
 */
export function ghIssueCreateRepo(command: string): string | null {
  const m = GH_ISSUE_CREATE.exec(command);
  if (!m) return null;
  const invocation = command.slice(m.index).split(/[;&|\n]/)[0] ?? "";
  const repo = /(?:^|\s)(?:-R|--repo)(?:=|\s+)["']?([^\s"']+)/.exec(invocation)?.[1];
  if (!repo) return null;
  const parts = repo.replace(/\.git$/i, "").split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/").toLowerCase() : null;
}

export interface IssueCreateGuardDeps {
  /**
   * Would the watcher take an issue filed in `repo` (null = no `-R`, so the
   * project's own)? Read per call — the watcher can be switched on mid-chat. A
   * `-R` aimed elsewhere (an upstream bug report) must get through: the watcher
   * never sees it, and `issue_create` could only file it in the wrong repo.
   */
  applies: (repo: string | null) => boolean | Promise<boolean>;
  onBlocked?: (command: string) => void;
}

export function createIssueCreateGuard(deps: IssueCreateGuardDeps): HarnessToolGuard {
  return async (toolName, input) => {
    if (!COMMAND_TOOLS.has(toolName)) return null;
    const command = input.command;
    if (typeof command !== "string" || !looksLikeGhIssueCreate(command)) return null;
    if (!(await deps.applies(ghIssueCreateRepo(command)))) return null;

    deps.onBlocked?.(command);
    return issueCreateRefusal();
  };
}

/* ------------------------------------------------------- the mode tool policy */

/**
 * Enforce the selected MODE's tool policy as a veto before the call.
 *
 * Handing the policy to the runtime as `allowedTools`/`disallowedTools` is not
 * enough to rest a posture on. The SDK calls it advisory, it does not filter
 * MCP tools out of the catalogue (a global chat reported still seeing
 * `request_review` with that name on the list), and `canUseTool` — the other
 * gate — is skipped entirely under `bypassPermissions`. A pre-tool veto is
 * not: Claude's PreToolUse fires for subagent calls too and runs whatever the
 * permission mode.
 *
 * Unconditional, unlike the workflow guard: there is no `off` setting, because
 * the mode that uses it is the one a chat with no project runs under. A runtime
 * that ignores the allowlist must not thereby be unrestricted.
 */
export interface ModePolicyGuardDeps {
  /** The policy in force RIGHT NOW — read per call, so a live `setMode` lands. */
  policy: () => { allowedTools?: string[]; disallowedTools?: string[] };
  /** Mode name and id, for the refusal text. */
  mode: () => { name: string; id: string };
  onBlocked?: (tool: string) => void;
}

export function createModePolicyGuard(deps: ModePolicyGuardDeps): HarnessToolGuard {
  return async (toolName) => {
    if (isToolAllowed(toolName, deps.policy())) return null;
    const { name, id } = deps.mode();
    deps.onBlocked?.(toolName);
    return deniedToolRefusal(toolName, name, id);
  };
}
