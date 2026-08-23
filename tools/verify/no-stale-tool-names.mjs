#!/usr/bin/env node
/**
 * Fail the build if anything still names a tool on the retired `manager` MCP
 * server.
 *
 * WHY a verifier and not a one-time sweep. The dead names live in more places
 * than code: bundled skills, the workflow rules injected into every chat, the
 * `.dispatch/` project instructions, RUNNING.md, and project MEMORY — all of
 * which are handed to agents as trusted context. A stale one there does not
 * break a build or throw at runtime; it quietly teaches a dead tool name to
 * every new session, forever. Only a check that runs on every commit keeps
 * that from creeping back.
 *
 * WHY `git grep` and not a directory walk. `.worktrees/` holds a dozen
 * gitignored sibling checkouts of this same repo. A naive walk returns ~15k
 * hits from other agents' branches and can never go green. `git grep` sees
 * tracked files in THIS tree and nothing else.
 *
 * The token is assembled at runtime rather than written out, so this file does
 * not trip the check it implements — which is what lets the check have zero
 * exemptions. An allowlist is how a verifier like this rots.
 */
import { spawnSync } from "node:child_process";

const NEEDLE = ["mcp", "manager", ""].join("__");

const res = spawnSync("git", ["grep", "-n", "--fixed-strings", NEEDLE], {
  encoding: "utf8",
});

// git grep exits 1 for "no matches", which is exactly what success looks like.
if (res.status === 1) {
  console.log(`ok — nothing names the retired \`${NEEDLE}\` server`);
  process.exit(0);
}
if (res.status !== 0) {
  console.error(`git grep failed (${res.status}): ${res.stderr || "(no output)"}`);
  process.exit(2);
}

const hits = res.stdout.split("\n").filter(Boolean);
console.error(
  `${hits.length} reference(s) to the retired \`${NEEDLE}\` server remain.\n` +
    `Dispatch's tools live on the \`dispatch-<category>\` servers now; see\n` +
    `packages/shared/src/manager-tools.ts for the registry and the migration.\n`,
);
for (const hit of hits) console.error("  " + hit);
process.exit(1);
