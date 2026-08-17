/**
 * The injected workflow contract — a project's {@link ResolvedWorkflow} rendered
 * as a system-prompt append.
 *
 * WHY this exists rather than leaving it to the repo's CLAUDE.md: a CLAUDE.md is
 * prose competing with everything else in the window, it drifts per-repo, and
 * nothing verifies the agent followed it. Generating the rules from the profile
 * means (a) a repo with no CLAUDE.md still gets a coherent posture, (b) the rules
 * and the permission guard that ENFORCES them are derived from the same object so
 * they can't disagree, and (c) the low rungs get told what NOT to do — an agent
 * that opens a PR on a project whose human just wants files edited is as wrong as
 * one that pushes to a protected trunk.
 *
 * Kept deliberately short. This append rides on every turn of every session.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import {
  classifyWorkflowViolation,
  exemptionCovers,
  type ResolvedWorkflow,
  type WorkflowExemption,
  type WorkflowViolation,
} from "@dispatch/shared";

/* ------------------------------------------------------- git dir inspection */

/** Where a working directory's git metadata lives, and how it's attached. */
export interface GitDirInfo {
  /** Absolute path to the git dir (`…/.git`, or the linked worktree's gitdir). */
  gitDir: string;
  /** True when `.git` was a FILE — i.e. this is a linked worktree, not the checkout. */
  linked: boolean;
}

/**
 * Locate the git dir for `cwd`, walking up until a `.git` is found. A linked
 * worktree has `.git` as a FILE containing `gitdir: <path>` — which is also how
 * we tell a worktree from the primary checkout without shelling out.
 * Returns null when `cwd` isn't inside a repo.
 */
