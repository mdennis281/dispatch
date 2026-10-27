/**
 * Claude's side of a login account: spawning under one, and carrying a
 * session between two.
 *
 * Lives here rather than in `services/subscriptions.ts` because this directory
 * is on its way out of the host into a provider plugin (#422), and a plugin
 * cannot import the server. `envWithAccount` is deliberately a copy of the
 * host's: five lines are cheaper than an import edge that would have to be cut
 * again at extraction.
 */
import { existsSync } from "node:fs";
import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessAccount } from "@dispatch/shared";

/** Merge an account's env overlay onto the server's env for a spawn. */
export function envWithAccount(
  account: HarnessAccount | undefined,
): Record<string, string | undefined> | undefined {
  return account && Object.keys(account.env).length
    ? { ...process.env, ...account.env }
    : undefined;
}

/**
 * Copy a Claude Code session from one config dir to another so `resume` finds it.
 *
 * Claude keeps a session at `<configDir>/projects/<cwd-slug>/<sessionId>.jsonl`,
 * with subagent transcripts beside it under `<sessionId>/`. The slug is found by
 * SEARCHING rather than recomputed from the cwd: Claude's slugging has changed
 * shape before (long paths get truncated and hashed), and a copy that lands in
 * the wrong slug dir is a resume that silently starts a blank session. Whatever
 * directory the file really is in, the copy goes to the same name.
 *
 * OVERWRITES the target's copy. A chat runs on one account at a time and a
 * resume keeps appending to the same session id, so the SOURCE is always the
 * newest copy — a switch back to an account the chat ran on before must replace
 * that account's stale file, or the resume there silently loses every turn taken
 * since it left.
 */
export async function transferClaudeSession(
  sessionId: string,
  fromDir: string,
  toDir: string,
): Promise<boolean> {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return false;
  const fromProjects = join(fromDir, "projects");
  let slugs: string[];
  try {
    slugs = await readdir(fromProjects);
  } catch {
    return false;
  }
  const file = `${sessionId}.jsonl`;
  const slug = slugs.find((s) => existsSync(join(fromProjects, s, file)));
  if (!slug) return false;
  const target = join(toDir, "projects", slug);
  try {
    await mkdir(target, { recursive: true });
    await cp(join(fromProjects, slug, file), join(target, file), { force: true });
    const sidecar = join(fromProjects, slug, sessionId);
    if (existsSync(sidecar)) {
      await cp(sidecar, join(target, sessionId), { recursive: true, force: true });
    }
    return existsSync(join(target, file));
  } catch {
    return false;
  }
}
