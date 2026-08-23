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
 * WHY `git grep` and not a directory walk. A walk descends into `node_modules`
 * and into any gitignored sibling checkout, returning thousands of hits from
 * code that is not ours and can never go green. `git grep` applies the repo's
 * own ignore rules for free.
 *
 * WHY `--untracked`. Tracked-only was the first version of this script, and it
 * reported the very commit that introduced it as clean: the new files were
 * still unstaged, so `git grep` could not see them, and nine dead names went in
 * green. `--untracked` adds files that exist but are not committed yet, while
 * still honouring `.gitignore` — so a stale name is caught while it is being
 * written rather than one commit later.
 *
 * The token is assembled at runtime rather than written out, so this file does
 * not trip the check it implements — which is what lets the check have zero
 * exemptions. An allowlist is how a verifier like this rots.
 */
import { spawnSync } from "node:child_process";

const SERVER = ["mcp", "manager"].join("__");
const NEEDLE = `${SERVER}__`;

// Both spellings, because a permission list uses both: `mcp__<server>` means
// "every tool on this server" and is the likeliest entry in a real allowlist,
// while `mcp__<server>__<tool>` names one. Catching only the second is how the
// migration code came to handle a form the CI gate could not see.
//
// The trailing class (or end of line) is what stops a LONGER server name —
// `manager2`, or one with a `-`/`.` — from being reported as ours; both are
// legal in a server name. Mirrors LEGACY_MENTION_RE in
// packages/shared/src/manager-tools.ts. Duplicated on purpose: this runs BEFORE
// the build, so it cannot import from `@dispatch/shared`.
//
// POSIX classes, not `\w`: `git grep -E` is ERE, where `\w` is not a class —
// it reads as a literal `w`, the negated set matches any letter, and the guard
// silently inverts into matching everything it was meant to exclude.
const PATTERN = `${SERVER}(__[[:alnum:]_*]*)?([^[:alnum:]_.-]|$)`;

const res = spawnSync("git", ["grep", "-nE", "--untracked", PATTERN], {
  encoding: "utf8",
});

// git grep exits 1 for "no matches", which is exactly what success looks like.
if (res.status === 1) {
  console.log(`ok — nothing names the retired \`${SERVER}\` server`);
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