export async function findGitDir(cwd: string): Promise<GitDirInfo | null> {
  let dir = resolve(cwd);
  for (;;) {
    const dotGit = join(dir, ".git");
    try {
      const st = await stat(dotGit);
      if (st.isDirectory()) return { gitDir: dotGit, linked: false };
      if (st.isFile()) {
        const raw = await readFile(dotGit, "utf8");
        const target = /^gitdir:\s*(.+)$/m.exec(raw)?.[1]?.trim();
        if (!target) return null;
        return { gitDir: isAbsolute(target) ? target : resolve(dir, target), linked: true };
      }
    } catch {
      /* not here — keep walking up */
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The branch checked out at `cwd`, or null when detached / not a repo. Reads
 * `HEAD` directly rather than spawning `git` — this runs on every turn, and a
 * subprocess per turn to learn one string isn't worth it.
 */
export async function readCurrentBranch(cwd: string): Promise<string | null> {
  const info = await findGitDir(cwd).catch(() => null);
  if (!info) return null;
  try {
    const head = await readFile(join(info.gitDir, "HEAD"), "utf8");
    return /^ref:\s*refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Branch + worktree-ness for a session cwd, in one pass. Never throws. */
export async function inspectCwd(
  cwd: string | undefined,
): Promise<{ branch: string | null; linked: boolean }> {
  if (!cwd) return { branch: null, linked: false };
  const info = await findGitDir(cwd).catch(() => null);
  if (!info) return { branch: null, linked: false };
  let branch: string | null = null;
  try {
    const head = await readFile(join(info.gitDir, "HEAD"), "utf8");
    branch = /^ref:\s*refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim() ?? null;
  } catch {
    /* detached or unreadable */
  }
  return { branch, linked: info.linked };
}

/** What the directive needs to know about the session it's being built for. */
export interface WorkflowDirectiveContext {
  /** The protected trunk (project `defaultBranch`, typically `main`). */
  defaultBranch: string;
  /** True when this session's cwd is a task worktree rather than the checkout. */
  inWorktree: boolean;
  /** The branch the session's cwd is on, when known. */
  branch?: string | null;
  /** Whether `mcp__manager__watch_pr` is available (GitHub wired up). */
  github: boolean;
  /** Whether `mcp__manager__create_pr` is available (GitHub + a PR workflow). */
  prCreate?: boolean;
  /** Whether the memory tools are available for this session. */
  memory: boolean;
}

/** Fenced heading every profile shares, so the section is easy to spot. */
const HEADING = "# How change ships here";

/**
 * Render the workflow contract for a session. Returns null when there's nothing
 * worth saying (never emits an empty section).
 */
export function buildWorkflowDirective(
  wf: ResolvedWorkflow,
  ctx: WorkflowDirectiveContext,
): string | null {
  const trunk = ctx.defaultBranch || "main";
  const lines: string[] = [HEADING, ""];

  if (wf.profile === "none") {
    lines.push(
      `This project is on the **\`none\`** workflow profile: it's still forming, and ` +
        `the ceremony would cost more than it's worth. Work directly in the checkout.`,
      "",
      `- **Don't** create branches, worktrees, or pull requests, and don't set up CI — ` +
        `none of that is wanted here yet.`,
      `- **Don't** commit on your own initiative. Leave your work in the working tree; ` +
        `the human batches commits. If you're asked to commit, commit.`,
      `- Do keep the tree coherent: if you leave something half-migrated, say so plainly ` +
        `at the end of the turn.`,
    );
  } else if (wf.profile === "commit") {
    lines.push(
      `This project is on the **\`commit\`** workflow profile: work happens in the ` +
        `checkout on \`${trunk}\`, but it has to LAND. Uncommitted work is lost work.`,
      "",
      `- Finish a task by committing it — small, coherent, conventional commits ` +
        `(\`feat(scope): …\`, \`fix(scope): …\`), not one end-of-session dump.`,
      `- Don't leave the tree dirty when you report a task done. If something is ` +
        `deliberately left uncommitted, say which files and why.`,
      `- **Don't** open pull requests or create branches — this project doesn't use them.`,
    );
  } else {
    // review — the full worktree → PR → review-loop → merge contract.
    const worktreeCmd = wf.worktreeCmd ? ` (\`${wf.worktreeCmd} <type>/<slug>\`)` : "";
    // `create_pr` when we have it, because it is the only path that requests the
    // configured reviewers, links the PR to this chat and arms the watcher — the
    // three things a hand-rolled `gh pr create` silently skipped.
    const shipCmd = ctx.prCreate
      ? "`mcp__manager__create_pr`"
      : wf.shipCmd
        ? `\`${wf.shipCmd}\``
        : "`gh pr create`";
    lines.push(
      `This project is on the **\`review\`** workflow profile — a multi-agent repo where ` +
        `several agents work in parallel. **All work is isolated in a git worktree and ` +
        `lands through a reviewed PR.** This is not negotiable; the loop is the point.`,
      "",
      `**The loop**`,
      "",
      `1. **Isolate** — one task, one worktree, one branch off fresh \`origin/${trunk}\`` +
        `${worktreeCmd}. Never work in another agent's worktree or on their branch.`,
      `2. **Work** — small, coherent, conventional commits (\`feat(scope): …\`). Touch only ` +
        `what your task needs; an unrelated regression you didn't cause is not yours to ` +
        `fold in.`,
      `3. **Ship** — ${shipCmd} pushes the branch, opens the PR, and requests review` +
        `${
          ctx.prCreate
            ? " — never `gh pr create` by hand, which opens a PR with nobody asked to " +
              "review it and nothing watching it"
            : ""
        }.`,
    );
    if (ctx.github) {
      lines.push(
        `4. **Review** — then call \`mcp__manager__watch_pr\` **in a loop**: it returns the ` +
          `instant a check fails or a review comment lands. Fix what it reports, call ` +
          `\`mcp__manager__resolve_thread\` on each thread you actually fixed (a reply alone ` +
          `leaves it outstanding), push, then \`mcp__manager__request_review\` to re-queue ` +
          `the reviewer — submitting a review clears their request and your new commits do ` +
          `NOT bring them back. Call \`watch_pr\` again until it returns \`done:true\`. Never ` +
          `hand-roll a \`gh pr checks\` polling loop.`,
      );
    } else {
      lines.push(`4. **Review** — get CI green and work the review comments until it's clean.`);
    }
    const autoMerge = wf.autoMerge === "on-green" && ctx.github;
    if (autoMerge) {
      lines.push(
        `5. **Land it** — once CI is green and no review thread is open, call ` +
          `\`mcp__manager__approve_pr\` and the change is in. That is the DEFAULT here: this ` +
          `project has auto-merge on, so finishing a task means the work is merged, not that ` +
          `a PR link is waiting for someone to click.`,
        "",
        `   **Unless the user said otherwise.** If they asked you to leave the PR open, to ` +
          `let them look first, to "just open a PR", or not to merge — don't. Say the PR is ` +
          `ready and stop. Same if the PR carries a \`hold\` label: someone parked it ` +
          `deliberately, so leave it (and never remove the label to get around that).`,
      );
    } else {
      lines.push(
        `5. **Done** — the merge lands the PR once review is green. You don't click merge and ` +
          `you don't hand back a link to click. When the user says "ship it", ship it and move on.`,
      );
    }
    lines.push(
      "",
      `**Hard rules**`,
      "",
      `- Never commit or push to \`${trunk}\`. It is the always-green trunk.`,
      autoMerge
        ? `- Never merge by hand — no \`gh pr merge\`, no local merge into \`${trunk}\`. ` +
          `\`approve_pr\` is the only way you land a PR; it re-checks everything first and ` +
          `syncs the trunk afterwards.`
        : `- Never merge your own PR by hand, and never \`stash\`/\`reset\`/\`rebase\`/force-push ` +
          `a branch or worktree you didn't create.`,
      ...(autoMerge
        ? [
            `- Never \`stash\`/\`reset\`/\`rebase\`/force-push a branch or worktree you didn't create.`,
            `- Only land YOUR OWN PR. Another agent's PR is not yours to merge.`,
          ]
        : []),
      `- Resolve only your own PR's threads.`,
    );
    // State where the session actually is — a review-profile session sitting in
    // the primary checkout is the exact condition that produces trunk commits.
    if (!ctx.inWorktree) {
      lines.push(
        "",
        `⚠️ **You are running in the primary checkout, not a task worktree.** Before you ` +
          `change any code, get a worktree for this task${
            worktreeCmd ? ` — ${worktreeCmd.trim()}` : ""
          } (or ask the user to create one for this chat). Editing here puts uncommittable ` +
          `work on \`${trunk}\`.`,
      );
    } else if (ctx.branch) {
      lines.push("", `You are in a task worktree on \`${ctx.branch}\`. Work here.`);
    }
  }

  if (ctx.memory) {
    // NB: deliberately not "Project memory" — that's the heading MemoryService's
    // own injection uses, and two identically-titled sections in one prompt read
    // as a duplicate. This is the CONTRACT (how to write memory); that one is the
    // CONTENT (what's already recorded).
    lines.push("", "**Recording what you learn**", "");
    lines.push(
      `- Record durable facts with \`mcp__manager__remember\` as you learn them — not as an ` +
        `end-of-task chore. Anything a future session would have to re-derive belongs there.`,
    );
    // The correction for the failure this profile work was built to fix: memory
    // lives in the PRIMARY checkout, so hand-editing it from a worktree forks it.
    lines.push(
      `- Memory is project-scoped and lives in the primary checkout's ` +
        `\`.dispatch/memory/\`. Always go through the \`remember\`/\`recall\`/\`forget\` ` +
        `tools — **never** hand-edit those files${
          ctx.inWorktree ? " (your worktree's copy is not the live one)" : ""
        }.`,
    );
    if (wf.memory === "commit") {
      lines.push(`- Dispatch commits memory changes for you; don't add them to your PR.`);
    }
  }

  return lines.length > 2 ? lines.join("\n") : null;
}

/* -------------------------------------------------------------------- guard */

/** Live guard context for one session, re-read at each tool call. */
export interface WorkflowGuardContext {
  workflow: ResolvedWorkflow;
  /** The protected trunk (project `defaultBranch`). */
  trunk: string;
  /** True when the session cwd is a linked worktree. */
  inWorktree: boolean;
}

export interface WorkflowGuardDeps {
  /** The session's current guard context, or null to skip guarding entirely. */
  context: () => WorkflowGuardContext | null;
  /** Called for every detected violation, including ones that are let through. */
  onViolation?: (violation: WorkflowViolation, blocked: boolean) => void;
  /**
   * This chat's live, human-approved exemptions (see
   * {@link WorkflowExemptionSchema}). Read fresh per call, not captured: a grant
   * can land mid-turn, which is the whole point — the agent asks the instant it
   * is blocked and retries in the same turn.
   */
  exemptions?: () => readonly WorkflowExemption[];
  /**
   * A grant just let a command through. The broker does the side effects (burn a
   * one-shot, publish the notice, push the new list to the UI) so this hook stays
   * a pure decision; matching lives here so it is testable without a broker.
   */
  onExempted?: (exemption: WorkflowExemption, violation: WorkflowViolation, command: string) => void;
}

/** Pass-through result: the hook takes no position on this call. */
const ALLOW: HookJSONOutput = {};

/**
 * The trunk guard, as a `PreToolUse` hook.
 *
 * Deliberately NOT on `canUseTool`: that channel is skipped entirely under
 * `bypassPermissions`, which is exactly the posture a long autonomous run uses —
 * i.e. the guard would be absent precisely when it matters most. A PreToolUse
 * hook fires in every permission mode and its deny takes precedence.
 *
 * It reads the branch fresh from the hook's own `cwd` rather than trusting what
 * the session knew at turn start, because an agent that ran `git checkout` mid-turn
 * has moved since.
 */
export function createWorkflowGuardHook(deps: WorkflowGuardDeps): HookCallback {
  return async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return ALLOW;
    if (input.tool_name !== "Bash") return ALLOW;

    const ctx = deps.context();
    if (!ctx || ctx.workflow.guard === "off") return ALLOW;

    const command = (input.tool_input as { command?: unknown } | null)?.command;
    if (typeof command !== "string" || !command.trim()) return ALLOW;

    const { branch } = await inspectCwd(input.cwd).catch(() => ({ branch: null }));
    const violation = classifyWorkflowViolation(command, {
      defaultBranch: ctx.trunk,
      currentBranch: branch,
      inWorktree: ctx.inWorktree,
      // A session that CAN land its PR still can't do it with `gh pr merge` —
      // this only redirects the refusal to `approve_pr` instead of "wait".
      autoMerge: ctx.workflow.autoMerge === "on-green",
      // …and the symmetric case: where change ships through a PR, OPENING one
      // goes through `create_pr`. A raw `gh pr create` opens a PR with no
      // reviewer requested, no link to the chat and no watcher — the failure
      // this guard was extended to catch.
      requirePr: ctx.workflow.requirePr,
    });
    if (!violation) return ALLOW;

    const blocked = ctx.workflow.guard === "deny";

    // A human-approved exemption for THIS chat stands the refusal down. Only
    // consulted on the `deny` rung: under `warn` nothing was going to be blocked
    // anyway, so consulting it there would burn a one-shot grant on a command
    // that never needed it.
    if (blocked) {
      const exemption = deps.exemptions?.().find((e) => exemptionCovers(e, violation.kind));
      if (exemption) {
        // Deliberately NOT also reported as a violation: `onViolation` publishes
        // "Blocked: …", and an exempted command was not blocked. The broker's
        // own notice says what the grant just bought instead.
        deps.onExempted?.(exemption, violation, command);
        return ALLOW;
      }
    }

    deps.onViolation?.(violation, blocked);
    if (!blocked) return ALLOW;

    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `${violation.reason} (blocked by the \`${ctx.workflow.profile}\` workflow profile)` +
          // Discoverability where it actually matters. The 2026-08-17 incident's
          // agent was stuck between a broken sanctioned tool and this refusal
          // with no third option it knew about — and this sentence is the only
          // text it is guaranteed to read at that moment. Naming `violation.kind`
          // means it can ask for exactly the guard it just tripped rather than
          // guessing, or reaching for `all`.
          (deps.exemptions
            ? `\n\nIf the sanctioned path is genuinely BROKEN — not merely inconvenient — you ` +
              `can ask the human to lift this one guard for THIS CHAT: ` +
              `mcp__manager__request_exemption({ guard: "${violation.kind}", command: "…", ` +
              `reason: "…" }). They decide, not you, and a denial is final.`
            : ""),
      },
    };
  };
}
