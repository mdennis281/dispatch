/**
 * Retiring managed shells that sit at an empty prompt.
 *
 * WHY. The idle sweep (`SessionBroker.sweepIdleSessions`, 30 min by default)
 * retires a chat's SESSION and deliberately leaves its shells, because a chat
 * parked so someone can test against the dev server it started has to still
 * have that dev server. But it left EVERY shell, and most are not dev servers:
 * an agent opens a `powershell.exe` to run `git status` and never touches it
 * again. A live install was found carrying ~170 of them, the oldest 21 hours,
 * each a full PowerShell — and every process-table read had to walk them all.
 *
 * THE LINE. A shell is retired only when BOTH hold:
 *   • nothing has happened in it for the idle window (no command, no output,
 *     not holding a `background` command — see `TerminalService.idleShells`)
 *   • nothing is running UNDER it in the process table. A dev server started
 *     with `Start-Process`, `&`, or `nohup` makes the shell look idle to the
 *     terminal service while it is anything but.
 *
 * `conhost.exe` does not count as "running under it": Windows attaches one to
 * every console process, so every shell has one, idle or not.
 *
 * Retiring is `TerminalService.kill`, not purge: the transcript is archived and
 * stays readable, and the agent's next command on that name opens a fresh shell
 * with a notice that the old one was closed.
 */
import type { ProcessSnapshot } from "./process-tracker.js";

export interface IdleShellSource {
  idleShells(cutoff: number): { terminalId: string; chatId: string; name: string; pid: number }[];
  kill(terminalId: string): boolean;
}

/** Windows' console host — present under every console process, so never "work". */
const CONSOLE_HOSTS = new Set(["conhost.exe", "openconsole.exe"]);

/**
 * Kill every idle, empty shell. Returns the terminal ids it retired.
 *
 * @param idleMinutes The same window the session sweep uses; `0` disables both.
 */
export function reapIdleShells(
  snapshot: ProcessSnapshot,
  terminals: IdleShellSource,
  idleMinutes: number,
  now: number,
): string[] {
  if (!(idleMinutes > 0)) return [];
  const cutoff = now - idleMinutes * 60_000;
  const retired: string[] = [];
  for (const shell of terminals.idleShells(cutoff)) {
    // A shell the table doesn't list cannot be judged — leave it for a sweep
    // that can see it rather than kill on no evidence.
    if (!snapshot.byPid.has(shell.pid)) continue;
    const working = (snapshot.children.get(shell.pid) ?? []).some((child) => {
      const name = snapshot.byPid.get(child)?.name?.toLowerCase();
      return !name || !CONSOLE_HOSTS.has(name);
    });
    if (working) continue;
    if (terminals.kill(shell.terminalId)) retired.push(shell.terminalId);
  }
  return retired;
}
